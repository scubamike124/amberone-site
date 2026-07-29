import { json, nowIso, uid, getUserFromRequest, ensureSchema } from "../_lib/core.js";
import { requirePlan } from "../_lib/team-gate.js";

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const method = request.method;
  const db = env.DB;

  // POST /api/teams — create team
  if (method === "POST") {
    const body = await request.json();
    const id = uid("team");
    const now = nowIso();
    await db
      .prepare("INSERT INTO teams (id, owner_user_id, name, plan_slug, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, user.id, body.name || "My Team", user.plan_slug || null, now, now)
      .run();
    // add owner as active member
    await db
      .prepare("INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(uid("tm"), id, user.id, "owner", user.email, "active", now)
      .run();
    return json({ id, name: body.name || "My Team" }, 201);
  }

  // GET /api/teams — list user's teams
  if (method === "GET") {
    const action = url.searchParams.get("action");

    // GET /api/teams?action=members&team_id=X
    if (action === "members") {
      const teamId = url.searchParams.get("team_id");
      const rows = await db.prepare("SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at").bind(teamId).all();
      return json(rows.results || []);
    }

    const rows = await db
      .prepare("SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active'")
      .bind(user.id)
      .all();
    return json(rows.results || []);
  }

  // PATCH /api/teams — invite member
  if (method === "PATCH") {
    const body = await request.json();
    if (body.action === "invite") {
      const id = uid("tm");
      await db
        .prepare("INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(id, body.team_id, null, body.role || "member", body.email, "pending", nowIso())
        .run();
      return json({ id, status: "pending" });
    }
    if (body.action === "accept") {
      await db
        .prepare("UPDATE team_members SET user_id = ?, status = 'active' WHERE id = ?")
        .bind(user.id, body.member_id)
        .run();
      return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  }

  // DELETE /api/teams?id=X
  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    await db.prepare("DELETE FROM teams WHERE id = ? AND owner_user_id = ?").bind(id, user.id).run();
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
