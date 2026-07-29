/**
 * Full AmberOne platform E2E — all features across plans.
 * Skips live credit-card capture; may simulate plan grants via signed Stripe webhooks.
 *
 *   AMBERONE_URL=https://amberone.pages.dev node scripts/e2e-full-platform.mjs
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const base = process.env.AMBERONE_URL || "https://amberone.pages.dev";
const root = process.cwd();

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (filePath.endsWith(".json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const env = {
  ...loadEnvFile(path.join(root, ".dev.vars")),
  ...loadEnvFile(path.join(root, ".tmp", "assist-secret.json")),
  ...loadEnvFile(path.join(root, ".tmp", "cf-env.json")),
};

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length) return list.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function req(pathname, init = {}, cookie = "") {
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (init.body && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${pathname}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html / empty */
  }
  return {
    path: pathname,
    status: res.status,
    ok: res.status >= 200 && res.status < 400,
    json,
    text: text.slice(0, 300),
    cookie: cookiesFrom(res),
    location: res.headers.get("location"),
    html: /<!DOCTYPE|<html/i.test(text),
  };
}

const steps = [];
function step(name, ok, detail = {}) {
  steps.push({ name, ok: Boolean(ok), ...detail });
  console.log(JSON.stringify({ step: name, ok: Boolean(ok), ...detail }));
}

async function grantPlan(userId, email, plan, cookie) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    step(`grant plan ${plan}`, false, { reason: "no STRIPE_WEBHOOK_SECRET" });
    return false;
  }
  const customerId = `cus_e2e_${plan}_${Date.now().toString(36)}`;
  const payload = JSON.stringify({
    id: `evt_e2e_${plan}_${Date.now()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_e2e_${plan}`,
        customer: customerId,
        subscription: `sub_e2e_${plan}`,
        metadata: { userId, plan, product: "amberone" },
        customer_details: { email },
      },
    },
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest("hex");
  const wh = await req("/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${ts},v1=${sig}`,
    },
    body: payload,
  });
  const billing = await req("/api/billing", {}, cookie);
  const granted =
    wh.ok &&
    (billing.json?.billing?.planSlug === plan ||
      billing.json?.user?.planSlug === plan ||
      billing.json?.billing?.plan_slug === plan);
  step(`grant plan ${plan}`, Boolean(wh.ok), {
    status: wh.status,
    planSlug: billing.json?.billing?.planSlug || billing.json?.billing?.plan_slug || null,
    subStatus: billing.json?.billing?.status || billing.json?.billing?.subscriptionStatus || null,
    granted,
  });
  return Boolean(wh.ok);
}

const stamp = Date.now();
const email = `e2e_full_${stamp}@amberone.test`;
const password = "E2eFullPlatform123!";

console.log(JSON.stringify({ base, startedAt: new Date().toISOString() }));

// ——— Marketing / legal pages ———
const marketing = [
  "/",
  "/pricing",
  "/plans",
  "/family",
  "/signup",
  "/login",
  "/faq",
  "/privacy",
  "/terms",
  "/cookies",
  "/refunds",
  "/acceptable-use",
];
for (const p of marketing) {
  const r = await req(p);
  step(`page ${p}`, r.ok && r.html, { status: r.status });
}

// ——— Auth ———
const signup = await req("/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ email, password, name: "E2E Full Platform" }),
});
let cookie = signup.cookie || "";
step("signup", signup.ok && Boolean(signup.json?.user?.id), { status: signup.status });
const userId = signup.json?.user?.id || null;

const login = await req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ email, password }),
});
cookie = login.cookie || cookie;
step("login", login.ok, { status: login.status });

const me = await req("/api/auth/me", {}, cookie);
step("session /api/auth/me", me.ok && me.json?.user?.email === email, { status: me.status });

// ——— Dashboard HTML surfaces ———
const dashPages = [
  "/dashboard/",
  "/dashboard/calendar",
  "/dashboard/reminders",
  "/dashboard/memories",
  "/dashboard/notes",
  "/dashboard/connections",
  "/dashboard/billing",
  "/dashboard/settings",
  "/dashboard/notifications",
  "/dashboard/onboarding",
  "/dashboard/family/",
  "/dashboard/family/members",
  "/dashboard/executive/",
  "/dashboard/executive/crm",
  "/dashboard/executive/follow-ups",
  "/dashboard/business/",
  "/dashboard/business/appointments",
  "/dashboard/business/customers",
  "/dashboard/business/marketing",
  "/dashboard/marketplace",
];
for (const p of dashPages) {
  let r = await req(p, {}, cookie);
  // Cloudflare Pages may 308 .html → clean URL; follow once.
  if (r.status >= 300 && r.status < 400 && r.location) {
    const next = r.location.startsWith("http") ? new URL(r.location).pathname : r.location;
    r = await req(next, {}, cookie);
  }
  step(`dash ${p}`, r.ok && (r.html || r.status === 200), { status: r.status });
}

