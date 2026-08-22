import { json } from "../_lib/core.js";

/** Public health — no user counts, table names, or secrets. */
export async function onRequestGet(context) {
  const db = Boolean(context.env.DB);
  const r2 = Boolean(context.env.MEDIA_BUCKET || context.env.R2);
  const googleCalendarOAuth = Boolean(
    context.env.GOOGLE_CALENDAR_CLIENT_ID && context.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  );
  return json({
    ok: true,
    service: "amberone-site",
    status: "up",
    db,
    r2,
    googleCalendarOAuth,
    timestamp: new Date().toISOString(),
  });
}
