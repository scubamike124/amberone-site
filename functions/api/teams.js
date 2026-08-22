import {
  createNotification,
  ensureSchema,
  getUserFromRequest,
  isValidEmail,
  json,
  normalizeEmail,
  nowIso,
  uid,
  writeAudit,
} from "../_lib/core.js";

const ROLES = new Set(["member", "admin"]);

async function notifyEmailUser(db, email, payload) {
  const row = await db.prepare("SELECT id FROM users WHERE email = ?").bind(normalizeEmail(email)).first();
  if (!row) return null;
  return createNotification(db, { userId: row.id, ...payload });
}

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(request.url);
  const method = request.method;
  const db = env.DB;

  if (method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "My Team").trim().slice(0, 120) || "My Team";
    const id = uid("team");
    const now = nowIso();
    await db
      .prepare("INSERT INTO teams (id, owner_user_id, name, plan_slug, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, user.id, name, user.plan_slug || null, now, now)
      .run();
    await db
      .prepare("INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(uid("tm"), id, user.id, "owner", user.email, "active", now)
      .run();
    await writeAudit(db, { userId: user.id, action: "team.create", resourceType: "team", resourceId: id });
    return json({ id, name }, 201);
  }

  if (method === "GET") {
    const action = url.searchParams.get("action");

    if (action === "invites") {
      const rows = await db
        .prepare(
          `SELECT tm.id, tm.team_id, tm.role, tm.invited_email, tm.status, tm.created_at, t.name AS team_name
           FROM team_members tm JOIN teams t ON t.id = tm.team_id
           WHERE lower(tm.invited_email) = lower(?) AND tm.status = 'pending'
           ORDER BY tm.created_at DESC`,
        )
        .bind(user.email)
        .all();
      return json({ invites: rows.results || [] });
    }

    if (action === "members") {
      const teamId = url.searchParams.get("team_id");
      const allowed = await db
        .prepare("SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'active' LIMIT 1")
        .bind(teamId, user.id)
        .first();
      if (!allowed) return json({ error: "Not found" }, 404);
      const rows = await db
        .prepare(
          "SELECT id, team_id, user_id, role, invited_email, status, created_at FROM team_members WHERE team_id = ? ORDER BY created_at",
        )
        .bind(teamId)
        .all();
      return json(rows.results || []);
    }

    const rows = await db
      .prepare("SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active'")
      .bind(user.id)
      .all();
    return json(rows.results || []);
  }

  if (method === "PATCH") {
    const body = await request.json().catch(() => ({}));

    if (body.action === "invite") {
      const owner = await db
        .prepare("SELECT 1 AS ok FROM teams WHERE id = ? AND owner_user_id = ?")
        .bind(body.team_id, user.id)
        .first();
      if (!owner) return json({ error: "Not found" }, 404);
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) return json({ error: "A valid email address is required" }, 400);
      const role = ROLES.has(String(body.role || "member")) ? String(body.role) : "member";
      const existing = await db
        .prepare(
          "SELECT id, status FROM team_members WHERE team_id = ? AND lower(invited_email) = lower(?) LIMIT 1",
        )
        .bind(body.team_id, email)
        .first();
      if (existing && existing.status !== "rejected") {
        return json({ error: "That person is already invited or is a member" }, 409);
      }
      const id = existing?.id || uid("tm");
      if (existing) {
        await db
          .prepare("UPDATE team_members SET role = ?, status = 'pending', user_id = NULL, created_at = ? WHERE id = ?")
          .bind(role, nowIso(), id)
          .run();
      } else {
        await db
          .prepare("INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)")
          .bind(id, body.team_id, null, role, email, "pending", nowIso())
          .run();
      }
      const team = await db.prepare("SELECT name FROM teams WHERE id = ?").bind(body.team_id).first();
      await notifyEmailUser(db, email, {
        kind: "invite",
        title: `Family invite: ${team?.name || "AmberOne"}`,
        body: `${user.name || user.email} invited you to join as ${role}.`,
        href: "/dashboard/family/members",
      });
      await writeAudit(db, { userId: user.id, action: "team.invite", resourceType: "team", resourceId: body.team_id, meta: { email } });
      return json({ id, status: "pending", emailed: false, notifiedIfAccountExists: true });
    }

    if (body.action === "accept" || body.action === "reject") {
      const invite = await db.prepare("SELECT * FROM team_members WHERE id = ?").bind(body.member_id).first();
      if (!invite || invite.status !== "pending") return json({ error: "Invite not found" }, 404);
      if (normalizeEmail(invite.invited_email) !== normalizeEmail(user.email)) {
        return json({ error: "This invite belongs to a different email address" }, 403);
      }
      if (body.action === "reject") {
        await db.prepare("UPDATE team_members SET status = 'rejected' WHERE id = ?").bind(invite.id).run();
        await writeAudit(db, { userId: user.id, action: "team.invite_reject", resourceType: "team", resourceId: invite.team_id });
        return json({ ok: true, status: "rejected" });
      }
      await db
        .prepare("UPDATE team_members SET user_id = ?, status = 'active' WHERE id = ?")
        .bind(user.id, invite.id)
        .run();
      const owner = await db.prepare("SELECT owner_user_id, name FROM teams WHERE id = ?").bind(invite.team_id).first();
      if (owner?.owner_user_id) {
        await createNotification(db, {
          userId: owner.owner_user_id,
          kind: "invite",
          title: `${user.name || user.email} joined ${owner.name || "your team"}`,
          body: null,
          href: "/dashboard/family/members",
        });
      }
      await writeAudit(db, { userId: user.id, action: "team.invite_accept", resourceType: "team", resourceId: invite.team_id });
      return json({ ok: true, status: "active" });
    }

    return json({ error: "Unknown action" }, 400);
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    await db.prepare("DELETE FROM teams WHERE id = ? AND owner_user_id = ?").bind(id, user.id).run();
    await writeAudit(db, { userId: user.id, action: "team.delete", resourceType: "team", resourceId: id });
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