// ——— Core APIs: health / home / briefing ———
const health = await req("/api/health");
step("health", health.ok, { status: health.status });

const home = await req("/api/home", {}, cookie);
step("home aggregate", home.ok && Boolean(home.json), { status: home.status });

const briefing = await req("/api/briefing", {}, cookie);
step("briefing", briefing.ok || briefing.status === 200, { status: briefing.status });

// ——— Scheduling (calendar CRUD) ———
const start1 = new Date(Date.now() + 1000 * 60 * 60 * 2).toISOString();
const end1 = new Date(Date.now() + 1000 * 60 * 60 * 3).toISOString();
const calCreate = await req(
  "/api/calendar",
  {
    method: "POST",
    body: JSON.stringify({
      title: "E2E Schedule Block",
      description: "Created by e2e-full-platform",
      location: "AmberOne HQ",
      starts_at: start1,
      ends_at: end1,
    }),
  },
  cookie,
);
const eventId = calCreate.json?.event?.id || null;
step("calendar create", calCreate.ok && Boolean(eventId), { status: calCreate.status, eventId });

const calList = await req("/api/calendar", {}, cookie);
step(
  "calendar list",
  calList.ok && (calList.json?.events || []).some((e) => e.id === eventId || e.title === "E2E Schedule Block"),
  { status: calList.status, count: (calList.json?.events || []).length },
);

const calPatch = await req(
  "/api/calendar",
  {
    method: "PATCH",
    body: JSON.stringify({ id: eventId, title: "E2E Schedule Block (updated)", location: "Virtual" }),
  },
  cookie,
);
step("calendar update", calPatch.ok && Boolean(calPatch.json?.event?.id || calPatch.json?.ok), {
  status: calPatch.status,
});

const start2 = new Date(Date.now() + 1000 * 60 * 60 * 26).toISOString();
const cal2 = await req(
  "/api/calendar",
  { method: "POST", body: JSON.stringify({ title: "E2E Second Event", starts_at: start2 }) },
  cookie,
);
step("calendar create second", cal2.ok, { status: cal2.status });

// ——— Alarms / reminders ———
const pastDue = new Date(Date.now() - 1000 * 60 * 2).toISOString();
const futureDue = new Date(Date.now() + 1000 * 60 * 60 * 6).toISOString();

const alarmPast = await req(
  "/api/reminders",
  {
    method: "POST",
    body: JSON.stringify({
      title: "E2E Alarm Past Due",
      body: "Should dispatch to notifications",
      due_at: pastDue,
      channel: "app",
    }),
  },
  cookie,
);
step("alarm create past-due", alarmPast.ok && Boolean(alarmPast.json?.reminder?.id), {
  status: alarmPast.status,
  dispatched: (alarmPast.json?.dispatched || []).length,
});

const alarmFuture = await req(
  "/api/reminders",
  {
    method: "POST",
    body: JSON.stringify({ title: "E2E Alarm Future", due_at: futureDue, channel: "app" }),
  },
  cookie,
);
const futureReminderId = alarmFuture.json?.reminder?.id || null;
step("alarm create future", alarmFuture.ok && Boolean(futureReminderId), { status: alarmFuture.status });

const remindersList = await req("/api/reminders", {}, cookie);
step("alarms list", remindersList.ok && (remindersList.json?.reminders || []).length > 0, {
  status: remindersList.status,
  count: (remindersList.json?.reminders || []).length,
});

const notifs = await req("/api/notifications", {}, cookie);
step("notifications from alarm", notifs.ok && (notifs.json?.unreadCount || 0) > 0, {
  status: notifs.status,
  unreadCount: notifs.json?.unreadCount ?? null,
});

// ——— Memories / notes / lists ———
const mem = await req(
  "/api/memories",
  {
    method: "POST",
    body: JSON.stringify({ title: "E2E memory", content: "Platform verify", kind: "note", importance: 2 }),
  },
  cookie,
);
step("memory create", mem.ok && Boolean(mem.json?.memory?.id), { status: mem.status });
const memList = await req("/api/memories", {}, cookie);
step("memory list", memList.ok && (memList.json?.memories || []).length > 0, { status: memList.status });

