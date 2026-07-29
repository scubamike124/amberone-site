import {
  hashPassword,
  json,
  nowIso,
  randomSaltHex,
  readJson,
  sha256Hex,
} from "../../_lib/core.js";

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);

  const body = await readJson(context.request);
  const token = String(body.token || "");
  const password = String(body.password || "");
  if (!token) return json({ error: "Reset token required" }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      "SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ? LIMIT 1",
    )
    .bind(tokenHash)
    .first();
  if (!row || row.used_at) return json({ error: "Invalid or used reset link" }, 400);
  if (row.expires_at < nowIso()) return json({ error: "Reset link expired" }, 400);

  const salt = randomSaltHex();
  const passwordHash = await hashPassword(password, salt);
  const ts = nowIso();
  await db
    .prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
    .bind(passwordHash, salt, ts, row.user_id)
    .run();
  await db
    .prepare("UPDATE password_resets SET used_at = ? WHERE id = ?")
    .bind(ts, row.id)
    .run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id).run();

  return json({ ok: true, message: "Password updated. Sign in with your new password." });
}
