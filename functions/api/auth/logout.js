import { clearSessionCookie, getCookie, json, sha256Hex } from "../../_lib/core.js";

export async function onRequestPost(context) {
  const db = context.env.DB;
  const token = getCookie(context.request, "ao_session");
  if (db && token) {
    const tokenHash = await sha256Hex(token);
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(context.request) });
}
