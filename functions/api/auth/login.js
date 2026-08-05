import {

  createSession,

  hashPassword,

  json,

  publicUser,

  readJson,

  sessionCookie,

  ensureSchema,

  timingSafeEqual,

} from "../../_lib/core.js";



/** Fixed, non-secret salt used only to spend the same work on unknown users. */
const ENUMERATION_DECOY_SALT = "00000000000000000000000000000000";



export async function onRequestPost(context) {

  try {

    const db = context.env.DB;

    if (!db) return json({ error: "Database not configured" }, 503);

    await ensureSchema(db);



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

    /*
     * An unknown address used to return here immediately, while a known one
     * paid for a PBKDF2 derivation first. The reply is deliberately identical
     * either way, but the time taken was not, so timing the endpoint told you
     * whether an address had an account. Hashing against a throwaway salt
     * costs the same work and removes the signal.
     */
    if (!user) {
      await hashPassword(password, ENUMERATION_DECOY_SALT);
      return json({ error: "Invalid email or password" }, 401);
    }

    const hash = await hashPassword(password, user.password_salt);

    if (!timingSafeEqual(hash, user.password_hash)) {
      return json({ error: "Invalid email or password" }, 401);
    }



    const session = await createSession(db, user.id);

    return json(

      { ok: true, user: publicUser(user) },

      200,

      { "Set-Cookie": sessionCookie(session.token, context.request) },

    );

  } catch (err) {

    // The detail used to be returned to the caller. On an unauthenticated
    // endpoint that hands anyone who can trigger an exception the D1 error
    // text — table and column names, constraint names, sometimes the failing
    // statement. It belongs in the logs, not the response body.
    console.error("login failed", err);

    return json({ error: "Login failed" }, 500);

  }

}


