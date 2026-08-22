import { ensureSchema, getUserFromRequest, json } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const q = String(new URL(context.request.url).searchParams.get("q") || "").trim();
  if (!q) return json({ error: "q is required" }, 400);
  if (q.length < 2) return json({ error: "Search needs at least 2 characters" }, 400);

  const like = `%${q.replace(/[%_]/g, "")}%`;
  const [notes, memories, events, tasks, lists] = await Promise.all([
    db
      .prepare("SELECT id, title, body, updated_at FROM notes WHERE user_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT 20")
      .bind(user.id, like, like)
      .all(),
    db
      .prepare("SELECT id, title, content, updated_at FROM memories WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT 20")
      .bind(user.id, like, like)
      .all(),
    db
      .prepare("SELECT id, title, starts_at, location FROM calendar_events WHERE user_id = ? AND (title LIKE ? OR description LIKE ? OR location LIKE ?) ORDER BY starts_at DESC LIMIT 20")
      .bind(user.id, like, like, like)
      .all(),
    db
      .prepare("SELECT id, title, status FROM project_tasks WHERE assigned_user_id = ? AND title LIKE ? LIMIT 20")
      .bind(user.id, like)
      .all()
      .catch(() => ({ results: [] })),
    db
      .prepare("SELECT id, title, kind FROM lists WHERE user_id = ? AND title LIKE ? LIMIT 20")
      .bind(user.id, like)
      .all(),
  ]);

  return json({
    q,
    notes: notes.results || [],
    memories: memories.results || [],
    events: events.results || [],
    tasks: tasks.results || [],
    lists: lists.results || [],
  });
}
