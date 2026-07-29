import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";

async function sendResend({ apiKey, from, to, subject, html }) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Find reminders due now-or-earlier that haven't been sent, create an
 * in-app notification for each, and email them when Resend is configured.
 * Best-effort: never throws, so it can be called opportunistically from
 * GET/POST handlers without risking the primary request.
 */
export async function dispatchDueReminders(db, env, user) {
  const dispatched = [];
  try {
    const now = nowIso();
    const due = await db
      .prepare(
        "SELECT id, title, body, due_at, channel, notify_email FROM reminders WHERE user_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT 25",
      )
      .bind(user.id, now)
      .all();
    const rows = due.results || [];
    if (!rows.length) return dispatched;

    const resendKey = env.RESEND_API_KEY;
    const emailFrom = env.EMAIL_FROM;

    for (const reminder of rows) {
      const notificationId = uid("notif");
      await db
        .prepare(
          "INSERT INTO notifications (id, user_id, kind, title, body, href, read_at, created_at) VALUES (?, ?, 'reminder', ?, ?, ?, NULL, ?)",
        )
        .bind(notificationId, user.id, reminder.title, reminder.body || null, "/dashboard/notifications", now)
        .run();

      let emailed = false;
      if (resendKey && emailFrom && reminder.notify_email) {
        const result = await sendResend({
          apiKey: resendKey,
          from: emailFrom,
          to: reminder.notify_email,
          subject: `Reminder: ${reminder.title}`,
          html: `<p>${reminder.title}</p>${reminder.body ? `<p>${reminder.body}</p>` : ""}<p>Due: ${reminder.due_at}</p>`,
        });
        emailed = result.ok;
      }

      await db
        .prepare("UPDATE reminders SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, reminder.id)
        .run();

      await writeAudit(db, {
        userId: user.id,
        action: "reminder.dispatch",
        resourceType: "reminder",
        resourceId: reminder.id,
        meta: { emailed, notificationId },
      });

      dispatched.push({ id: reminder.id, title: reminder.title, emailed });
    }
  } catch {
    // best-effort; primary request should not fail because of dispatch issues
  }
  return dispatched;
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const dispatched = await dispatchDueReminders(db, context.env, user);

  const url = new URL(context.request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));

  let query = "SELECT id, title, body, due_at, status, channel, notify_email, calendar_event_id, sent_at, created_at, updated_at FROM reminders WHERE user_id = ?";
  const binds = [user.id];
  if (status) {
    query += " AND status = ?";
    binds.push(status);
  }
  query += " ORDER BY due_at ASC LIMIT ?";
  binds.push(limit);

  const rows = await db.prepare(query).bind(...binds).all();
  return json({ reminders: rows.results || [], dispatched });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || "").trim();
  const dueAt = body.due_at || body.dueAt;
  if (!title || !dueAt) return json({ error: "title and due_at are required" }, 400);
  const channel = body.channel === "email" ? "email" : "app";

  const id = uid("rem");
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO reminders (id, user_id, title, body, due_at, status, channel, notify_email, calendar_event_id, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id,
      user.id,
      title.slice(0, 200),
      body.body || null,
      String(dueAt),
      channel,
      channel === "email" ? body.notify_email || user.email : null,
      body.calendar_event_id || body.calendarEventId || null,
      ts,
      ts,
    )
    .run();

  await writeAudit(db, { userId: user.id, action: "reminder.create", resourceType: "reminder", resourceId: id });

  const dispatched = await dispatchDueReminders(db, context.env, user);

  const reminder = await db.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first();
  return json({ ok: true, reminder, dispatched }, 201);
}

export async function onRequestPatch(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const id = String(body.id || "");
  if (!id) return json({ error: "id is required" }, 400);

  const existing = await db.prepare("SELECT * FROM reminders WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Reminder not found" }, 404);

  const status = body.complete ? "completed" : body.status || existing.status;
  const ts = nowIso();
  await db
    .prepare("UPDATE reminders SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(status, ts, id, user.id)
    .run();

  await writeAudit(db, { userId: user.id, action: "reminder.update", resourceType: "reminder", resourceId: id, meta: { status } });

  const reminder = await db.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first();
  return json({ ok: true, reminder });
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id query parameter required" }, 400);

  const existing = await db.prepare("SELECT id FROM reminders WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Reminder not found" }, 404);

  await db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, { userId: user.id, action: "reminder.delete", resourceType: "reminder", resourceId: id });

  return json({ ok: true });
}
