import { json, nowIso, uid, getUserFromRequest, ensureSchema } from "../_lib/core.js";
import { userIsTeamMember } from "../_lib/team-gate.js";

async function contactVisibleToUser(db, user, contactId) {
  const contact = await db
    .prepare("SELECT * FROM crm_contacts WHERE id = ?")
    .bind(contactId)
    .first();
  if (!contact) return null;
  if (contact.user_id === user.id) return contact;
  if (contact.team_id && (await userIsTeamMember(db, user.id, contact.team_id))) return contact;
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const method = request.method;
  const db = env.DB;

  if (method === "GET") {
    const contactId = url.searchParams.get("contact_id");
    if (contactId) {
      const contact = await contactVisibleToUser(db, user, contactId);
      if (!contact) return json({ error: "Not found" }, 404);
      const rows = await db
        .prepare("SELECT * FROM crm_interactions WHERE contact_id = ? ORDER BY occurred_at DESC")
        .bind(contactId)
        .all();
      return json(rows.results || []);
    }
    const teamId = url.searchParams.get("team_id");
    if (teamId) {
      if (!(await userIsTeamMember(db, user.id, teamId))) return json({ error: "Not found" }, 404);
      const rows = await db
        .prepare("SELECT * FROM crm_contacts WHERE team_id = ? ORDER BY updated_at DESC")
        .bind(teamId)
        .all();
      return json(rows.results || []);
    }
    const rows = await db
      .prepare("SELECT * FROM crm_contacts WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(user.id)
      .all();
    return json(rows.results || []);
  }

  if (method === "POST") {
    const body = await request.json();
    const now = nowIso();

    if (body.type === "interaction") {
      const contact = await contactVisibleToUser(db, user, body.contact_id);
      if (!contact) return json({ error: "Not found" }, 404);
      const id = uid("int");
      await db
        .prepare(
          "INSERT INTO crm_interactions (id, contact_id, user_id, kind, summary, occurred_at, created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(id, body.contact_id, user.id, body.kind || "note", body.summary || "", body.occurred_at || now, now)
        .run();
      return json({ id }, 201);
    }

    if (body.team_id && !(await userIsTeamMember(db, user.id, body.team_id))) {
      return json({ error: "Not found" }, 404);
    }
    const id = uid("contact");
    await db
      .prepare(
        "INSERT INTO crm_contacts (id, team_id, user_id, name, email, phone, company, notes, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        body.team_id || null,
        user.id,
        body.name || "",
        body.email || null,
        body.phone || null,
        body.company || null,
        body.notes || null,
        body.tags_json || null,
        now,
        now,
      )
      .run();
    return json({ id }, 201);
  }

  if (method === "PATCH") {
    const body = await request.json();
    const existing = await contactVisibleToUser(db, user, body.id);
    if (!existing) return json({ error: "Not found" }, 404);
    const sets = [];
    const vals = [];
    for (const k of ["name", "email", "phone", "company", "notes", "tags_json"]) {
      if (body[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(body[k]);
      }
    }
    if (!sets.length) return json({ error: "Nothing to update" }, 400);
    sets.push("updated_at = ?");
    vals.push(nowIso());
    vals.push(body.id);
    await db.prepare(`UPDATE crm_contacts SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    const existing = await contactVisibleToUser(db, user, id);
    if (!existing) return json({ error: "Not found" }, 404);
    await db.prepare("DELETE FROM crm_contacts WHERE id = ?").bind(id).run();
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
