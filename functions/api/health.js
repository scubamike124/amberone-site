import { ensureSchema, json } from "../_lib/core.js";



/** Production DB/binding probe — no secrets. */

export async function onRequestGet(context) {

  const db = context.env.DB;

  if (!db) {

    return json({ ok: false, db: false, error: "Database not configured" }, 503);

  }

  try {

    await ensureSchema(db);

    const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first();

    const tables = await db

      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")

      .all();

    return json({

      ok: true,

      db: true,

      userCount: row?.n ?? null,

      tables: (tables?.results || []).map((t) => t.name),

    });

  } catch (err) {

    return json(

      {

        ok: false,

        db: true,

        error: err instanceof Error ? err.message : String(err),

        name: err instanceof Error ? err.name : undefined,

      },

      500,

    );

  }

}

