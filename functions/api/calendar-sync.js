import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";
import { executeTool, isComposioConfigured, listConnectedAccounts } from "../_lib/composio.js";
import {
  getGoogleAccessToken,
  isGoogleCalendarOAuthConfigured,
  listGoogleCalendarEvents,
  parseConnectionMeta,
} from "../_lib/google-calendar.js";

const GOOGLE_CALENDAR_TOOLKIT = "googlecalendar";
const LIST_EVENTS_TOOL = "GOOGLECALENDAR_EVENTS_LIST";

/** Composio tool responses vary by SDK version; find the first array that looks like events. */
function findEventArray(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload?.data?.items,
    payload?.data?.data?.items,
    payload?.data?.events,
    payload?.data?.event_data?.event_data,
    payload?.items,
    payload?.events,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length && (c[0].id || c[0].summary || c[0].start)) return c;
    if (Array.isArray(c)) return c;
  }
  return [];
}

function pickTime(node) {
  if (!node) return null;
  return node.dateTime || node.date_time || node.date || null;
}

/** Prefer Pacific wall-clock window so Google Calendar date ranges align. */
function defaultWindow() {
  const from = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);
  const to = new Date(Date.now() + 1000 * 60 * 60 * 24 * 60);
  // America/Los_Angeles is PDT (-07:00) in summer; good enough for sync window
  const fmt = (d) => {
    const iso = new Date(d.getTime() - 7 * 3600e3).toISOString().replace(/\.\d{3}Z$/, "-07:00");
    return iso;
  };
  return { timeMin: fmt(from), timeMax: fmt(to) };
}

async function resolveActiveGoogleCalendarAccount(env, db, userId) {
  // Prefer ACTIVE remote Composio account, then fall back to newest local row
  let remoteActiveId = null;
  try {
    const remote = await listConnectedAccounts(env, userId, { toolkitSlugs: [GOOGLE_CALENDAR_TOOLKIT] });
    const items = remote?.items || remote?.data || [];
    const active = items.find((i) => String(i.status || "").toUpperCase() === "ACTIVE");
    if (active?.id) remoteActiveId = active.id;
  } catch {
    // ignore — fall back to local
  }

  let connection = await db
    .prepare(
      `SELECT id, composio_connected_account_id, status, metadata_json FROM connected_accounts
       WHERE user_id = ? AND toolkit = ?
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId, GOOGLE_CALENDAR_TOOLKIT)
    .first();

  if (remoteActiveId && connection) {
    if (connection.composio_connected_account_id !== remoteActiveId) {
      await db
        .prepare(
          "UPDATE connected_accounts SET composio_connected_account_id = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?",
        )
        .bind(remoteActiveId, nowIso(), connection.id)
        .run();
      connection = { ...connection, composio_connected_account_id: remoteActiveId, status: "ACTIVE" };
    }
  }

  return connection;
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const defaults = defaultWindow();
  const timeMin = body.from || defaults.timeMin;
  const timeMax = body.to || defaults.timeMax;

  const connection = await resolveActiveGoogleCalendarAccount(context.env, db, user.id);
  if (!connection) {
    return json({ error: "Google Calendar is not connected yet. Visit Connections to link it." }, 400);
  }

  let events = [];
  let via = "composio";

  const nativeMeta = parseConnectionMeta(connection);
  if (isGoogleCalendarOAuthConfigured(context.env) && (nativeMeta.refresh_token || nativeMeta.access_token)) {
    try {
      const token = await getGoogleAccessToken(context.env, db, connection);
      if (token?.accessToken) {
        events = await listGoogleCalendarEvents(token.accessToken, { timeMin, timeMax });
        via = "google";
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, err?.status || 502);
    }
  }

  if (via !== "google") {
    if (!isComposioConfigured(context.env)) {
      return json(
        {
          error:
            "Google Calendar is not fully connected yet. Open Connections and connect Google Calendar, then Sync.",
        },
        503,
      );
    }
    if (!connection.composio_connected_account_id) {
      return json({ error: "Google Calendar is not connected yet. Visit Connections to link it." }, 400);
    }
    let toolResult;
    try {
      toolResult = await executeTool(context.env, {
        slug: LIST_EVENTS_TOOL,
        userId: user.id,
        connectedAccountId: connection.composio_connected_account_id,
        arguments: {
          calendarId: "primary",
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 100,
        },
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, err?.status || 502);
    }
    events = findEventArray(toolResult);
  }

  const ts = nowIso();
  let synced = 0;

  for (const evt of events) {
    const externalId = evt.id || evt.eventId || evt.event_id;
    if (!externalId) continue;
    const title = evt.summary || evt.title || "(untitled event)";
    const startsAt = pickTime(evt.start) || evt.starts_at;
    if (!startsAt) continue;
    const endsAt = pickTime(evt.end) || evt.ends_at || null;
    const allDay = Boolean(evt.start?.date && !evt.start?.dateTime);

    const existing = await db
      .prepare("SELECT id FROM calendar_events WHERE user_id = ? AND external_source = ? AND external_id = ?")
      .bind(user.id, GOOGLE_CALENDAR_TOOLKIT, externalId)
      .first();

    if (existing) {
      await db
        .prepare(
          "UPDATE calendar_events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, updated_at = ? WHERE id = ?",
        )
        .bind(title, evt.description || null, evt.location || null, startsAt, endsAt, allDay ? 1 : 0, ts, existing.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, recurrence, external_id, external_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uid("evt"),
          user.id,
          title,
          evt.description || null,
          evt.location || null,
          startsAt,
          endsAt,
          allDay ? 1 : 0,
          null,
          externalId,
          GOOGLE_CALENDAR_TOOLKIT,
          ts,
          ts,
        )
        .run();
    }
    synced += 1;
  }

  await db
    .prepare("UPDATE connected_accounts SET status = 'ACTIVE', updated_at = ? WHERE id = ?")
    .bind(ts, connection.id)
    .run();

  await writeAudit(db, {
    userId: user.id,
    action: "calendar.sync",
    resourceType: "connected_account",
    resourceId: connection.id,
    meta: { synced, foundEvents: events.length, via },
  });

  return json({
    ok: true,
    synced,
    foundEvents: events.length,
    via,
    window: { from: timeMin, to: timeMax },
  });
}

export async function onRequestGet() {
  return json({ error: "POST { from?, to? } to sync Google Calendar" }, 405);
}
