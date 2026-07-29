import { json, nowIso, uid, getUserFromRequest, ensureSchema } from "../_lib/core.js";
import { resolveTeam } from "../_lib/team-gate.js";

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  request._user = user;

  const team = await resolveTeam(request, env);
  if (!team) return json({ error: "No team found. Create or join a team first." }, 400);

  const url = new URL(request.url);
  const method = request.method;
  const db = env.DB;

  if (method === "GET") {
    const status = url.searchParams.get("status") || "pending";
    const rows = await db
      .prepare("SELECT * FROM chores WHERE team_id = ? AND status = ? ORDER BY due_at ASC, created_at DESC")
      .bind(team.id, status)
      .all();
    return json(rows.results || []);
  }

  if (method === "POST") {
    const body = await request.json();
    const id = uid("chore");
    const now = nowIso();
    await db
      .prepare("INSERT INTO chores (id, team_id, assigned_user_id, title, body, recurrence, status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, team.id, body.assigned_user_id || null, body.title || "", body.body || null, body.recurrence || null, "pending", body.due_at || null, now, now)
      .run();
    return json({ id }, 201);
  }

  if (method === "PATCH") {
    const body = await request.json();
    const sets = [];
    const vals = [];
    if (body.status !== undefined) { sets.push("status = ?"); vals.push(body.status); }
    if (body.assigned_user_id !== undefined) { sets.push("assigned_user_id = ?"); vals.push(body.assigned_user_id); }
    if (body.title !== undefined) { sets.push("title = ?"); vals.push(body.title); }
    sets.push("updated_at = ?"); vals.push(nowIso());
    vals.push(body.id);
    await db.prepare(`UPDATE chores SET ${sets.join(", ")} WHERE id = ? AND team_id = '${team.id}'`).bind(...vals).run();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    await db.prepare("DELETE FROM chores WHERE id = ? AND team_id = ?").bind(id, team.id).run();
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
