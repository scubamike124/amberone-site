import { ensureSchema, getUserFromRequest, json, nowIso, readJson } from "../_lib/core.js";

function publicProfile(row) {
  if (!row) return null;
  return {
    name: row.name || "",
    sells: row.sells || "",
    audience: row.audience || "",
    offer: row.offer || "",
    tone: row.tone || "",
    location: row.location || "",
    objective: row.objective || "",
    updatedAt: row.updated_at || null,
  };
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const row = await db.prepare("SELECT * FROM business_profiles WHERE user_id = ?").bind(user.id).first();
  return json({ profile: publicProfile(row) });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const body = await readJson(context.request);
  const ts = nowIso();
  const fields = {
    name: String(body.name || "").trim(),
    sells: String(body.sells || "").trim(),
    audience: String(body.audience || "").trim(),
    offer: String(body.offer || "").trim(),
    tone: String(body.tone || "").trim(),
    location: String(body.location || "").trim(),
    objective: String(body.objective || "").trim(),
  };
  if (fields.name.length < 2 || fields.sells.length < 12 || fields.audience.length < 8 || fields.offer.length < 8) {
    return json({ error: "Amber needs the business name, what you sell, who it is for, and the offer." }, 400);
  }
  const existing = await db.prepare("SELECT user_id FROM business_profiles WHERE user_id = ?").bind(user.id).first();
  if (existing) {
    await db
      .prepare(
        `UPDATE business_profiles
         SET name = ?, sells = ?, audience = ?, offer = ?, tone = ?, location = ?, objective = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .bind(fields.name, fields.sells, fields.audience, fields.offer, fields.tone, fields.location, fields.objective, ts, user.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO business_profiles (user_id, name, sells, audience, offer, tone, location, objective, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(user.id, fields.name, fields.sells, fields.audience, fields.offer, fields.tone, fields.location, fields.objective, ts, ts)
      .run();
  }
  const row = await db.prepare("SELECT * FROM business_profiles WHERE user_id = ?").bind(user.id).first();
  return json({ ok: true, profile: publicProfile(row) });
}
