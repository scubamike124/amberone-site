import {

  createSession,

  hashPassword,

  json,

  nowIso,

  publicUser,

  randomSaltHex,

  readJson,

  sessionCookie,

  uid,

  ensureSchema,

} from "../../_lib/core.js";



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

    const name = String(body.name || "").trim();

    const plan = body.plan ? String(body.plan).toLowerCase() : null;



    if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);

    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);



    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();

    if (existing) return json({ error: "An account with that email already exists" }, 409);



    const salt = randomSaltHex();

    // New accounts are created at the current target and record it, so they
    // never need the lazy upgrade on login.
    const iterations = targetIterations(context.env);

    const passwordHash = await hashPassword(password, salt, iterations);

    const id = uid("user");

    const ts = nowIso();



    await db

      .prepare(

        `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations, plan_slug, subscription_status, created_at, updated_at)

         VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,

      )

      .bind(id, email, name || email.split("@")[0], passwordHash, salt, iterations, plan, ts, ts)

      .run();



    const session = await createSession(db, id);

    const user = await db

      .prepare(

        "SELECT id, email, name, stripe_customer_id, plan_slug, subscription_status, stripe_subscription_id FROM users WHERE id = ?",

      )

      .bind(id)

      .first();



    return json(

      { ok: true, user: publicUser(user), next: plan ? `/pricing?plan=${encodeURIComponent(plan)}` : "/dashboard/" },

      201,

      { "Set-Cookie": sessionCookie(session.token, context.request) },

    );

  } catch (err) {

    // The message and error name used to be returned to the caller. On an
    // unauthenticated endpoint that hands anyone who can trigger an exception
    // the underlying D1 error text — table and column names, constraint names,
    // sometimes the failing statement. It belongs in the logs.
    console.error("signup failed", err);

    return json({ error: "Signup failed" }, 500);

  }

}


