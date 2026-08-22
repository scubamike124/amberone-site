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
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || "").trim();
    if (!title) return json({ error: "title is required" }, 400);
    let assigned = body.assigned_user_id || null;
    if (assigned) {
      const ok = await db
        .prepare("SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active'")
        .bind(team.id, assigned)
        .first();
      if (!ok) return json({ error: "Assignee must be an active team member" }, 400);
    }
    const id = uid("chore");
    const now = nowIso();
    await db
      .prepare("INSERT INTO chores (id, team_id, assigned_user_id, title, body, recurrence, status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, team.id, assigned, title.slice(0, 200), body.body || null, body.recurrence || null, "pending", body.due_at || null, now, now)
      .run();
    return json({ id, status: "pending" }, 201);
  }

  if (method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!id) return json({ error: "id is required" }, 400);
    const existing = await db.prepare("SELECT * FROM chores WHERE id = ? AND team_id = ?").bind(id, team.id).first();
    if (!existing) return json({ error: "Not found" }, 404);
    const sets = [];
    const vals = [];
    if (body.status !== undefined || body.complete !== undefined || body.reopen !== undefined) {
      let status = body.status;
      if (body.complete) status = "done";
      if (body.reopen) status = "pending";
      if (!["pending", "done", "cancelled"].includes(String(status))) {
        return json({ error: "Invalid chore status" }, 400);
      }
      sets.push("status = ?");
      vals.push(status);
    }
    if (body.assigned_user_id !== undefined) {
      if (body.assigned_user_id) {
        const ok = await db
          .prepare("SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active'")
          .bind(team.id, body.assigned_user_id)
          .first();
        if (!ok) return json({ error: "Assignee must be an active team member" }, 400);
      }
      sets.push("assigned_user_id = ?");
      vals.push(body.assigned_user_id || null);
    }
    if (body.title !== undefined) {
      sets.push("title = ?");
      vals.push(String(body.title).slice(0, 200));
    }
    if (body.body !== undefined) {
      sets.push("body = ?");
      vals.push(body.body);
    }
    if (!sets.length) return json({ error: "Nothing to update" }, 400);
    sets.push("updated_at = ?");
    vals.push(nowIso());
    vals.push(id);
    vals.push(team.id);
    await db.prepare(`UPDATE chores SET ${sets.join(", ")} WHERE id = ? AND team_id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    await db.prepare("DELETE FROM chores WHERE id = ? AND team_id = ?").bind(id, team.id).run();
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
