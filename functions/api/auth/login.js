import {

  createSession,

  hashPassword,

  json,

  publicUser,

  readJson,

  sessionCookie,

  ensureSchema,

  timingSafeEqual,

  iterationsForStoredHash,

  targetIterations,

  randomSaltHex,

  nowIso,

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

        "SELECT id, email, name, password_hash, password_salt, password_iterations, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id FROM users WHERE email = ?",

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

    /*
     * Verify at the cost this hash was actually created with, not the current
     * target. Rows that predate the password_iterations column were all derived
     * at 10,000; verifying them at today's target would reject every correct
     * password in the table.
     */
    const storedIterations = iterationsForStoredHash(user);
    const hash = await hashPassword(password, user.password_salt, storedIterations);

    if (!timingSafeEqual(hash, user.password_hash)) {
      return json({ error: "Invalid email or password" }, 401);
    }

    /*
     * Correct password, weak hash — re-derive at the current target and store
     * it. This is the migration: accounts upgrade silently as people sign in,
     * so nobody is locked out and no bulk rewrite is needed. A bulk rewrite is
     * impossible in any case, since the plaintext only exists at this moment.
     *
     * A fresh salt goes with the new hash: it costs nothing here and means a
     * pre-upgrade hash and its replacement share nothing.
     *
     * Wrapped so it can never cost anyone a login. If the write fails the old
     * hash stays, which still verifies, and the next sign-in tries again.
     */
    const target = targetIterations(context.env);
    if (storedIterations < target) {
      try {
        const upgradedSalt = randomSaltHex();
        const upgradedHash = await hashPassword(password, upgradedSalt, target);
        await db
          .prepare(
            "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ? WHERE id = ?",
          )
          .bind(upgradedHash, upgradedSalt, target, nowIso(), user.id)
          .run();
      } catch (err) {
        console.error("password rehash failed", err);
      }
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


