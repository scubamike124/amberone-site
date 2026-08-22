import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const kind = url.searchParams.get("kind");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));

  let query = "SELECT id, kind, title, content, importance, source, created_at, updated_at FROM memories WHERE user_id = ?";
  const binds = [user.id];
  if (kind) {
    query += " AND kind = ?";
    binds.push(kind);
  }
  query += " ORDER BY importance DESC, created_at DESC LIMIT ?";
  binds.push(limit);

  const rows = await db.prepare(query).bind(...binds).all();
  return json({ memories: rows.results || [] });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  if (!title || !content) return json({ error: "title and content are required" }, 400);
  const kind = String(body.kind || "note").trim().slice(0, 40) || "note";
  const importance = Math.min(5, Math.max(1, Number(body.importance) || 3));

  const id = uid("mem");
  const ts = nowIso();
  await db
    .prepare(
      "INSERT INTO memories (id, user_id, kind, title, content, importance, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, user.id, kind, title.slice(0, 200), content, importance, "user", ts, ts)
    .run();

  await writeAudit(db, { userId: user.id, action: "memory.create", resourceType: "memory", resourceId: id });

  return json({ ok: true, memory: { id, kind, title, content, importance, source: "user", created_at: ts, updated_at: ts } }, 201);
}

export async function onRequestPatch(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "id is required" }, 400);
  const existing = await db.prepare("SELECT * FROM memories WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Memory not found" }, 404);

  const ts = nowIso();
  await db
    .prepare(
      `UPDATE memories SET
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        kind = COALESCE(?, kind),
        importance = COALESCE(?, importance),
        updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      body.title !== undefined ? String(body.title).slice(0, 200) : null,
      body.content !== undefined ? String(body.content) : null,
      body.kind !== undefined ? String(body.kind).slice(0, 40) : null,
      body.importance !== undefined ? Math.min(5, Math.max(1, Number(body.importance) || 3)) : null,
      ts,
      id,
      user.id,
    )
    .run();
  await writeAudit(db, { userId: user.id, action: "memory.update", resourceType: "memory", resourceId: id });
  const memory = await db.prepare("SELECT id, kind, title, content, importance, source, created_at, updated_at FROM memories WHERE id = ?").bind(id).first();
  return json({ ok: true, memory });
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

  const existing = await db.prepare("SELECT id FROM memories WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Memory not found" }, 404);

  await db.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, { userId: user.id, action: "memory.delete", resourceType: "memory", resourceId: id });

  return json({ ok: true });
}
