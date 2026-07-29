import { ensureSchema, getUserFromRequest, json, publicUser, nowIso } from "../_lib/core.js";
import { dispatchDueReminders } from "./reminders.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  await dispatchDueReminders(db, context.env, user);

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const weekEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7)).toISOString();

  const [
    todayEvents,
    weekEvents,
    pendingReminders,
    unreadNotifications,
    recentMemories,
    recentNotes,
    openTasks,
    recentConversations,
    onboarding,
    connections,
    appointments,
    automations,
    teams,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT id, title, starts_at, ends_at, all_day, location FROM calendar_events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at ASC LIMIT 20",
      )
      .bind(user.id, todayStart, todayEnd)
      .all(),
    db
      .prepare(
        "SELECT id, title, starts_at, ends_at, location FROM calendar_events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at ASC LIMIT 8",
      )
      .bind(user.id, todayStart, weekEnd)
      .all(),
    db
      .prepare("SELECT id, title, due_at, status FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 10")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT id, kind, title, body, href, created_at FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 10")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT id, kind, title, content, importance, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 8")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT id, title, body, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 6")
      .bind(user.id)
      .all(),
    db
      .prepare(
        `SELECT li.id, li.text, li.checked, l.title AS list_title, li.updated_at
         FROM list_items li JOIN lists l ON l.id = li.list_id
         WHERE li.user_id = ? AND li.checked = 0
         ORDER BY li.updated_at DESC LIMIT 10`,
      )
      .bind(user.id)
      .all()
      .catch(() => ({ results: [] })),
    db
      .prepare("SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 6")
      .bind(user.id)
      .all(),
    db.prepare("SELECT step, completed_at, prefs_json FROM onboarding_state WHERE user_id = ?").bind(user.id).first(),
    db
      .prepare("SELECT toolkit, status, updated_at FROM connected_accounts WHERE user_id = ? ORDER BY created_at DESC")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT id, title, starts_at, status FROM appointments WHERE user_id = ? AND starts_at >= ? ORDER BY starts_at ASC LIMIT 5")
      .bind(user.id, todayStart)
      .all()
      .catch(() => ({ results: [] })),
    db
      .prepare("SELECT id, title, enabled, updated_at FROM automations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5")
      .bind(user.id)
      .all()
      .catch(() => ({ results: [] })),
    db
      .prepare(
        "SELECT t.id, t.name, t.plan_slug FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 3",
      )
      .bind(user.id)
      .all()
      .catch(() => ({ results: [] })),
  ]);

  const connItems = connections.results || [];
  const gcal = connItems.some((c) => c.toolkit === "googlecalendar" && /active/i.test(String(c.status || "")));
  const gmail = connItems.some((c) => c.toolkit === "gmail" && /active/i.test(String(c.status || "")));
  const events = todayEvents.results || [];
  const reminders = pendingReminders.results || [];
  const notifs = unreadNotifications.results || [];
  const memories = recentMemories.results || [];
  const notes = recentNotes.results || [];
  const tasks = openTasks.results || [];

  const suggestions = [];
  if (!onboarding?.completed_at) suggestions.push({ id: "onboard", text: "Finish onboarding so Amber can personalize your briefings.", href: "/dashboard/onboarding" });
  if (!gcal) suggestions.push({ id: "gcal", text: "Connect Google Calendar for live schedule sync.", href: "/dashboard/connections" });
  if (!gmail) suggestions.push({ id: "gmail", text: "Connect Gmail for inbox summaries in your briefing.", href: "/dashboard/connections" });
  if (!user.plan_slug) suggestions.push({ id: "plan", text: "Choose a plan to unlock Family, Executive, or Business dashboards.", href: "/pricing" });
  if (reminders.length) suggestions.push({ id: "rem", text: `Review ${reminders.length} pending reminder${reminders.length === 1 ? "" : "s"}.`, href: "/dashboard/reminders" });
  if (events.length) suggestions.push({ id: "cal", text: `You have ${events.length} event${events.length === 1 ? "" : "s"} today — prep the next one.`, href: "/dashboard/calendar" });
  if (tasks.length) suggestions.push({ id: "tasks", text: `${tasks.length} open list item${tasks.length === 1 ? "" : "s"} waiting.`, href: "/dashboard/notes" });
  if (!suggestions.length) suggestions.push({ id: "ok", text: "You're in good shape. Ask Amber what's next.", href: "#talk" });

  const hour = now.getUTCHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const apiHealth = {
    openai: Boolean(context.env.OPENAI_API_KEY),
    stripe: Boolean(context.env.STRIPE_SECRET_KEY),
    resend: Boolean(context.env.RESEND_API_KEY),
    composio: Boolean(context.env.COMPOSIO_API_KEY),
    d1: true,
  };
  const apiOkCount = Object.values(apiHealth).filter(Boolean).length;
  const apiTotal = Object.keys(apiHealth).length;

  return json({
    user: publicUser(user),
    greeting: { text: greeting, name: user.name || null },
    generatedAt: nowIso(),
    today: { events },
    calendar: { upcoming: weekEvents.results || [] },
    reminders: { pending: reminders },
    notifications: { unread: notifs, unreadCount: notifs.length },
    memories: { items: memories, count: memories.length },
    notes: { items: notes, count: notes.length },
    tasks: { items: tasks, count: tasks.length },
    conversations: { items: recentConversations.results || [] },
    appointments: { upcoming: appointments.results || [] },
    automations: { items: automations.results || [] },
    teams: { items: teams.results || [] },
    onboarding: {
      step: onboarding?.step || "welcome",
      complete: Boolean(onboarding?.completed_at),
      completedAt: onboarding?.completed_at || null,
    },
    connections: {
      items: connItems,
      googleCalendarConnected: gcal,
      gmailConnected: gmail,
    },
    suggestions: suggestions.slice(0, 5),
    health: {
      apis: apiHealth,
      apiScore: Math.round((apiOkCount / apiTotal) * 100),
      website: { status: "ok", label: "AmberOne live" },
      security: { status: "ok", label: "Session secured · HTTPS" },
      business: {
        plan: user.plan_slug || null,
        subscriptionStatus: user.subscription_status || "none",
        appointments: (appointments.results || []).length,
      },
    },
    learning: {
      items: memories.slice(0, 3).map((m) => ({
        title: m.title || "Memory",
        summary: (m.content || "").slice(0, 120),
        at: m.updated_at,
      })),
    },
    revenue: {
      plan: user.plan_slug || null,
      status: user.subscription_status || "none",
      note: user.plan_slug ? "Active subscription" : "No plan yet",
    },
  });
}
