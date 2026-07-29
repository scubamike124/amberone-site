import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const note = await db
      .prepare("SELECT id, title, body, pinned, created_at, updated_at FROM notes WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .first();
    if (!note) return json({ error: "Note not found" }, 404);
    return json({ note });
  }

  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const rows = await db
    .prepare(
      "SELECT id, title, body, pinned, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?",
    )
    .bind(user.id, limit)
    .all();
  return json({ notes: rows.results || [] });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || "").trim();
  const noteBody = String(body.body || "").trim();
  if (!title && !noteBody) return json({ error: "title or body is required" }, 400);

  const id = uid("note");
  const ts = nowIso();
  const pinned = body.pinned ? 1 : 0;
  await db
    .prepare("INSERT INTO notes (id, user_id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, (title || noteBody.slice(0, 80)).slice(0, 200), noteBody, pinned, ts, ts)
    .run();

  await writeAudit(db, { userId: user.id, action: "note.create", resourceType: "note", resourceId: id });
  return json(
    {
      ok: true,
      note: { id, title: title || noteBody.slice(0, 80), body: noteBody, pinned, created_at: ts, updated_at: ts },
    },
    201,
  );
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

  const existing = await db.prepare("SELECT id FROM notes WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Note not found" }, 404);

  const title = body.title !== undefined ? String(body.title).trim().slice(0, 200) : null;
  const noteBody = body.body !== undefined ? String(body.body) : null;
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : null;
  const ts = nowIso();

  await db
    .prepare(
      `UPDATE notes SET
        title = COALESCE(?, title),
        body = COALESCE(?, body),
        pinned = COALESCE(?, pinned),
        updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(title, noteBody, pinned, ts, id, user.id)
    .run();

  await writeAudit(db, { userId: user.id, action: "note.update", resourceType: "note", resourceId: id });
  const note = await db
    .prepare("SELECT id, title, body, pinned, created_at, updated_at FROM notes WHERE id = ?")
    .bind(id)
    .first();
  return json({ ok: true, note });
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

  const existing = await db.prepare("SELECT id FROM notes WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "Note not found" }, 404);

  await db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, { userId: user.id, action: "note.delete", resourceType: "note", resourceId: id });
  return json({ ok: true });
}
