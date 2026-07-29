/**
 * Verify Gmail read + draft against the owner-assist account (already OAuth-linked).
 * Usage:
 *   ASSIST_LOGIN_SECRET=... AMBERONE_URL=https://amberone.pages.dev node scripts/verify-gmail-assist.mjs
 * Never prints the assist secret.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const base = process.env.AMBERONE_URL || "https://amberone.pages.dev";

function loadSecret() {
  if (process.env.ASSIST_LOGIN_SECRET) return process.env.ASSIST_LOGIN_SECRET;
  const p = path.join(root, ".tmp/assist-secret.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).ASSIST_LOGIN_SECRET || null;
  } catch {
    return null;
  }
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length) return list.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function req(pathname, init = {}, cookie = "") {
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 400, json, text, cookie: cookiesFrom(res), location: res.headers.get("location") };
}

const steps = [];
function step(name, ok, detail = {}) {
  steps.push({ name, ok, ...detail });
  console.log(JSON.stringify({ step: name, ok, ...detail }));
}

const secret = loadSecret();
if (!secret) {
  console.error(JSON.stringify({ ok: false, error: "Missing ASSIST_LOGIN_SECRET / .tmp/assist-secret.json" }));
  process.exit(1);
}

const magic = await req(
  "/api/auth/magic-login",
  {
    method: "POST",
    headers: { "X-Assist-Secret": secret },
    body: JSON.stringify({ email: "owner-assist@amberone.local", next: "/dashboard/connections" }),
  },
);
step("magic-login create", magic.ok && Boolean(magic.json?.url), { status: magic.status });

const tokenMatch = String(magic.json?.url || "").match(/token=([^&]+)/);
const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : null;
const redeem = await req(`/api/auth/magic-login?token=${encodeURIComponent(token || "")}`, { method: "GET" });
// 302 with set-cookie
let cookie = redeem.cookie || "";
step("magic-login redeem", (redeem.status === 302 || redeem.status === 303) && Boolean(cookie), {
  status: redeem.status,
  hasCookie: Boolean(cookie),
});

const me = await req("/api/auth/me", {}, cookie);
step("assist session", me.ok && /owner-assist/i.test(me.json?.user?.email || ""), {
  status: me.status,
  email: me.json?.user?.email || null,
});

const services = await req("/api/connected-services", {}, cookie);
const gmailConn = (services.json?.connections || []).find((c) => c.toolkit === "gmail" && /active/i.test(c.status || ""));
step("gmail connected ACTIVE", Boolean(gmailConn), {
  status: services.status,
  connections: (services.json?.connections || []).map((c) => ({ toolkit: c.toolkit, status: c.status })),
});

const inbox = await req("/api/gmail?query=in:inbox&limit=5&profile=1", {}, cookie);
step("gmail inbox fetch", inbox.ok && inbox.json?.connected === true && Array.isArray(inbox.json?.emails), {
  status: inbox.status,
  emailCount: (inbox.json?.emails || []).length,
  profileEmail: inbox.json?.profile?.emailAddress || null,
  error: inbox.json?.error || null,
});

const draft = await req(
  "/api/gmail",
  {
    method: "POST",
    body: JSON.stringify({
      action: "draft",
      recipient_email: "me",
      subject: "AmberOne Gmail draft verify",
      body: "Automated draft from verify-gmail-assist.mjs — not sent.",
    }),
  },
  cookie,
);
// 'me' may fail on create draft — try profile email if needed
let draftOk = draft.ok && Boolean(draft.json?.draft?.draftId || draft.json?.ok);
let draftDetail = { status: draft.status, error: draft.json?.error || null, draftId: draft.json?.draft?.draftId || null };
if (!draftOk && inbox.json?.profile?.emailAddress) {
  const draft2 = await req(
    "/api/gmail",
    {
      method: "POST",
      body: JSON.stringify({
        action: "draft",
        recipient_email: inbox.json.profile.emailAddress,
        subject: "AmberOne Gmail draft verify",
        body: "Automated draft from verify-gmail-assist.mjs — not sent.",
      }),
    },
    cookie,
  );
  draftOk = draft2.ok && (Boolean(draft2.json?.draft?.draftId) || draft2.json?.ok === true);
  draftDetail = { status: draft2.status, error: draft2.json?.error || null, draftId: draft2.json?.draft?.draftId || null, usedProfileEmail: true };
}
step("gmail create draft (not sent)", draftOk, draftDetail);

const talk = await req(
  "/api/talk",
  { method: "POST", body: JSON.stringify({ message: "List my latest 3 inbox emails using the Gmail tool." }) },
  cookie,
);
const usedList = (talk.json?.toolsUsed || []).some((t) => t.name === "list_emails");
step("talk list_emails tool", talk.ok && Boolean(talk.json?.reply), {
  status: talk.status,
  usedListEmailsTool: usedList,
  toolsUsed: (talk.json?.toolsUsed || []).map((t) => t.name),
});

const failed = steps.filter((s) => !s.ok);
const report = {
  at: new Date().toISOString(),
  base,
  passed: steps.filter((s) => s.ok).length,
  total: steps.length,
  failed: failed.map((f) => f.name),
  steps,
  note: "Live Stripe card charge intentionally deferred until full E2E suite is complete.",
};

mkdirSync(path.join(root, "docs"), { recursive: true });
writeFileSync(path.join(root, "docs/GMAIL-ASSIST-VERIFY.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: { passed: report.passed, total: report.total, failed: report.failed }, reportPath: "docs/GMAIL-ASSIST-VERIFY.json" }, null, 2));
if (failed.length) process.exit(1);
