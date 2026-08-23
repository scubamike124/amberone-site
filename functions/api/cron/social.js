import { ensureSchema, json, originFrom, sha256Hex, readJson } from "../../_lib/core.js";
import { runSocialCronTick } from "../../_lib/social-schedule.js";

async function cronAuthorized(env, request) {
  const provided = request.headers.get("X-Cron-Secret") || "";
  const expectedHash =
    env.CRON_SECRET_HASH || "0cd4804e6f11b14d729193f6c6014d43ecf5537823ca3505fccb799a1816a539";
  if (!provided) return false;
  const got = await sha256Hex(provided);
  return got === expectedHash && expectedHash.length === 64;
}

export async function onRequestPost(context) {
  if (!(await cronAuthorized(context.env, context.request))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const body = await readJson(context.request).catch(() => ({}));
  const platform = String(body?.platform || "").toLowerCase() || null;
  const result = await runSocialCronTick({
    env: context.env,
    db,
    origin: originFrom(context.request),
    platform: ["instagram", "nextdoor", "tiktok"].includes(platform) ? platform : null,
  });
  return json({ ok: true, cloud: true, platform: platform || "all", result, at: new Date().toISOString() });
}

export async function onRequestGet() {
  return json({ error: "POST with X-Cron-Secret" }, 405);
}
