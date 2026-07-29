import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";
import { buildBriefing, dayKeyInTz, resolveMode } from "../_lib/briefing.js";
import { dispatchDueReminders } from "./reminders.js";

async function prefsForUser(db, userId) {
  const row = await db.prepare("SELECT prefs_json FROM onboarding_state WHERE user_id = ?").bind(userId).first();
  if (!row?.prefs_json) return {};
  try {
    return JSON.parse(row.prefs_json) || {};
  } catch {
    return {};
  }
}

function optionsFromRequest(request, body, prefs) {
  const url = new URL(request.url);
  const timeZone =
    body.timeZone || url.searchParams.get("timeZone") || prefs.timeZone || request.headers.get("x-timezone") || "America/Los_Angeles";
  const mode = body.mode || url.searchParams.get("mode") || "auto";
  const city = body.city || url.searchParams.get("city") || prefs.weatherCity || prefs.city || null;
  const lat = body.lat ?? url.searchParams.get("lat") ?? prefs.lat ?? null;
  const lon = body.lon ?? url.searchParams.get("lon") ?? prefs.lon ?? null;
  const force = Boolean(body.force || url.searchParams.get("force") === "1");
  return { timeZone, mode, city, lat, lon, force };
}

async function loadCached(db, userId, mode, dayKey) {
  return db
    .prepare(
      "SELECT id, mode, day_key, summary, payload_json, source, created_at FROM briefings WHERE user_id = ? AND mode = ? AND day_key = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(userId, mode, dayKey)
    .first();
}

async function saveBriefing(db, userId, briefing) {
  const id = uid("brief");
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO briefings (id, user_id, mode, day_key, summary, payload_json, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      briefing.mode,
      briefing.dayKey,
      briefing.summary,
      JSON.stringify({
        context: briefing.context,
        timeZone: briefing.timeZone,
        generatedAt: briefing.generatedAt,
      }),
      briefing.source,
      ts,
    )
    .run();
  return id;
}

async function handleBriefing(context, { force = false, body = {} } = {}) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  await dispatchDueReminders(db, context.env, user);

  const prefs = await prefsForUser(db, user.id);
  const opts = optionsFromRequest(context.request, body, prefs);
  const mode = resolveMode(opts.mode, opts.timeZone);
  const dayKey = dayKeyInTz(new Date(), opts.timeZone);

  if (!force) {
    const cached = await loadCached(db, user.id, mode, dayKey);
    if (cached?.summary) {
      let payload = {};
      try {
        payload = cached.payload_json ? JSON.parse(cached.payload_json) : {};
      } catch {
        payload = {};
      }
      return json({
        ok: true,
        cached: true,
        briefing: {
          id: cached.id,
          mode: cached.mode,
          dayKey: cached.day_key,
          summary: cached.summary,
          source: cached.source || "cache",
          timeZone: payload.timeZone || opts.timeZone,
          context: payload.context || null,
          generatedAt: cached.created_at,
        },
      });
    }
  }

  const briefing = await buildBriefing(db, context.env, user, {
    mode,
    timeZone: opts.timeZone,
    city: opts.city,
    lat: opts.lat,
    lon: opts.lon,
  });
  const id = await saveBriefing(db, user.id, briefing);
  await writeAudit(db, { userId: user.id, action: "briefing.generate", resourceType: "briefing", resourceId: id, meta: { mode: briefing.mode } });

  return json({
    ok: true,
    cached: false,
    briefing: { id, ...briefing },
  });
}

export async function onRequestGet(context) {
  return handleBriefing(context);
}

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  return handleBriefing(context, { force: Boolean(body.force), body });
}
