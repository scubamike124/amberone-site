/**
 * AmberOne Phase 1 core-feature verification.
 *
 * Exercises auth, Talk (with conversation continuity + tool calling), memories,
 * calendar, reminders, notifications, onboarding, audit logs, and connections
 * against a running AmberOne instance (local wrangler dev or a live deployment).
 *
 * Usage:
 *   AMBERONE_URL=https://amberone.pages.dev node scripts/verify-phase1-core.mjs
 *   node scripts/verify-phase1-core.mjs   # defaults to http://127.0.0.1:8788
 *
 * Never prints secrets. Writes docs/PHASE1-CORE-VERIFY.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = process.env.AMBERONE_URL || "http://127.0.0.1:8788";
const root = process.cwd();

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length) return list.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function req(pathname, init = {}, cookie = "") {
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON response
  }
  return { path: pathname, status: res.status, ok: res.status < 400, json, cookie: cookiesFrom(res) };
}

const steps = [];
function step(name, ok, detail = {}) {
  steps.push({ name, ok, ...detail });
  console.log(JSON.stringify({ step: name, ok, ...detail }));
}

const stamp = Date.now();
const email = `phase1_${stamp}@example.com`;
const password = "Phase1Verify123!";

// 1) Signup
const signup = await req("/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ email, password, name: "Phase1 Tester" }),
});
let cookie = signup.cookie || "";
step("signup", signup.ok && Boolean(signup.json?.user?.id), { status: signup.status });
const userId = signup.json?.user?.id || null;

// 2) Login (fresh session, in case signup cookie is missing on this runtime)
const login = await req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
cookie = login.cookie || cookie;
step("login", login.ok, { status: login.status });

const me = await req("/api/auth/me", {}, cookie);
step("session valid", me.ok && me.json?.user?.email === email, { status: me.status });

// 3) Talk round-trip with conversation continuity
const talk1 = await req(
  "/api/talk",
  { method: "POST", body: JSON.stringify({ message: "Hi Amber, please remember that my favorite color is amber gold. Save that as a memory." }) },
  cookie,
);
const conversationId = talk1.json?.conversationId || null;
step("talk turn 1", talk1.ok && Boolean(talk1.json?.reply) && Boolean(conversationId), {
  status: talk1.status,
  source: talk1.json?.source || null,
  conversationId,
  toolsUsed: (talk1.json?.toolsUsed || []).map((t) => t.name),
});

const talk2 = await req(
  "/api/talk",
  { method: "POST", body: JSON.stringify({ message: "What did I just ask you to remember?", conversationId }) },
  cookie,
);
step("talk turn 2 (same conversation)", talk2.ok && talk2.json?.conversationId === conversationId, {
  status: talk2.status,
  conversationId: talk2.json?.conversationId || null,
});

// 4) Memory via direct API
const memCreate = await req(
  "/api/memories",
  { method: "POST", body: JSON.stringify({ title: "Verify memory", content: "Created by verify-phase1-core.mjs", kind: "note", importance: 2 }) },
  cookie,
);
step("create memory via API", memCreate.ok && Boolean(memCreate.json?.memory?.id), { status: memCreate.status });

const memList = await req("/api/memories", {}, cookie);
const memoryFromTalk = (memList.json?.memories || []).some((m) => /amber gold|favorite color/i.test(`${m.title} ${m.content}`));
step("memory via talk tool present", memoryFromTalk, {
  status: memList.status,
  totalMemories: (memList.json?.memories || []).length,
  note: memoryFromTalk ? undefined : "Talk may not have called save_memory this run — depends on model behavior; direct API memory still verified above.",
});

// 5) Calendar event
const eventStart = new Date(Date.now() + 1000 * 60 * 60 * 3).toISOString();
const eventCreate = await req(
  "/api/calendar",
  { method: "POST", body: JSON.stringify({ title: "Verify event", starts_at: eventStart, location: "Verification Suite" }) },
  cookie,
);
step("create calendar event", eventCreate.ok && Boolean(eventCreate.json?.event?.id), { status: eventCreate.status });

const eventsList = await req("/api/calendar", {}, cookie);
step("list calendar events", eventsList.ok && (eventsList.json?.events || []).length > 0, { status: eventsList.status });

// 6) Reminder due in the past — should dispatch immediately and create a notification
const pastDue = new Date(Date.now() - 1000 * 60 * 5).toISOString();
const reminderCreate = await req(
  "/api/reminders",
  { method: "POST", body: JSON.stringify({ title: "Verify reminder", due_at: pastDue, channel: "app" }) },
  cookie,
);
step("create reminder (past due)", reminderCreate.ok && Boolean(reminderCreate.json?.reminder?.id), {
  status: reminderCreate.status,
  dispatchedOnCreate: (reminderCreate.json?.dispatched || []).length,
});

// 7) Notifications — the past-due reminder should have produced one
const notifications = await req("/api/notifications", {}, cookie);
step("notifications after reminder dispatch", notifications.ok && (notifications.json?.unreadCount || 0) > 0, {
  status: notifications.status,
  unreadCount: notifications.json?.unreadCount ?? null,
});

// 8) Home aggregate
const home = await req("/api/home", {}, cookie);
step(
  "home aggregate",
  Boolean(home.ok && home.json?.reminders && home.json?.today && home.json?.notifications && home.json?.onboarding),
  { status: home.status },
);

// 9) Onboarding steps
const onboardGet = await req("/api/onboarding", {}, cookie);
step("onboarding GET", onboardGet.ok && Boolean(onboardGet.json?.step), { status: onboardGet.status, onboardingStep: onboardGet.json?.step });

const onboardPost = await req(
  "/api/onboarding",
  { method: "POST", body: JSON.stringify({ step: "plan" }) },
  cookie,
);
step("onboarding step transition", onboardPost.ok && onboardPost.json?.step === "plan", { status: onboardPost.status });

const onboardComplete = await req(
  "/api/onboarding",
  { method: "POST", body: JSON.stringify({ complete: true, prefs: { memoryPermission: "full" } }) },
  cookie,
);
step("onboarding complete", onboardComplete.ok && onboardComplete.json?.complete === true, { status: onboardComplete.status });

// 10) Audit log entries present
const audit = await req("/api/audit", {}, cookie);
step("audit log entries present", audit.ok && (audit.json?.logs || []).length > 0, {
  status: audit.status,
  count: (audit.json?.logs || []).length,
});

// 11) Connections — must not 500 even without Composio configured
const connections = await req("/api/connections", {}, cookie);
step("connections GET does not 500", connections.status !== 500, {
  status: connections.status,
  composioConfigured: connections.json?.composioConfigured ?? null,
});

// Prefer new connected-services path for connect readiness
const services = await req("/api/connected-services", {}, cookie);
step("connected-services GET", services.ok, {
  status: services.status,
  composioConfigured: services.json?.composioConfigured ?? null,
});

// 12) Notes + shopping lists
const noteCreate = await req(
  "/api/notes",
  { method: "POST", body: JSON.stringify({ title: "Verify note", body: "Created by verify-phase1-core.mjs" }) },
  cookie,
);
step("create note", noteCreate.ok && Boolean(noteCreate.json?.note?.id), { status: noteCreate.status });

const notesList = await req("/api/notes", {}, cookie);
step("list notes", notesList.ok && (notesList.json?.notes || []).length > 0, { status: notesList.status });

const listCreate = await req(
  "/api/lists",
  {
    method: "POST",
    body: JSON.stringify({ title: "Verify shopping", kind: "shopping", items: [{ text: "Milk" }, { text: "Eggs" }] }),
  },
  cookie,
);
const listId = listCreate.json?.list?.id || null;
step("create shopping list", listCreate.ok && Boolean(listId) && (listCreate.json?.list?.items || []).length >= 2, {
  status: listCreate.status,
  listId,
});

const listAdd = await req(
  "/api/lists",
  { method: "POST", body: JSON.stringify({ list_id: listId, text: "Bread" }) },
  cookie,
);
step("add list item", listAdd.ok && (listAdd.json?.list?.items || []).some((i) => /Bread/i.test(i.text || "")), {
  status: listAdd.status,
});

const itemId = (listAdd.json?.list?.items || []).find((i) => /Bread/i.test(i.text || ""))?.id;
const listToggle = await req(
  "/api/lists",
  { method: "PATCH", body: JSON.stringify({ item_id: itemId, checked: true }) },
  cookie,
);
step("complete list item", listToggle.ok && (listToggle.json?.list?.items || []).some((i) => i.id === itemId && i.checked), {
  status: listToggle.status,
});

// 13) Daily briefing / evening recap
const briefing = await req("/api/briefing?mode=morning&timeZone=America/Los_Angeles", {}, cookie);
step(
  "briefing generate",
  briefing.ok && Boolean(briefing.json?.briefing?.summary) && Boolean(briefing.json?.briefing?.mode),
  {
    status: briefing.status,
    mode: briefing.json?.briefing?.mode || null,
    source: briefing.json?.briefing?.source || null,
    cached: briefing.json?.cached ?? null,
  },
);

const briefingCached = await req("/api/briefing?mode=morning&timeZone=America/Los_Angeles", {}, cookie);
step("briefing cache hit", briefingCached.ok && briefingCached.json?.cached === true, {
  status: briefingCached.status,
  cached: briefingCached.json?.cached ?? null,
});

const evening = await req(
  "/api/briefing",
  { method: "POST", body: JSON.stringify({ mode: "evening", timeZone: "America/Los_Angeles", force: true }) },
  cookie,
);
step("evening recap generate", evening.ok && evening.json?.briefing?.mode === "evening" && Boolean(evening.json?.briefing?.summary), {
  status: evening.status,
  mode: evening.json?.briefing?.mode || null,
});

// 14) Logout sanity
const logout = await req("/api/auth/logout", { method: "POST", body: "{}" }, cookie);
step("logout", logout.ok, { status: logout.status });

const failed = steps.filter((s) => !s.ok);
const report = {
  at: new Date().toISOString(),
  base,
  email,
  userId,
  passed: steps.filter((s) => s.ok).length,
  total: steps.length,
  failed: failed.map((f) => f.name),
  steps,
};

mkdirSync(path.join(root, "docs"), { recursive: true });
writeFileSync(path.join(root, "docs/PHASE1-CORE-VERIFY.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: { passed: report.passed, total: report.total, failed: report.failed }, reportPath: "docs/PHASE1-CORE-VERIFY.json" }, null, 2));
if (failed.length) process.exit(1);
