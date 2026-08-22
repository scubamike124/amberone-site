import {
  createNotification,
  ensureSchema,
  getUserFromRequest,
  json,
  nowIso,
  readJson,
  uid,
  writeAudit,
} from "../_lib/core.js";
import { userIsTeamMember } from "../_lib/team-gate.js";

const RECURRENCE = new Set(["", "none", "daily", "weekly", "monthly", "yearly"]);

function parseAttendees(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return { name: item.trim(), email: null };
        const name = String(item?.name || item?.email || "").trim();
        const email = item?.email ? String(item.email).trim().toLowerCase() : null;
        return name || email ? { name: name || email, email } : null;
      })
      .filter(Boolean)
      .slice(0, 40);
  }
  return String(value)
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map((name) => ({ name, email: null }));
}

async function eventVisibleToUser(db, user, event) {
  if (!event) return false;
  if (event.user_id === user.id) return true;
  if (event.visibility === "shared" && event.team_id) {
    return userIsTeamMember(db, user.id, event.team_id);
  }
  return false;
}

async function loadEvent(db, id) {
  return db.prepare("SELECT * FROM calendar_events WHERE id = ?").bind(id).first();
}

async function syncEventReminder(db, user, event, remindMinutes) {
  const minutes = Number(remindMinutes);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const start = Date.parse(event.starts_at);
  if (!Number.isFinite(start)) return null;
  const dueAt = new Date(start - minutes * 60 * 1000).toISOString();
  const existing = await db
    .prepare("SELECT id FROM reminders WHERE user_id = ? AND calendar_event_id = ? AND status = 'pending' LIMIT 1")
    .bind(user.id, event.id)
    .first();
  const ts = nowIso();
  if (existing) {
    await db
      .prepare("UPDATE reminders SET title = ?, body = ?, due_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(`Upcoming: ${event.title}`, event.description || event.location || null, dueAt, ts, existing.id, user.id)
      .run();
    return existing.id;
  }
  const id = uid("rem");
  await db
    .prepare(
      `INSERT INTO reminders (id, user_id, title, body, due_at, status, channel, notify_email, calendar_event_id, sent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 'app', NULL, ?, NULL, ?, ?)`,
    )
    .bind(id, user.id, `Upcoming: ${event.title}`, event.description || event.location || null, dueAt, event.id, ts, ts)
    .run();
  return id;
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const from = url.searchParams.get("from") || new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
  const to = url.searchParams.get("to") || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  const scope = url.searchParams.get("scope");

  const rows = await db
    .prepare(
      `SELECT e.id, e.user_id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.all_day,
              e.recurrence, e.attendees, e.visibility, e.team_id, e.external_id, e.external_source,
              e.created_at, e.updated_at
       FROM calendar_events e
       WHERE e.starts_at >= ? AND e.starts_at <= ?
         AND (
           e.user_id = ?
           OR (
             COALESCE(e.visibility, 'private') = 'shared'
             AND e.team_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM team_members tm
               WHERE tm.team_id = e.team_id AND tm.user_id = ? AND tm.status = 'active'
             )
           )
         )
       ORDER BY e.starts_at ASC
       LIMIT ?`,
    )
    .bind(from, to, user.id, user.id, limit)
    .all();

  let events = rows.results || [];
  if (scope === "shared") {
    events = events.filter((e) => e.visibility === "shared");
  } else if (scope === "mine") {
    events = events.filter((e) => e.user_id === user.id);
  }

  return json({ events, range: { from, to } });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const title = String(body.title || "").trim();
  const startsAt = body.starts_at || body.startsAt;
  if (!title || !startsAt) return json({ error: "title and starts_at are required" }, 400);

  const visibility = body.visibility === "shared" ? "shared" : "private";
  let teamId = body.team_id || body.teamId || null;
  if (visibility === "shared") {
    if (teamId && !(await userIsTeamMember(db, user.id, teamId))) {
      return json({ error: "Not a member of that team" }, 403);
    }
    if (!teamId) {
      const team = await db
        .prepare(
          "SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 1",
        )
        .bind(user.id)
        .first();
      teamId = team?.id || null;
      if (!teamId) return json({ error: "Create or join a team before sharing a calendar event" }, 400);
    }
  } else {
    teamId = null;
  }

  const recurrenceRaw = String(body.recurrence || "").trim().toLowerCase();
  const recurrence = RECURRENCE.has(recurrenceRaw) ? (recurrenceRaw === "none" ? null : recurrenceRaw || null) : null;
  const attendees = parseAttendees(body.attendees || body.people);
  const id = uid("evt");
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, recurrence, attendees, visibility, team_id, external_id, external_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      user.id,
      title.slice(0, 200),
      body.description || null,
      body.location || null,
      String(startsAt),
      body.ends_at || body.endsAt || null,
      body.all_day || body.allDay ? 1 : 0,
      recurrence,
      attendees.length ? JSON.stringify(attendees) : null,
      visibility,
      teamId,
      null,
      null,
      ts,
      ts,
    )
    .run();

  const event = await loadEvent(db, id);
  const reminderId = await syncEventReminder(db, user, event, body.remind_minutes ?? body.remindMinutes);
  if (visibility === "shared" && teamId) {
    const members = await db
      .prepare("SELECT user_id FROM team_members WHERE team_id = ? AND status = 'active' AND user_id IS NOT NULL AND user_id != ?")
      .bind(teamId, user.id)
      .all();
    for (const member of members.results || []) {
      await createNotification(db, {
        userId: member.user_id,
        kind: "calendar",
        title: `Shared event: ${event.title}`,
        body: event.starts_at,
        href: "/dashboard/calendar",
      });
    }
  }

  await writeAudit(db, { userId: user.id, action: "calendar_event.create", resourceType: "calendar_event", resourceId: id });
  return json({ ok: true, event, reminderId }, 201);
}