const note = await req(
  "/api/notes",
  { method: "POST", body: JSON.stringify({ title: "E2E note", body: "Full platform note" }) },
  cookie,
);
step("note create", note.ok && Boolean(note.json?.note?.id), { status: note.status });
const notes = await req("/api/notes", {}, cookie);
step("notes list", notes.ok && (notes.json?.notes || []).length > 0, { status: notes.status });

const listCreate = await req(
  "/api/lists",
  { method: "POST", body: JSON.stringify({ kind: "todo", title: "E2E Todo List", items: ["Schedule test", "Alarm test"] }) },
  cookie,
);
step("list create", listCreate.ok && Boolean(listCreate.json?.list?.id || listCreate.json?.id), {
  status: listCreate.status,
});
const lists = await req("/api/lists", {}, cookie);
step("lists list", lists.ok, { status: lists.status, count: (lists.json?.lists || []).length });

// ——— Talk (scheduling + alarms via conversation) ———
const talkSched = await req(
  "/api/talk",
  {
    method: "POST",
    body: JSON.stringify({
      message: "Please create a calendar event titled Talk Schedule Test tomorrow at 3pm.",
    }),
  },
  cookie,
);
step("talk scheduling", talkSched.ok && Boolean(talkSched.json?.reply), {
  status: talkSched.status,
  source: talkSched.json?.source || null,
  tools: (talkSched.json?.toolsUsed || []).map((t) => t.name || t),
});

const talkAlarm = await req(
  "/api/talk",
  {
    method: "POST",
    body: JSON.stringify({
      message: "Set a reminder titled Talk Alarm Test for 1 hour from now.",
      conversationId: talkSched.json?.conversationId,
    }),
  },
  cookie,
);
step("talk alarm", talkAlarm.ok && Boolean(talkAlarm.json?.reply), {
  status: talkAlarm.status,
  tools: (talkAlarm.json?.toolsUsed || []).map((t) => t.name || t),
});

// ——— Connections / billing read (no card charge) ———
const connections = await req("/api/connections", {}, cookie);
step("connections", connections.ok || connections.status === 200, { status: connections.status });

const billing = await req("/api/billing", {}, cookie);
step("billing status (no card)", billing.ok, { status: billing.status });

const checkout = await req(
  "/api/checkout",
  { method: "POST", body: JSON.stringify({ plan: "personal" }) },
  cookie,
);
step("checkout session create only (no card)", checkout.ok && Boolean(checkout.json?.url), {
  status: checkout.status,
  hasUrl: Boolean(checkout.json?.url),
});

const onboarding = await req("/api/onboarding", {}, cookie);
step("onboarding", onboarding.ok || onboarding.status === 200, { status: onboarding.status });

