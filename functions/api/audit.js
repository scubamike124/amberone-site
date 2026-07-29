import { ensureSchema, getUserFromRequest, json } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const rows = await db
    .prepare(
      "SELECT id, action, resource_type, resource_id, meta_json, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(user.id)
    .all();

  const logs = (rows.results || []).map((r) => ({
    id: r.id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    meta: r.meta_json ? JSON.parse(r.meta_json) : null,
    createdAt: r.created_at,
  }));

  return json({ logs });
}
