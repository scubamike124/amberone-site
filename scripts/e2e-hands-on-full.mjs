/**
 * Hands-on AmberOne production validation.
 * Uses real signup sessions, then checks stored records after edit/logout/login.
 * Does not complete a live card charge. Does not email real people.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const pass = "HandsOnPass9!";
const steps = [];
const bugs = [];

function cookieJar() {
  const jar = new Map();
  return {
    apply(headers) {
      const raw = headers.getSetCookie?.() || (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
      for (const line of raw) {
        const part = String(line).split(";")[0];
        const i = part.indexOf("=");
        if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
      }
    },
    header() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    clear() {
      jar.clear();
    },
  };
}

async function req(jar, method, path, body, extraHeaders = {}) {
  const headers = { Accept: "application/json", ...extraHeaders };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && !(body instanceof FormData) && extraHeaders["Content-Type"] !== "application/octet-stream") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData || typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  jar.apply(res.headers);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, 400), html: text, headers: res.headers };
}

function record(feature, action, ok, detail, extra = {}) {
  const row = { feature, action, ok, detail, ...extra };
  steps.push(row);
  console.log(`${ok ? "PASS" : "FAIL"}  [${feature}] ${action}${detail ? " — " + String(detail).slice(0, 160) : ""}`);
  if (!ok) bugs.push(row);
}

async function htmlHas(path, tests) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, ok: tests.every((t) => (typeof t === "string" ? text.includes(t) : t.test(text))) };
}

async function main() {
  const owner = cookieJar();
  const member = cookieJar();
  const outsider = cookieJar();
  const rejecter = cookieJar();
  const emailOwner = `ao.owner.${stamp}@example.com`;
  const emailMember = `ao.member.${stamp}@example.com`;
  const emailOut = `ao.out.${stamp}@example.com`;
  const emailReject = `ao.reject.${stamp}@example.com`;

  // --- Public pages ---
  for (const [path, needle] of [
    ["/", "AmberOne"],
    ["/pricing", "Personal"],
    ["/signup", "password"],
    ["/login", "password"],
    ["/forgot-password", "email"],
    ["/contact", "Contact"],
    ["/faq", ""],
    ["/privacy", ""],
    ["/dashboard/projects", ""],
    ["/dashboard/calendar", ""],
  ]) {
    const page = await htmlHas(path, needle ? [needle] : ["<!DOCTYPE html>"]);
    record("marketing/ui", `open ${path}`, page.status === 200 && page.ok, `status ${page.status}`);
  }

  // --- Auth ---
  let r = await req(owner, "POST", "/api/auth/signup", { email: "not-an-email", password: "x" });
  record("signup", "reject invalid email", r.status === 400, r.json?.error);

  r = await req(owner, "POST", "/api/auth/signup", { name: "Pat Owner", email: emailOwner, password: pass });
  record("signup", "create owner", r.status === 201 && r.json?.user?.email === emailOwner, r.json?.error || r.json?.user?.email);

  r = await req(owner, "POST", "/api/auth/signup", { name: "Pat Owner", email: emailOwner, password: pass });
  record("signup", "duplicate rejected", r.status === 409 || r.status === 400, String(r.status));

  r = await req(owner, "GET", "/api/auth/me");
  record("session", "session after signup", r.status === 200 && r.json?.user?.email === emailOwner, r.json?.user?.email);

  r = await req(owner, "POST", "/api/auth/logout", {});
  record("logout", "logout owner", r.status === 200 || r.status === 204, String(r.status));
  r = await req(owner, "GET", "/api/auth/me");
  record("logout", "session cleared", r.status === 401, String(r.status));

  r = await req(owner, "POST", "/api/auth/login", { email: emailOwner, password: "wrong-password" });
  record("login", "wrong password", r.status === 401, String(r.status));
  r = await req(owner, "POST", "/api/auth/login", { email: emailOwner, password: pass });
  record("login", "login owner", r.status === 200 && r.json?.user?.email === emailOwner, r.json?.error);

  r = await req(member, "POST", "/api/auth/signup", { name: "Alex Member", email: emailMember, password: pass });
  record("signup", "create member", r.status === 201, r.json?.error);
  r = await req(outsider, "POST", "/api/auth/signup", { name: "Sam Outsider", email: emailOut, password: pass });
  record("signup", "create outsider", r.status === 201, r.json?.error);
  r = await req(rejecter, "POST", "/api/auth/signup", { name: "Riley Reject", email: emailReject, password: pass });
  record("signup", "create rejecter", r.status === 201, r.json?.error);

  r = await req(owner, "POST", "/api/auth/forgot-password", { email: emailOwner });
  record(
    "password reset",
    "forgot-password no token leak",
    r.status === 200 && !String(r.text).includes("resetUrl") && !/token=/.test(r.text),
    r.json?.message || r.text.slice(0, 80),
  );
  r = await req(owner, "POST", "/api/auth/forgot-password", { email: "nobody-not-real@example.com" });
  record("password reset", "unknown email still ok (no enumeration)", r.status === 200, String(r.status));

  r = await req(owner, "POST", "/api/onboarding", { complete: true, prefs: { tone: "direct" } });
  record("onboarding", "complete onboarding", r.status === 200 && r.json?.complete === true, r.json?.step);

  // --- Notes ---
  r = await req(owner, "POST", "/api/notes", { title: "School pickup", body: "Maya at 3:15 from the south lot." });
  const noteId = r.json?.note?.id;
  record("notes", "create note", r.status === 201 && noteId, noteId);
  r = await req(owner, "PATCH", "/api/notes", { id: noteId, body: "Maya at 3:30 from the south lot.", pinned: true });
  record("notes", "edit note", r.status === 200 && /3:30/.test(r.json?.note?.body || ""), r.json?.note?.body);
  r = await req(owner, "GET", `/api/notes?id=${noteId}`);
  record("notes", "stored note matches edit", r.json?.note?.body?.includes("3:30") && r.json?.note?.pinned, r.json?.note?.body);

  // --- Lists / tasks ---
  r = await req(owner, "POST", "/api/lists", { title: "Weekend chores", kind: "todo", items: ["Mow lawn", "Buy flowers"] });
  const listId = r.json?.list?.id;
  const itemId = r.json?.list?.items?.[0]?.id;
  record("lists", "create list with items", r.status === 201 && listId && (r.json.list.items || []).length >= 2, listId);
  r = await req(owner, "POST", "/api/lists", { list_id: listId, text: "Call plumber" });
  const extraItem = r.json?.item?.id;
  record("lists", "add list item", r.status === 201 && extraItem, extraItem);
  r = await req(owner, "PATCH", "/api/lists", { item_id: itemId, checked: true });
  record("lists", "complete task", r.status === 200 && (r.json?.list?.items || []).some((i) => i.id === itemId && i.checked), "checked");
  r = await req(owner, "PATCH", "/api/lists", { item_id: itemId, checked: false });
  record("lists", "reopen task", r.status === 200 && (r.json?.list?.items || []).some((i) => i.id === itemId && !i.checked), "unchecked");
  r = await req(owner, "PATCH", "/api/lists", { id: listId, title: "Weekend household" });
  record("lists", "rename list", r.status === 200 && r.json?.list?.title === "Weekend household", r.json?.list?.title);

  // --- Memories ---
  r = await req(owner, "POST", "/api/memories", { title: "Allergy", content: "Maya is allergic to peanuts.", kind: "health", importance: 5 });
  const memId = r.json?.memory?.id;
  record("memories", "create memory", r.status === 201 && memId, memId);
  r = await req(owner, "PATCH", "/api/memories", { id: memId, content: "Maya is allergic to peanuts and cashews." });
  record("memories", "edit memory", r.status === 200 && /cashews/.test(r.json?.memory?.content || ""), r.json?.memory?.content);

  // --- Calendar ---
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const moved = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();
  r = await req(owner, "POST", "/api/calendar", {
    title: "Maya soccer",
    description: "Bring orange slices",
    location: "Riverside Field",
    starts_at: start,
    ends_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    people: "Maya, Coach Dana",
    recurrence: "weekly",
    visibility: "private",
    remind_minutes: 0,
  });
  const eventId = r.json?.event?.id;
  record("calendar", "create event with people/recurrence/reminder", r.status === 201 && eventId && r.json?.event?.recurrence === "weekly", eventId);
  r = await req(owner, "PATCH", "/api/calendar", {
    id: eventId,
    title: "Maya soccer (rescheduled)",
    starts_at: moved,
    description: "Bring water bottles too",
    remind_minutes: 15,
  });
  record("calendar", "edit and reschedule event", r.status === 200 && r.json?.event?.title.includes("rescheduled") && r.json?.event?.starts_at === moved, r.json?.event?.starts_at);

  const dueNow = new Date(Date.now() - 5000).toISOString();
  r = await req(owner, "POST", "/api/calendar", {
    title: "Due reminder event",
    starts_at: dueNow,
    people: "Pat",
    remind_minutes: 0,
  });
  record("calendar", "create already-due event reminder", r.status === 201, r.json?.event?.id);

  r = await req(owner, "POST", "/api/teams", { name: "Rivera Family" });
  const teamId = r.json?.id;
  record("family", "create family team", r.status === 201 && teamId, teamId);

  r = await req(owner, "POST", "/api/calendar", {
    title: "Family dinner",
    starts_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    visibility: "shared",
    people: "Pat, Alex, Maya",
    description: "Tacos",
    team_id: teamId,
  });
  const sharedEvt = r.json?.event?.id;
  record("calendar", "create shared family event", r.status === 201 && r.json?.event?.visibility === "shared", sharedEvt);

  // --- Google Calendar OAuth (native; no Composio required) ---
  const health = await fetch(`${BASE}/api/health`).then((res) => res.json().catch(() => ({})));
  record("calendar", "live health reports Google OAuth + R2", Boolean(health.googleCalendarOAuth) && Boolean(health.r2), `gcal=${health.googleCalendarOAuth} r2=${health.r2}`);
  r = await req(owner, "GET", "/api/connected-services");
  const gcalToolkit = (r.json?.availableToolkits || []).find((t) => t.toolkit === "googlecalendar");
  record(
    "calendar",
    "Google Calendar is connectable without Composio",
    Boolean(r.json?.nativeGoogleCalendar) && Boolean(gcalToolkit?.connectable),
    `native=${r.json?.nativeGoogleCalendar} connectable=${gcalToolkit?.connectable} composio=${r.json?.composioConfigured}`,
  );
  r = await req(owner, "POST", "/api/connected-services", { toolkit: "googlecalendar" });
  record(
    "calendar",
    "Connect returns Google OAuth start URL",
    r.status === 200 && /\/api\/google-calendar-oauth/.test(r.json?.redirectUrl || ""),
    r.json?.redirectUrl || r.json?.error,
  );
  r = await req(owner, "GET", "/api/google-calendar-oauth");
  const googleStart = r.headers.get("location") || "";
  record(
    "calendar",
    "Connect redirects to Google with Amber One callback",
    r.status === 302 && /accounts\.google\.com/.test(googleStart) && /amberoneai\.com%2Fapi%2Fgoogle-calendar-oauth/.test(googleStart),
    googleStart.replace(/client_id=[^&]+/, "client_id=PRESENT").replace(/state=[^&]+/, "state=REDACTED").slice(0, 220),
  );
  if (/accounts\.google\.com/.test(googleStart)) {
    const googlePage = await fetch(googleStart, { redirect: "manual" });
    const googleHtml = await googlePage.text();
    const mismatch = /redirect_uri_mismatch|redirect uri mismatch/i.test(googleHtml);
    const googleReady = googlePage.status < 400 && !mismatch && /sign in|google|accounts/i.test(googleHtml);
    record(
      "calendar",
      "Google accepts the Calendar redirect URI",
      googleReady && !mismatch,
      mismatch ? "redirect_uri_mismatch" : `http ${googlePage.status}`,
    );
  }
  r = await req(owner, "POST", "/api/calendar-sync", {});
  record(
    "calendar",
    "Sync before connect returns an honest error",
    r.status === 400 || r.status === 503,
    r.json?.error,
  );

  // --- Reminders / notifications ---
  r = await req(owner, "POST", "/api/reminders", {
    title: "Take lasagna out",
    body: "Oven timer",
    due_at: new Date(Date.now() - 2000).toISOString(),
    channel: "app",
  });
  const remId = r.json?.reminder?.id;
  const dispatched = r.json?.dispatched || [];
  record("reminders", "create past-due reminder (fires on create)", r.status === 201 && dispatched.some((d) => d.id === remId), JSON.stringify(dispatched.map((d) => d.id)));

  r = await req(owner, "GET", "/api/notifications");
  const notifs = r.json?.notifications || [];
  const reminderNotifs = notifs.filter((n) => /lasagna|Due reminder|Upcoming/i.test(`${n.title} ${n.body || ""}`));
  record("notifications", "in-app notification created for due reminder", reminderNotifs.length >= 1, `${reminderNotifs.length} matching`);

  r = await req(owner, "GET", "/api/reminders");
  const secondDispatch = (r.json?.dispatched || []).filter((d) => d.id === remId);
  record("notifications", "due reminder not duplicated on second poll", secondDispatch.length === 0, JSON.stringify(r.json?.dispatched || []));

  r = await req(owner, "POST", "/api/notifications", { action: "read", id: reminderNotifs[0]?.id });
  record("notifications", "mark one read", !reminderNotifs[0] || r.status === 200, String(r.status));
  r = await req(owner, "POST", "/api/notifications", { action: "read_all" });
  record("notifications", "mark all read", r.status === 200, String(r.status));

  r = await req(owner, "POST", "/api/reminders", { title: "Future dentist", due_at: new Date(Date.now() + 86400000).toISOString() });
  const futureRem = r.json?.reminder?.id;
  r = await req(owner, "PATCH", "/api/reminders", { id: futureRem, complete: true });
  record("reminders", "complete reminder", r.status === 200 && r.json?.reminder?.status === "completed", r.json?.reminder?.status);
  r = await req(owner, "PATCH", "/api/reminders", { id: futureRem, reopen: true });
  record("reminders", "reopen reminder", r.status === 200 && r.json?.reminder?.status === "pending", r.json?.reminder?.status);

  // --- Family invites ---
  r = await req(owner, "PATCH", "/api/teams", { action: "invite", team_id: teamId, email: "not-an-email", role: "member" });
  record("invitations", "invalid email rejected", r.status === 400, r.json?.error);

  r = await req(owner, "PATCH", "/api/teams", { action: "invite", team_id: teamId, email: emailMember, role: "member" });
  const inviteMember = r.json?.id;
  record("invitations", "invite member", r.status === 200 && inviteMember, inviteMember);

  r = await req(owner, "PATCH", "/api/teams", { action: "invite", team_id: teamId, email: emailReject, role: "member" });
  const inviteReject = r.json?.id;
  record("invitations", "invite rejecter", r.status === 200 && inviteReject, inviteReject);

  r = await req(outsider, "PATCH", "/api/teams", { action: "accept", member_id: inviteMember });
  record("invitations", "outsider cannot accept someone else's invite", r.status === 403 || r.status === 404, String(r.status));

  r = await req(member, "GET", "/api/teams?action=invites");
  record("invitations", "member sees pending invite", (r.json?.invites || []).some((i) => i.id === inviteMember), JSON.stringify(r.json?.invites || []).slice(0, 120));

  r = await req(member, "GET", "/api/notifications");
  record("invitations", "member received invite notification", (r.json?.notifications || []).some((n) => /invite/i.test(n.kind + n.title)), (r.json?.notifications || []).map((n) => n.title).join(" | "));

  r = await req(member, "PATCH", "/api/teams", { action: "accept", member_id: inviteMember });
  record("invitations", "member accepts invite", r.status === 200 && r.json?.status === "active", r.json?.status);

  r = await req(rejecter, "PATCH", "/api/teams", { action: "reject", member_id: inviteReject });
  record("invitations", "rejecter declines invite", r.status === 200 && r.json?.status === "rejected", r.json?.status);

  r = await req(member, "GET", `/api/teams?action=members&team_id=${teamId}`);
  const teamMembers = Array.isArray(r.json) ? r.json : r.json?.members || [];
  record("family", "member list shows accepted user", teamMembers.some((m) => m.status === "active" && (m.invited_email === emailMember || m.user_id)), String(teamMembers.length));

  r = await req(member, "GET", "/api/calendar");
  record("calendar", "member can see shared family dinner", (r.json?.events || []).some((e) => e.id === sharedEvt || /Family dinner/i.test(e.title)), (r.json?.events || []).map((e) => e.title).join(","));
  record("calendar", "member cannot see private soccer event", !(r.json?.events || []).some((e) => e.id === eventId), "private hidden");

  r = await req(outsider, "GET", "/api/calendar");
  record("calendar", "outsider cannot see shared family event", !(r.json?.events || []).some((e) => e.id === sharedEvt), "isolated");

  // --- Chores ---
  r = await req(owner, "POST", "/api/chores", { title: "Take out recycling", assigned_user_id: member.json ? undefined : undefined });
  // need member user id from team members
  const memberRow = teamMembers.find((m) => /member/i.test(m.role) && m.status === "active" && m.invited_email === emailMember);
  r = await req(owner, "POST", "/api/chores", { title: "Take out recycling", assigned_user_id: memberRow?.user_id || null, body: "Blue bin Thursday" });
  const choreId = r.json?.id;
  record("family chores", "create assigned chore", r.status === 201 && choreId, choreId);
  r = await req(member, "GET", "/api/chores?status=pending");
  const chores = Array.isArray(r.json) ? r.json : [];
  record("family chores", "member sees team chore", chores.some((c) => c.id === choreId), String(chores.length));
  r = await req(member, "PATCH", "/api/chores", { id: choreId, complete: true });
  record("family chores", "complete chore", r.status === 200, String(r.status));
  r = await req(member, "PATCH", "/api/chores", { id: choreId, reopen: true });
  record("family chores", "reopen chore", r.status === 200, String(r.status));
  r = await req(outsider, "GET", "/api/chores?status=pending");
  record("family chores", "outsider has no team chores", r.status === 400 || (Array.isArray(r.json) && !r.json.some((c) => c.id === choreId)), String(r.status));

  // --- CRM / contacts ---
  r = await req(owner, "POST", "/api/crm", { name: "Coach Dana", email: "coach.dana.invalid", phone: "555-0100", notes: "Soccer" });
  const contactId = r.json?.id;
  record("contacts", "create contact (email stored, even if unused)", r.status === 201 && contactId, contactId);
  r = await req(owner, "POST", "/api/crm", { type: "interaction", contact_id: contactId, summary: "Confirmed Saturday practice" });
  record("contacts", "add interaction", r.status === 201, r.json?.id);
  r = await req(outsider, "GET", `/api/crm?contact_id=${contactId}`);
  record("contacts", "outsider cannot read contact", r.status === 404, String(r.status));

  // --- Appointments ---
  r = await req(owner, "POST", "/api/appointments", { title: "Client consult", starts_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), notes: "Zoom" });
  const apptId = r.json?.id;
  record("appointments", "create appointment", r.status === 201 && apptId, apptId);

  // --- Projects ---
  r = await req(owner, "POST", "/api/projects", {
    name: "Kitchen remodel",
    description: "Demo week, then cabinets, then paint.",
    deadline: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  });
  const projectId = r.json?.project?.id;
  record("projects", "create project", (r.status === 201 || r.status === 200) && projectId, projectId || r.json?.error);

  const inviteIds = [];
  for (let i = 1; i <= 20; i++) {
    const email = i === 1 ? emailMember : i === 2 ? emailReject : `ao.proj.${stamp}.${String(i).padStart(2, "0")}@example.com`;
    const inv = await req(owner, "PATCH", "/api/projects", { action: "invite", project_id: projectId, email, role: i === 3 ? "viewer" : "member" });
    inviteIds.push({ email, id: inv.json?.id, status: inv.status, error: inv.json?.error });
  }
  const inviteOk = inviteIds.filter((x) => x.status === 200 && x.id).length;
  record("projects", "invite 20 unique people", inviteOk === 20, `${inviteOk}/20`);
  r = await req(owner, "PATCH", "/api/projects", { action: "invite", project_id: projectId, email: "nope", role: "member" });
  record("projects", "invalid invite email rejected", r.status === 400, r.json?.error);

  const memberInvite = inviteIds.find((x) => x.email === emailMember);
  const rejectInvite = inviteIds.find((x) => x.email === emailReject);
  r = await req(outsider, "PATCH", "/api/projects", { action: "accept", member_id: memberInvite?.id });
  record("projects", "wrong user cannot accept project invite", r.status === 403 || r.status === 404, String(r.status));
  r = await req(member, "PATCH", "/api/projects", { action: "accept", member_id: memberInvite?.id });
  record("projects", "member accepts project invite", r.status === 200 && r.json?.status === "active", r.json?.status);
  r = await req(rejecter, "PATCH", "/api/projects", { action: "reject", member_id: rejectInvite?.id });
  record("projects", "rejecter declines project invite", r.status === 200 && r.json?.status === "rejected", r.json?.status);

  r = await req(owner, "POST", "/api/projects", { action: "task", project_id: projectId, title: "Order cabinets", body: "Shaker white", assigned_user_id: memberRow?.user_id || null, due_at: new Date(Date.now() + 7 * 86400000).toISOString() });
  const taskId = r.json?.id;
  record("projects", "create and assign task", r.status === 201 && taskId, taskId);
  r = await req(owner, "PATCH", "/api/projects", { action: "task_update", task_id: taskId, assigned_user_id: memberRow?.user_id || null, title: "Order cabinets — reassigned" });
  record("projects", "reassign/edit task", r.status === 200, String(r.status));
  r = await req(member, "PATCH", "/api/projects", { action: "task_update", task_id: taskId, status: "done" });
  record("projects", "complete task", r.status === 200, String(r.status));
  r = await req(member, "PATCH", "/api/projects", { action: "task_update", task_id: taskId, status: "reopened" });
  record("projects", "reopen task", r.status === 200, String(r.status));

  r = await req(member, "POST", "/api/projects", { action: "comment", project_id: projectId, task_id: taskId, body: "Cabinet lead time is 4 weeks." });
  record("projects", "member comments", r.status === 201, r.json?.id);
  r = await req(member, "POST", "/api/projects", { action: "message", project_id: projectId, body: "I'll measure the alcove tonight." });
  record("projects", "member sends in-app project message", r.status === 201, r.json?.id);

  r = await req(owner, "GET", `/api/projects?id=${projectId}`);
  record("projects", "owner sees comment and message stored", (r.json?.comments || []).length >= 1 && (r.json?.messages || []).length >= 1, `comments ${r.json?.comments?.length} messages ${r.json?.messages?.length}`);
  r = await req(owner, "GET", "/api/notifications");
  record("projects", "owner notified of member communication", (r.json?.notifications || []).some((n) => /comment|message|Project/i.test(`${n.kind} ${n.title}`)), (r.json?.notifications || []).map((n) => n.title).slice(0, 5).join(" | "));

  r = await req(outsider, "GET", `/api/projects?id=${projectId}`);
  record("projects", "outsider cannot open project", r.status === 404, String(r.status));
  r = await req(outsider, "POST", "/api/projects", { action: "message", project_id: projectId, body: "Should not work" });
  record("projects", "outsider cannot message project", r.status === 404, String(r.status));

  r = await req(member, "DELETE", `/api/projects?id=${projectId}`);
  record("projects", "non-owner cannot delete project", r.status === 404 || r.status === 403, String(r.status));

  // --- Files (R2) ---
  r = await req(owner, "POST", "/api/files", {
    name: "house-notes.txt",
    content_type: "text/plain",
    content_base64: Buffer.from("paint samples for the kitchen").toString("base64"),
  });
  const fileId = r.json?.file?.id;
  record("files", "upload text file to R2", r.status === 201 && fileId, fileId || r.json?.error);
  r = await req(owner, "GET", "/api/files");
  record("files", "list includes uploaded file", (r.json?.files || []).some((f) => f.id === fileId), String((r.json?.files || []).length));
  r = await req(owner, "GET", `/api/files?id=${fileId}&download=1`);
  record("files", "download matches stored text", r.status === 200 && /paint samples/.test(r.html || r.text), (r.html || r.text || "").slice(0, 80));
  r = await req(outsider, "GET", `/api/files?id=${fileId}&download=1`);
  record("files", "outsider cannot download private file", r.status === 404, String(r.status));
  r = await req(outsider, "GET", "/api/files");
  record("files", "outsider list does not include owner file", !(r.json?.files || []).some((f) => f.id === fileId), String((r.json?.files || []).length));
  r = await req(owner, "DELETE", `/api/files?id=${fileId}`);
  record("files", "delete private file", r.status === 200, String(r.status));

  // --- Search ---
  r = await req(owner, "GET", `/api/search?q=${encodeURIComponent("peanut")}`);
  record("search", "find allergy memory", r.status === 200 && (r.json?.memories || []).some((m) => /peanut/i.test(m.content || m.title || "")), JSON.stringify(r.json?.memories?.[0]?.title));
  r = await req(owner, "GET", "/api/search?q=x");
  record("search", "too-short query rejected", r.status === 400, r.json?.error);

  // --- Talk ---
  r = await req(owner, "POST", "/api/talk", { message: "What is Maya allergic to?" });
  record("talk", "authenticated talk returns a reply", r.status === 200 && Boolean(r.json?.reply), r.json?.source);

  // --- Home / briefing ---
  r = await req(owner, "GET", "/api/home");
  record("home", "home dashboard includes calendar and reminders", r.status === 200 && Array.isArray(r.json?.calendar?.upcoming || r.json?.today?.events), Object.keys(r.json || {}).slice(0, 8).join(","));
  r = await req(owner, "GET", "/api/briefing?timeZone=America/Los_Angeles&mode=auto");
  record("briefing", "briefing returns summary", r.status === 200 && Boolean(r.json?.briefing?.summary || r.json?.summary), r.json?.briefing ? "briefing" : r.json?.error);

  // --- Billing (no live charge) ---
  r = await req(owner, "POST", "/api/checkout", { plan: "personal" });
  const checkoutUrl = r.json?.url || "";
  record("billing", "stripe checkout session (no charge)", r.status === 200 && /^https:\/\/checkout\.stripe\.com\//i.test(checkoutUrl), checkoutUrl ? new URL(checkoutUrl).host : r.json?.error);
  r = await req(owner, "POST", "/api/checkout", { plan: "enterprise" });
  record("billing", "unknown plan blocked", r.status === 400, r.json?.error);
  r = await req(owner, "GET", "/api/billing");
  record("billing", "billing status readable", r.status === 200, r.json?.status || r.json?.plan || JSON.stringify(r.json).slice(0, 80));
  r = await req(owner, "POST", "/api/portal", {});
  record(
    "billing",
    "customer portal (may 400 without stripe customer yet)",
    r.status === 200 || r.status === 400 || r.status === 503,
    r.json?.error || r.json?.url?.slice?.(0, 40) || String(r.status),
  );

  // --- Persistence after logout/login ---
  owner.clear();
  r = await req(owner, "POST", "/api/auth/login", { email: emailOwner, password: pass });
  record("persistence", "re-login owner", r.status === 200, r.json?.user?.email);
  r = await req(owner, "GET", `/api/calendar`);
  record("persistence", "rescheduled event still stored after re-login", (r.json?.events || []).some((e) => e.id === eventId && /rescheduled/i.test(e.title)), (r.json?.events || []).map((e) => e.title).join(","));
  r = await req(owner, "GET", `/api/notes?id=${noteId}`);
  record("persistence", "edited note still stored after re-login", r.json?.note?.body?.includes("3:30"), r.json?.note?.body);
  r = await req(owner, "GET", `/api/projects?id=${projectId}`);
  record("persistence", "project still stored after re-login", r.json?.project?.id === projectId, r.json?.project?.name);

  r = await req(owner, "DELETE", `/api/calendar?id=${eventId}`);
  record("calendar", "delete private event", r.status === 200, String(r.status));
  r = await req(owner, "GET", "/api/calendar");
  record("calendar", "deleted event gone", !(r.json?.events || []).some((e) => e.id === eventId), "gone");

  r = await req(owner, "DELETE", `/api/notes?id=${noteId}`);
  record("notes", "delete note", r.status === 200, String(r.status));
  r = await req(owner, "DELETE", `/api/lists?id=${listId}`);
  record("lists", "delete list", r.status === 200, String(r.status));
  r = await req(owner, "DELETE", `/api/reminders?id=${futureRem}`);
  record("reminders", "delete reminder", r.status === 200, String(r.status));

  // --- Settings / audit ---
  r = await req(owner, "GET", "/api/audit");
  record("settings", "audit trail has actions", r.status === 200 && (r.json?.logs || []).length > 0, String((r.json?.logs || []).length));

  // --- Connections / marketplace honesty ---
  r = await req(owner, "GET", "/api/connections");
  record("connections", "connections endpoint responds", r.status === 200 || r.status === 401, String(r.status));
  const market = await htmlHas("/dashboard/marketplace", ["Marketplace", "market", "skill"]);
  record("marketplace", "marketplace page loads (may be placeholder)", market.status === 200, String(market.status));

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    accounts: { emailOwner, emailMember, emailOut, emailReject },
    pass: steps.filter((s) => s.ok).length,
    fail: steps.filter((s) => !s.ok).length,
    total: steps.length,
    failed: steps.filter((s) => !s.ok).map((s) => `${s.feature}: ${s.action}`),
    steps,
  };
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/HANDS-ON-E2E.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, total: report.total, failed: report.failed }, null, 2));
  return report;
}

const report = await main();
process.exit(report.fail ? 1 : 0);
