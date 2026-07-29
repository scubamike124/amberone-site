import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";

const KINDS = new Set(["shopping", "todo", "custom"]);

async function loadListWithItems(db, userId, listId) {
  const list = await db
    .prepare("SELECT id, kind, title, created_at, updated_at FROM lists WHERE id = ? AND user_id = ?")
    .bind(listId, userId)
    .first();
  if (!list) return null;
  const items = await db
    .prepare(
      "SELECT id, text, checked, position, created_at, updated_at FROM list_items WHERE list_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC",
    )
    .bind(listId, userId)
    .all();
  return { ...list, items: items.results || [] };
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const list = await loadListWithItems(db, user.id, id);
    if (!list) return json({ error: "List not found" }, 404);
    return json({ list });
  }

  const kind = url.searchParams.get("kind");
  let query =
    `SELECT l.id, l.kind, l.title, l.created_at, l.updated_at,
      (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS item_count,
      (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.checked = 0) AS unchecked_count
     FROM lists l WHERE l.user_id = ?`;
  const binds = [user.id];
  if (kind) {
    query += " AND l.kind = ?";
    binds.push(kind);
  }
  query += " ORDER BY l.updated_at DESC LIMIT 100";
  const rows = await db.prepare(query).bind(...binds).all();
  return json({ lists: rows.results || [] });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const ts = nowIso();

  // Add item to existing list
  if (body.list_id) {
    const listId = String(body.list_id);
    const existing = await db.prepare("SELECT id FROM lists WHERE id = ? AND user_id = ?").bind(listId, user.id).first();
    if (!existing) return json({ error: "List not found" }, 404);
    const text = String(body.text || "").trim();
    if (!text) return json({ error: "text is required" }, 400);
    const posRow = await db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM list_items WHERE list_id = ?")
      .bind(listId)
      .first();
    const itemId = uid("li");
    await db
      .prepare(
        "INSERT INTO list_items (id, list_id, user_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .bind(itemId, listId, user.id, text.slice(0, 500), posRow?.next_pos ?? 0, ts, ts)
      .run();
    await db.prepare("UPDATE lists SET updated_at = ? WHERE id = ?").bind(ts, listId).run();
    await writeAudit(db, { userId: user.id, action: "list_item.create", resourceType: "list_item", resourceId: itemId, meta: { listId } });
    const list = await loadListWithItems(db, user.id, listId);
    return json({ ok: true, item: { id: itemId, text, checked: 0 }, list }, 201);
  }

  // Create list
  const title = String(body.title || "").trim();
  if (!title) return json({ error: "title is required" }, 400);
  const kind = KINDS.has(String(body.kind || "")) ? String(body.kind) : "shopping";
  const id = uid("list");
  await db
    .prepare("INSERT INTO lists (id, user_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, kind, title.slice(0, 200), ts, ts)
    .run();

  const items = Array.isArray(body.items) ? body.items : [];
  for (let i = 0; i < items.length; i++) {
    const text = String(items[i]?.text || items[i] || "").trim();
    if (!text) continue;
    await db
      .prepare(
        "INSERT INTO list_items (id, list_id, user_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      )
      .bind(uid("li"), id, user.id, text.slice(0, 500), i, ts, ts)
      .run();
  }

  await writeAudit(db, { userId: user.id, action: "list.create", resourceType: "list", resourceId: id, meta: { kind } });
  const list = await loadListWithItems(db, user.id, id);
  return json({ ok: true, list }, 201);
}

export async function onRequestPatch(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const ts = nowIso();

  if (body.item_id) {
    const itemId = String(body.item_id);
    const item = await db
      .prepare("SELECT id, list_id FROM list_items WHERE id = ? AND user_id = ?")
      .bind(itemId, user.id)
      .first();
    if (!item) return json({ error: "Item not found" }, 404);
    const checked = body.checked !== undefined ? (body.checked ? 1 : 0) : null;
    const text = body.text !== undefined ? String(body.text).trim().slice(0, 500) : null;
    await db
      .prepare(
        `UPDATE list_items SET
          checked = COALESCE(?, checked),
          text = COALESCE(?, text),
          updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .bind(checked, text, ts, itemId, user.id)
      .run();
    await db.prepare("UPDATE lists SET updated_at = ? WHERE id = ?").bind(ts, item.list_id).run();
    await writeAudit(db, { userId: user.id, action: "list_item.update", resourceType: "list_item", resourceId: itemId });
    const list = await loadListWithItems(db, user.id, item.list_id);
    return json({ ok: true, list });
  }

  const id = String(body.id || "").trim();
  if (!id) return json({ error: "id or item_id is required" }, 400);
  const existing = await db.prepare("SELECT id FROM lists WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "List not found" }, 404);

  const title = body.title !== undefined ? String(body.title).trim().slice(0, 200) : null;
  const kind = body.kind !== undefined && KINDS.has(String(body.kind)) ? String(body.kind) : null;
  await db
    .prepare(
      `UPDATE lists SET
        title = COALESCE(?, title),
        kind = COALESCE(?, kind),
        updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(title, kind, ts, id, user.id)
    .run();
  await writeAudit(db, { userId: user.id, action: "list.update", resourceType: "list", resourceId: id });
  const list = await loadListWithItems(db, user.id, id);
  return json({ ok: true, list });
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const itemId = url.searchParams.get("item_id");
  if (itemId) {
    const item = await db
      .prepare("SELECT id, list_id FROM list_items WHERE id = ? AND user_id = ?")
      .bind(itemId, user.id)
      .first();
    if (!item) return json({ error: "Item not found" }, 404);
    await db.prepare("DELETE FROM list_items WHERE id = ? AND user_id = ?").bind(itemId, user.id).run();
    await db.prepare("UPDATE lists SET updated_at = ? WHERE id = ?").bind(nowIso(), item.list_id).run();
    await writeAudit(db, { userId: user.id, action: "list_item.delete", resourceType: "list_item", resourceId: itemId });
    return json({ ok: true });
  }

  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id or item_id query parameter required" }, 400);
  const existing = await db.prepare("SELECT id FROM lists WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!existing) return json({ error: "List not found" }, 404);

  await db.prepare("DELETE FROM list_items WHERE list_id = ? AND user_id = ?").bind(id, user.id).run();
  await db.prepare("DELETE FROM lists WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await writeAudit(db, { userId: user.id, action: "list.delete", resourceType: "list", resourceId: id });
  return json({ ok: true });
}
