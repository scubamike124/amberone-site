import {
  createSession,
  hashPassword,
  json,
  publicUser,
  readJson,
  sessionCookie,
} from "../../_lib/core.js";

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);

  const body = await readJson(context.request);
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return json({ error: "Email and password required" }, 400);

  const user = await db
    .prepare(
      "SELECT id, email, name, password_hash, password_salt, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id FROM users WHERE email = ?",
    )
    .bind(email)
    .first();
  if (!user) return json({ error: "Invalid email or password" }, 401);

  const hash = await hashPassword(password, user.password_salt);
  if (hash !== user.password_hash) return json({ error: "Invalid email or password" }, 401);

  const session = await createSession(db, user.id);
  return json(
    { ok: true, user: publicUser(user) },
    200,
    { "Set-Cookie": sessionCookie(session.token, context.request) },
  );
}
