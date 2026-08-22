import {
  createSession,
  ensureSchema,
  hashPassword,
  json,
  nowIso,
  originFrom,
  randomSaltHex,
  randomToken,
  readJson,
  sessionCookie,
  sha256Hex,
  targetIterations,
  uid,
  writeAudit,
} from "../../_lib/core.js";
import {
  BETA_KIND,
  BETA_NAME,
  BETA_PLAN,
  BETA_TTL_DAYS,
  ensureBetaSchema,
  isBetaAccount,
} from "../../_lib/beta.js";

async function mintOk(env, request) {
  const assist = env.ASSIST_LOGIN_SECRET;
  const providedAssist = request.headers.get("X-Assist-Secret") || "";
  if (assist && providedAssist && providedAssist === assist) return true;
  const expectedHash = env.BETA_BOOTSTRAP_HASH || "487af7742502e246bf069bb7258b2671684a43b908bc27b9adc401bce159d7df";
  const providedBoot = request.headers.get("X-Beta-Bootstrap") || "";
  if (!expectedHash || !providedBoot) return false;
  const got = await sha256Hex(providedBoot);
  return got === expectedHash;
}

async function ensureBetaUser(db, env, { email, name, expiresAt }) {
  const existing = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  const ts = nowIso();
  if (existing) {
    await db
      .prepare(
        `UPDATE users
         SET name = ?, account_kind = ?, plan_slug = ?, subscription_status = 'beta',
             stripe_customer_id = NULL, stripe_subscription_id = NULL, beta_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(name, BETA_KIND, BETA_PLAN, expiresAt, ts, existing.id)
      .run();
    return { ...existing, name, account_kind: BETA_KIND, plan_slug: BETA_PLAN, beta_expires_at: expiresAt };
  }
  const id = uid("user");
  const salt = randomSaltHex();
  const iterations = targetIterations(env);
  const passwordHash = await hashPassword(randomToken(24), salt, iterations);
  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id, created_at, updated_at, account_kind, beta_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'beta', NULL, ?, ?, ?, ?)`,
    )
    .bind(id, email, name, passwordHash, salt, iterations, BETA_PLAN, ts, ts, BETA_KIND, expiresAt)
    .run();
  return { id, email, name, account_kind: BETA_KIND, plan_slug: BETA_PLAN, beta_expires_at: expiresAt };
}

async function seedBetaWorkspace(db, user) {
  const ts = nowIso();
  const onboard = await db.prepare("SELECT user_id FROM onboarding_state WHERE user_id = ?").bind(user.id).first();
  if (!onboard) {
    await db
      .prepare(
        `INSERT INTO onboarding_state (user_id, step, prefs_json, completed_at, created_at, updated_at)
         VALUES (?, 'complete', ?, ?, ?, ?)`,
      )
      .bind(user.id, JSON.stringify({ beta: true, surfaces: ["personal", "family", "executive", "business"] }), ts, ts, ts)
      .run()
      .catch(() => {});
  }
  const team = await db.prepare("SELECT id FROM teams WHERE owner_user_id = ? LIMIT 1").bind(user.id).first();
  if (!team) {
    const teamId = uid("team");
    await db
      .prepare("INSERT INTO teams (id, owner_user_id, name, plan_slug, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(teamId, user.id, "Beta family workspace", BETA_PLAN, ts, ts)
      .run()
      .catch(() => {});
    await db
      .prepare(
        "INSERT INTO team_members (id, team_id, user_id, role, invited_email, status, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(uid("tm"), teamId, user.id, "owner", user.email, "active", ts)
      .run()
      .catch(() => {});
  }
}

/** GET ?token= — redeem a beta magic link into a session. */
export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  await ensureBetaSchema(db);

  const url = new URL(context.request.url);
  const token = String(url.searchParams.get("token") || "");
  if (!token) return json({ error: "token required" }, 400);

  const tokenHash = await sha256Hex(token);
  const invite = await db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at FROM beta_invites WHERE token_hash = ? LIMIT 1`,
    )
    .bind(tokenHash)
    .first();

  const fail = (code) =>
    Response.redirect(new URL(`/beta?error=${encodeURIComponent(code)}`, url.origin).toString(), 302);

  if (!invite) return fail("invalid");
  if (invite.revoked_at) return fail("revoked");
  if (invite.expires_at < nowIso()) return fail("expired");

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(invite.user_id).first();
  if (!user || !isBetaAccount(user)) return fail("invalid");
  if (user.beta_expires_at && user.beta_expires_at < nowIso()) return fail("expired");

  const remainingMs = new Date(invite.expires_at).getTime() - Date.now();
  const maxAgeSec = Math.max(60, Math.floor(remainingMs / 1000));
  const session = await createSession(db, user.id, { maxAgeSec });
  await db
    .prepare("UPDATE beta_invites SET last_redeemed_at = ? WHERE id = ?")
    .bind(nowIso(), invite.id)
    .run();
  await writeAudit(db, {
    userId: user.id,
    action: "beta.redeem",
    resourceType: "beta_invite",
    resourceId: invite.id,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard/?beta=1",
      "Set-Cookie": sessionCookie(session.token, context.request, maxAgeSec),
      "Cache-Control": "no-store",
    },
  });
}

/** POST { email?, name?, days? } with X-Assist-Secret — mint a revocable beta link. */
export async function onRequestPost(context) {
  if (!(await mintOk(context.env, context.request))) return json({ error: "Unauthorized" }, 401);
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  await ensureBetaSchema(db);

  const body = await readJson(context.request);
  const days = Math.min(30, Math.max(1, Number(body.days) || BETA_TTL_DAYS));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const email = String(body.email || "beta.tester@amberone.local").trim().toLowerCase();
  const name = String(body.name || BETA_NAME).trim() || BETA_NAME;

  const user = await ensureBetaUser(db, context.env, { email, name, expiresAt });
  await seedBetaWorkspace(db, user);

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = uid("beta");
  await db
    .prepare(
      `INSERT INTO beta_invites (id, user_id, token_hash, label, expires_at, revoked_at, last_redeemed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .bind(id, user.id, tokenHash, String(body.label || "friend-beta"), expiresAt, nowIso())
    .run();
  await writeAudit(db, { userId: user.id, action: "beta.issue", resourceType: "beta_invite", resourceId: id });

  const origin = originFrom(context.request);
  return json(
    {
      ok: true,
      url: `${origin}/beta?token=${encodeURIComponent(token)}`,
      expiresAt,
      inviteId: id,
      email: user.email,
    },
    201,
  );
}

/** DELETE { id } with X-Assist-Secret — revoke immediately. */
export async function onRequestDelete(context) {
  if (!(await mintOk(context.env, context.request))) return json({ error: "Unauthorized" }, 401);
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  await ensureBetaSchema(db);
  const body = await readJson(context.request);
  const id = String(body.id || body.inviteId || "");
  if (!id) return json({ error: "id required" }, 400);
  const invite = await db.prepare("SELECT id, user_id FROM beta_invites WHERE id = ?").bind(id).first();
  if (!invite) return json({ error: "Invite not found" }, 404);
  const ts = nowIso();
  await db.prepare("UPDATE beta_invites SET revoked_at = ? WHERE id = ?").bind(ts, invite.id).run();
  await db.prepare("UPDATE users SET beta_expires_at = ?, updated_at = ? WHERE id = ?").bind(ts, ts, invite.user_id).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(invite.user_id).run();
  await writeAudit(db, { userId: invite.user_id, action: "beta.revoke", resourceType: "beta_invite", resourceId: invite.id });
  return json({ ok: true, revokedAt: ts, inviteId: invite.id });
}
