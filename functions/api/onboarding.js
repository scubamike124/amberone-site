import { ensureSchema, getUserFromRequest, json, nowIso, readJson, writeAudit } from "../_lib/core.js";

const STEPS = ["welcome", "plan", "connect_calendar", "memory_prefs", "done"];

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const row = await db.prepare("SELECT step, completed_at, prefs_json, created_at, updated_at FROM onboarding_state WHERE user_id = ?").bind(user.id).first();
  if (!row) {
    return json({ step: "welcome", complete: false, completedAt: null, prefs: {}, steps: STEPS });
  }
  return json({
    step: row.step,
    complete: Boolean(row.completed_at),
    completedAt: row.completed_at,
    prefs: row.prefs_json ? JSON.parse(row.prefs_json) : {},
    steps: STEPS,
  });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const ts = nowIso();
  const existing = await db.prepare("SELECT prefs_json FROM onboarding_state WHERE user_id = ?").bind(user.id).first();

  const mergedPrefs = {
    ...(existing?.prefs_json ? JSON.parse(existing.prefs_json) : {}),
    ...(body.prefs && typeof body.prefs === "object" ? body.prefs : {}),
  };

  let step = body.step && STEPS.includes(body.step) ? body.step : existing ? undefined : "welcome";
  const complete = Boolean(body.complete);
  if (complete) step = "done";

  if (existing) {
    await db
      .prepare(
        `UPDATE onboarding_state SET
          step = COALESCE(?, step),
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          prefs_json = ?,
          updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(step || null, complete ? 1 : 0, ts, JSON.stringify(mergedPrefs), ts, user.id)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO onboarding_state (user_id, step, completed_at, prefs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(user.id, step || "welcome", complete ? ts : null, JSON.stringify(mergedPrefs), ts, ts)
      .run();
  }

  await writeAudit(db, { userId: user.id, action: "onboarding.update", meta: { step, complete } });

  const row = await db.prepare("SELECT step, completed_at, prefs_json FROM onboarding_state WHERE user_id = ?").bind(user.id).first();
  return json({
    ok: true,
    step: row.step,
    complete: Boolean(row.completed_at),
    completedAt: row.completed_at,
    prefs: row.prefs_json ? JSON.parse(row.prefs_json) : {},
  });
}