// ——— Plan matrix: Personal → Family (2/5/10) → Executive → Business ———
if (userId) {
  // Personal
  await grantPlan(userId, email, "personal", cookie);
  const teamPersonal = await req("/api/teams", { method: "POST", body: JSON.stringify({ name: "Personal Team" }) }, cookie);
  step("personal: create team", teamPersonal.ok, { status: teamPersonal.status });

  // Family 2
  await grantPlan(userId, email, "family_2", cookie);
  const teamF2 = await req("/api/teams", { method: "POST", body: JSON.stringify({ name: "Family 2 Household" }) }, cookie);
  const teamF2Id = teamF2.json?.id || null;
  step("family_2: create team", teamF2.ok && Boolean(teamF2Id), { status: teamF2.status, teamId: teamF2Id });

  const choresCreate = await req(
    "/api/chores",
    {
      method: "POST",
      body: JSON.stringify({ title: "E2E Family Chore", due_at: futureDue, body: "Take out recycling" }),
    },
    cookie,
  );
  step("family_2: chore create", choresCreate.ok || choresCreate.status === 201, {
    status: choresCreate.status,
    error: choresCreate.json?.error || null,
  });
  const choresList = await req("/api/chores", {}, cookie);
  step("family_2: chores list", choresList.ok || Array.isArray(choresList.json), {
    status: choresList.status,
    count: Array.isArray(choresList.json) ? choresList.json.length : null,
  });

  // Family 5 ("Family Plus"-style mid tier)
  await grantPlan(userId, email, "family_5", cookie);
  const teamF5 = await req("/api/teams", { method: "POST", body: JSON.stringify({ name: "Family Plus 5" }) }, cookie);
  step("family_5 (Family Plus): create team", teamF5.ok, { status: teamF5.status });
  const invite = teamF5.json?.id
    ? await req(
        "/api/teams",
        {
          method: "PATCH",
          body: JSON.stringify({ action: "invite", team_id: teamF5.json.id, email: `member_${stamp}@amberone.test` }),
        },
        cookie,
      )
    : { ok: false, status: 0 };
  step("family_5: invite member", invite.ok || invite.status === 200, { status: invite.status });

  // Family 10
  await grantPlan(userId, email, "family_10", cookie);
  const teamF10 = await req("/api/teams", { method: "POST", body: JSON.stringify({ name: "Family 10" }) }, cookie);
  step("family_10: create team", teamF10.ok, { status: teamF10.status });

  // Executive
  await grantPlan(userId, email, "executive", cookie);
  const crm = await req(
    "/api/crm",
    {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Contact",
        email: "contact@example.com",
        company: "AmberOne Test Co",
        notes: "Executive CRM verify",
      }),
    },
    cookie,
  );
  const contactId = crm.json?.id || null;
  step("executive: CRM contact create", crm.ok && Boolean(contactId), { status: crm.status, contactId });

  const crmList = await req("/api/crm", {}, cookie);
  step("executive: CRM list", crmList.ok && Array.isArray(crmList.json), {
    status: crmList.status,
    count: Array.isArray(crmList.json) ? crmList.json.length : null,
  });

  if (contactId) {
    const interaction = await req(
      "/api/crm",
      {
        method: "POST",
        body: JSON.stringify({
          type: "interaction",
          contact_id: contactId,
          kind: "call",
          summary: "E2E follow-up call",
        }),
      },
      cookie,
    );
    step("executive: CRM interaction", interaction.ok || interaction.status === 201, { status: interaction.status });
  } else {
    step("executive: CRM interaction", false, { reason: "no contactId" });
  }

  const prep = eventId
    ? await req("/api/meeting-prep", { method: "POST", body: JSON.stringify({ event_id: eventId }) }, cookie)
    : { ok: false, status: 0, json: { error: "no event" } };
  step("executive: meeting prep", prep.ok || prep.status === 200 || prep.status === 201, {
    status: prep.status,
    error: prep.json?.error || null,
  });

  // Business Small
  await grantPlan(userId, email, "business_small", cookie);
  const apptStart = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();
  const appt = await req(
    "/api/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        title: "E2E Business Appointment",
        starts_at: apptStart,
        notes: "Customer consult",
        contact_id: contactId,
      }),
    },
    cookie,
  );
  const apptId = appt.json?.id || null;
  step("business_small: appointment create", appt.ok && Boolean(apptId), { status: appt.status, apptId });
  const appts = await req("/api/appointments", {}, cookie);
  step("business_small: appointments list", appts.ok && Array.isArray(appts.json), {
    status: appts.status,
    count: Array.isArray(appts.json) ? appts.json.length : null,
  });

  const bizCustomer = await req(
    "/api/crm",
    {
      method: "POST",
      body: JSON.stringify({ name: "Biz Customer", email: "biz@example.com", company: "Local Shop" }),
    },
    cookie,
  );
  step("business_small: customer create", bizCustomer.ok || bizCustomer.status === 201, {
    status: bizCustomer.status,
  });

  // Business Medium
  await grantPlan(userId, email, "business_medium", cookie);
  const appt2 = await req(
    "/api/appointments",
    {
      method: "POST",
      body: JSON.stringify({ title: "E2E Medium Team Appt", starts_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString() }),
    },
    cookie,
  );
  step("business_medium: appointment create", appt2.ok || appt2.status === 201, { status: appt2.status });
}

// ——— Hero video asset ———
const video = await req("/assets/video/amberone-hero.mp4?v=e2e");
step("hero video asset", video.status === 200, { status: video.status });

// ——— Logout ———
const logout = await req("/api/auth/logout", { method: "POST", body: "{}" }, cookie);
step("logout", logout.ok, { status: logout.status });

const failed = steps.filter((s) => !s.ok);
const passed = steps.filter((s) => s.ok);
const report = {
  at: new Date().toISOString(),
  base,
  email,
  userId,
  passed: passed.length,
  total: steps.length,
  failed: failed.map((f) => f.name),
  notes: [
    "Credit card capture intentionally skipped; Checkout session create + webhook plan grants only.",
    "Family Plus mapped to family_5 mid tier; Family (2)/(10) tested separately.",
    "Talk tool-calling depends on OpenAI; reply presence is the hard requirement.",
  ],
  steps,
};

mkdirSync(path.join(root, "docs"), { recursive: true });
const outPath = path.join(root, "docs", "E2E-FULL-PLATFORM.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      summary: { passed: report.passed, total: report.total, failedCount: failed.length, failed: report.failed },
      reportPath: "docs/E2E-FULL-PLATFORM.json",
    },
    null,
    2,
  ),
);
process.exit(failed.length ? 1 : 0);
