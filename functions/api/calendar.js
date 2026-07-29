import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const from = url.searchParams.get("from") || new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
  const to = url.searchParams.get("to") || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));

  const rows = await db
    .prepare(
      `SELECT id, title, description, location, starts_at, ends_at, all_day, recurrence, external_id, external_source, created_at, updated_at
       FROM calendar_events WHERE user_id = ? AND starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC LIMIT ?`,
    )
    .bind(user.id, from, to, limit)
    .all();

  return json({ events: rows.results || [], range: { from, to } });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || "").trim();
  const startsAt = body.starts_at || body.startsAt;
  if (!title || !startsAt) return json({ error: "title and starts_at are required" }, 400);

  const id = uid("evt");
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, recurrence, external_id, external_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      user.id,
      title.slice(0, 200),
      body.description || null,
      body.location || null,
      String(startsAt),
      body.ends_at || body.endsAt || null,
      body.all_day || body.allDay ? 1 : 0,
      body.recurrence || null,
      null,
      null,
      ts,
      ts,
    )
    .run();

  await writeAudit(db, { userId: user.id, action: "calendar_event.create", resourceType: "calendar_event", resourceId: id });

  const event = await db.prepare("SELECT * FROM calendar_events WHERE id = ?").bind(id).first();
  return json({ ok: true, event }, 201);
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

  const existing = await db.prepare("SELECT * FROM calendar_events WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Event not found" }, 404);

  const next = {
    title: body.title !== undefined ? String(body.title).slice(0, 200) : existing.title,
    description: body.description !== undefined ? body.description : existing.description,
    location: body.location !== undefined ? body.location : existing.location,
    starts_at: body.starts_at || body.startsAt || existing.starts_at,
    ends_at: body.ends_at !== undefined ? body.ends_at : body.endsAt !== undefined ? body.endsAt : existing.ends_at,
    all_day: body.all_day !== undefined ? (body.all_day ? 1 : 0) : body.allDay !== undefined ? (body.allDay ? 1 : 0) : existing.all_day,
    recurrence: body.recurrence !== undefined ? body.recurrence : existing.recurrence,
  };

  await db
    .prepare(
      `UPDATE calendar_events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, recurrence = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(next.title, next.description, next.location, next.starts_at, next.ends_at, next.all_day, next.recurrence, nowIso(), id, user.id)
    .run();

  await writeAudit(db, { userId: user.id, action: "calendar_event.update", resourceType: "calendar_event", resourceId: id });

  const event = await db.prepare("SELECT * FROM calendar_events WHERE id = ?").bind(id).first();
  return json({ ok: true, event });
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

  const existing = await db.prepare("SELECT id FROM calendar_events WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Event not found" }, 404);

  await db.prepare("DELETE FROM calendar_events WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, { userId: user.id, action: "calendar_event.delete", resourceType: "calendar_event", resourceId: id });

  return json({ ok: true });
}
