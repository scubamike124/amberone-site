import { ensureSchema, json } from "../_lib/core.js";

/**
 * Public health probe.
 *
 * This is unauthenticated and reachable by anyone, so it answers exactly one
 * question — is the service up — and nothing else.
 *
 * It previously returned `userCount` and the full output of
 * `SELECT name FROM sqlite_master`, which published a live user count and all
 * 28 table names, `password_resets`, `magic_logins`, `sessions` and
 * `connected_accounts` among them. That is a map of what to attack and a
 * measure of how much is behind it, handed over on request.
 *
 * It also returned `err.message` on failure, so a database error surfaced its
 * text — query fragments, column names, file paths — to the caller.
 *
 * `SELECT 1` proves the binding is alive and the database answers, which is
 * everything a health check is for.
 */
export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) {
    return json({ ok: false, status: "down", reason: "database_unavailable" }, 503);
  }

  try {
    await ensureSchema(db);
    await db.prepare("SELECT 1").first();
    return json({
      ok: true,
      service: "amberone-site",
      status: "up",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Logged in full for operators; the caller is told only that it failed.
    console.error("[health] database probe failed", err);
    return json({ ok: false, status: "degraded", reason: "database_error" }, 500);
  }
}