export async function onRequestPatch(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const id = String(body.id || "");
  if (!id) return json({ error: "id is required" }, 400);

  const existing = await loadEvent(db, id);
  if (!existing || !(await eventVisibleToUser(db, user, existing))) return json({ error: "Event not found" }, 404);
  if (existing.user_id !== user.id) return json({ error: "Only the event owner can edit this event" }, 403);

  let visibility = existing.visibility || "private";
  let teamId = existing.team_id;
  if (body.visibility !== undefined) {
    visibility = body.visibility === "shared" ? "shared" : "private";
  }
  if (visibility === "shared") {
    teamId = body.team_id || body.teamId || existing.team_id;
    if (teamId && !(await userIsTeamMember(db, user.id, teamId))) {
      return json({ error: "Not a member of that team" }, 403);
    }
    if (!teamId) {
      const team = await db
        .prepare(
          "SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 1",
        )
        .bind(user.id)
        .first();
      teamId = team?.id || null;
      if (!teamId) return json({ error: "Create or join a team before sharing a calendar event" }, 400);
    }
  } else {
    teamId = null;
  }

  const recurrenceRaw = body.recurrence !== undefined ? String(body.recurrence || "").trim().toLowerCase() : null;
  const next = {
    title: body.title !== undefined ? String(body.title).slice(0, 200) : existing.title,
    description: body.description !== undefined ? body.description : existing.description,
    location: body.location !== undefined ? body.location : existing.location,
    starts_at: body.starts_at || body.startsAt || existing.starts_at,
    ends_at: body.ends_at !== undefined ? body.ends_at : body.endsAt !== undefined ? body.endsAt : existing.ends_at,
    all_day: body.all_day !== undefined ? (body.all_day ? 1 : 0) : body.allDay !== undefined ? (body.allDay ? 1 : 0) : existing.all_day,
    recurrence:
      recurrenceRaw === null
        ? existing.recurrence
        : RECURRENCE.has(recurrenceRaw)
          ? recurrenceRaw === "none" || !recurrenceRaw
            ? null
            : recurrenceRaw
          : existing.recurrence,
    attendees:
      body.attendees !== undefined || body.people !== undefined
        ? JSON.stringify(parseAttendees(body.attendees || body.people))
        : existing.attendees,
    visibility,
    team_id: teamId,
  };

  await db
    .prepare(
      `UPDATE calendar_events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, recurrence = ?, attendees = ?, visibility = ?, team_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
    .bind(
      next.title,
      next.description,
      next.location,
      next.starts_at,
      next.ends_at,
      next.all_day,
      next.recurrence,
      next.attendees,
      next.visibility,
      next.team_id,
      nowIso(),
      id,
      user.id,
    )
    .run();

  const event = await loadEvent(db, id);
  if (body.remind_minutes !== undefined || body.remindMinutes !== undefined || body.starts_at || body.startsAt) {
    await syncEventReminder(db, user, event, body.remind_minutes ?? body.remindMinutes ?? 30);
  }

  await writeAudit(db, { userId: user.id, action: "calendar_event.update", resourceType: "calendar_event", resourceId: id });
  return json({ ok: true, event });
}

export async function onRequestDelete(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const url = new URL(context.request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id query parameter required" }, 400);

  const existing = await loadEvent(db, id);
  if (!existing || existing.user_id !== user.id) return json({ error: "Event not found" }, 404);

  await db.prepare("DELETE FROM calendar_events WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  await db
    .prepare("DELETE FROM reminders WHERE calendar_event_id = ? AND user_id = ? AND status = 'pending'")
    .bind(id, user.id)
    .run();
  await writeAudit(db, { userId: user.id, action: "calendar_event.delete", resourceType: "calendar_event", resourceId: id });

  return json({ ok: true });
}
