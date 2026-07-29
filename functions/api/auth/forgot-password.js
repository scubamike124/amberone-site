import {
  json,
  nowIso,
  randomToken,
  readJson,
  sha256Hex,
  uid,
} from "../../_lib/core.js";

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);

  const body = await readJson(context.request);
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  if (!email) return json({ error: "Email required" }, 400);

  const user = await db.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(email).first();
  // Always return ok to avoid account enumeration
  if (!user) {
    return json({
      ok: true,
      message: "If that email exists, a reset link is ready.",
    });
  }

  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = uid("reset");
  const created = nowIso();
  const expires = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  await db
    .prepare(
      "INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    )
    .bind(id, user.id, tokenHash, expires, created)
    .run();

  const origin = new URL(context.request.url);
  const resetUrl = `${origin.protocol}//${origin.host}/reset-password.html?token=${encodeURIComponent(token)}`;

  const resendKey = context.env.RESEND_API_KEY;
  const from = context.env.EMAIL_FROM || "AmberOne <noreply@amberone.app>";
  if (resendKey) {
    const mail = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: "Reset your AmberOne password",
        html: `<p>Hi${user.name ? ` ${user.name}` : ""},</p><p>Reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`,
      }),
    });
    if (!mail.ok) {
      const err = await mail.text();
      return json({ error: `Email send failed: ${err}` }, 502);
    }
    return json({ ok: true, message: "If that email exists, a reset link was sent." });
  }

  // No email provider yet — return token for owner/local setup only
  return json({
    ok: true,
    message: "Password reset created. Email delivery is not configured yet (add RESEND_API_KEY).",
    setupRequired: "RESEND_API_KEY",
    resetUrl,
  });
}
