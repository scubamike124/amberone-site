import { json, nowIso, uid, getUserFromRequest, ensureSchema } from "../_lib/core.js";
import { resolveTeam } from "../_lib/team-gate.js";

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  request._user = user;

  const team = await resolveTeam(request, env);
  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

  if (method === "GET") {
    const scope = team ? "team_id" : "user_id";
    const scopeVal = team ? team.id : user.id;
    const rows = await db
      .prepare(`SELECT * FROM appointments WHERE ${scope} = ? ORDER BY starts_at ASC`)
      .bind(scopeVal)
      .all();
    return json(rows.results || []);
  }

  if (method === "POST") {
    const body = await request.json();
    const id = uid("appt");
    const now = nowIso();
    await db
      .prepare("INSERT INTO appointments (id, team_id, user_id, contact_id, title, starts_at, ends_at, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, team?.id || null, user.id, body.contact_id || null, body.title || "", body.starts_at, body.ends_at || null, "scheduled", body.notes || null, now, now)
      .run();
    return json({ id }, 201);
  }

  if (method === "PATCH") {
    const body = await request.json();
    const sets = [];
    const vals = [];
    for (const k of ["title", "starts_at", "ends_at", "status", "notes", "contact_id"]) {
      if (body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(body[k]); }
    }
    sets.push("updated_at = ?"); vals.push(nowIso());
    vals.push(body.id);
    await db.prepare(`UPDATE appointments SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    await db.prepare("DELETE FROM appointments WHERE id = ?").bind(id).run();
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
