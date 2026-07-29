import { ensureSchema, getUserFromRequest, json, nowIso, readJson, writeAudit } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));

  let query = "SELECT id, kind, title, body, href, read_at, created_at FROM notifications WHERE user_id = ?";
  const binds = [user.id];
  if (unreadOnly) query += " AND read_at IS NULL";
  query += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);

  const rows = await db.prepare(query).bind(...binds).all();
  const unread = await db
    .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
    .bind(user.id)
    .first();

  return json({ notifications: rows.results || [], unreadCount: unread?.n ?? 0 });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const action = String(body.action || "");
  const ts = nowIso();

  if (action === "read") {
    const id = String(body.id || "");
    if (!id) return json({ error: "id is required for action=read" }, 400);
    const existing = await db.prepare("SELECT id FROM notifications WHERE id = ? AND user_id = ?").bind(id, user.id).first();
    if (!existing) return json({ error: "Notification not found" }, 404);
    await db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?").bind(ts, id, user.id).run();
    await writeAudit(db, { userId: user.id, action: "notification.read", resourceType: "notification", resourceId: id });
    return json({ ok: true });
  }

  if (action === "read_all") {
    await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(ts, user.id).run();
    await writeAudit(db, { userId: user.id, action: "notification.read_all" });
    return json({ ok: true });
  }

  return json({ error: "action must be 'read' or 'read_all'" }, 400);
}
