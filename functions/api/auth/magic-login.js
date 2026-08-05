import {
  createSession,
  ensureSchema,
  hashPassword,
  json,
  nowIso,
  randomSaltHex,
  randomToken,
  readJson,
  sessionCookie,
  sha256Hex,
  targetIterations,
  uid,
} from "../../_lib/core.js";

async function ensureMagicTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS magic_logins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  next_path TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
)`,
    )
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_magic_logins_hash ON magic_logins(token_hash)`).run();
}

async function ensureAssistUser(db, email, name, env) {
  const existing = await db.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(email).first();
  if (existing) return existing;
  const id = uid("user");
  const salt = randomSaltHex();
  // The password here is a random token nobody ever learns, but it is still a
  // credential sitting in the table, so it is created at the current target and
  // records its cost like any other.
  const iterations = targetIterations(env);
  const passwordHash = await hashPassword(randomToken(24), salt, iterations);
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'none', NULL, ?, ?)`,
    )
    .bind(id, email, name, passwordHash, salt, iterations, ts, ts)
    .run();
  return { id, email, name };
}

/** POST { email?, next? } with X-Assist-Secret → one-time login URL */
export async function onRequestPost(context) {
  const secret = context.env.ASSIST_LOGIN_SECRET;
  const provided = context.request.headers.get("X-Assist-Secret") || "";
  if (!secret || provided !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  await ensureMagicTable(db);

  const body = await readJson(context.request);
  const email = String(body.email || "owner-assist@amberone.local").trim().toLowerCase();
  const nextPath = String(body.next || "/dashboard/connections").startsWith("/")
    ? String(body.next || "/dashboard/connections")
    : "/dashboard/connections";
  const name = String(body.name || "AmberOne Owner").trim() || "AmberOne Owner";

  const user = await ensureAssistUser(db, email, name, context.env);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = uid("magic");
  const created = nowIso();
  const expires = new Date(Date.now() + 1000 * 60 * 20).toISOString();

  await db
    .prepare(
      "INSERT INTO magic_logins (id, user_id, token_hash, next_path, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(id, user.id, tokenHash, nextPath, expires, created)
    .run();

  const origin = new URL(context.request.url);
  const url = `${origin.protocol}//${origin.host}/api/auth/magic-login?token=${encodeURIComponent(token)}`;
  return json({ ok: true, url, expiresAt: expires, email: user.email, next: nextPath });
}

/** GET ?token= → set session cookie and redirect into dashboard */
export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  await ensureMagicTable(db);

  const url = new URL(context.request.url);
  const token = String(url.searchParams.get("token") || "");
  if (!token) return json({ error: "token required" }, 400);

  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      "SELECT id, user_id, next_path, expires_at, used_at FROM magic_logins WHERE token_hash = ? LIMIT 1",
    )
    .bind(tokenHash)
    .first();

  if (!row || row.used_at) {
    return Response.redirect(new URL("/login?error=magic_used", url.origin).toString(), 302);
  }
  if (row.expires_at < nowIso()) {
    return Response.redirect(new URL("/login?error=magic_expired", url.origin).toString(), 302);
  }

  await db.prepare("UPDATE magic_logins SET used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  const session = await createSession(db, row.user_id);
  const next = row.next_path && String(row.next_path).startsWith("/") ? row.next_path : "/dashboard/connections";

  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      "Set-Cookie": sessionCookie(session.token, context.request),
      "Cache-Control": "no-store",
    },
  });
}
