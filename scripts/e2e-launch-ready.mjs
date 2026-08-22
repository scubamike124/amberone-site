/**
 * Production customer journey — real HTTP against amberoneai.com.
 * Does not complete a live card charge.
 */
const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const pass = "AuditPass9!";

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

async function req(jar, method, path, body) {
  const headers = { Accept: "application/json" };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  return { status: res.status, json, text: text.slice(0, 200), ct: res.headers.get("content-type") };
}

function record(steps, name, ok, detail) {
  steps.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const steps = [];
  const a = cookieJar();
  const b = cookieJar();
  const emailA = `ao.audit.a.${stamp}@example.com`;
  const emailB = `ao.audit.b.${stamp}@example.com`;

  let r = await req(a, "GET", "/api/health");
  record(steps, "health", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));

  r = await req(a, "GET", "/robots.txt");
  record(steps, "robots.txt", r.status === 200 && /User-agent/i.test(r.text) && !/DOCTYPE html/i.test(r.text), r.ct);

  r = await req(a, "GET", "/sitemap.xml");
  record(steps, "sitemap.xml", r.status === 200 && /urlset/i.test(r.text), r.ct);

  r = await req(a, "GET", "/contact");
  record(steps, "contact page", r.status === 200 && /Contact · AmberOne/i.test(r.text), r.text.slice(0, 80));

  r = await req(a, "POST", "/api/auth/signup", { email: "bad", password: "short" });
  record(steps, "signup rejects bad email", r.status === 400);

  r = await req(a, "POST", "/api/auth/signup", { name: "Audit A", email: emailA, password: pass });
  record(steps, "signup A", r.status === 201 && Boolean(r.json?.user?.id), r.json?.error || r.json?.user?.email);

  r = await req(a, "POST", "/api/auth/signup", { name: "Audit A", email: emailA, password: pass });
  record(steps, "signup duplicate", r.status === 409);

  r = await req(a, "GET", "/api/auth/me");
  record(steps, "session after signup", r.status === 200 && r.json?.user?.email === emailA);

  r = await req(a, "POST", "/api/memories", { title: "Kid", content: "Sam's birthday is March 4", kind: "person" });
  record(steps, "create memory", r.status === 201, r.json?.memory?.id);

  r = await req(a, "POST", "/api/notes", { title: "Groceries", body: "Milk" });
  const noteId = r.json?.note?.id;
  record(steps, "create note", r.status === 201, noteId);

  r = await req(a, "POST", "/api/calendar", {
    title: "School pickup",
    starts_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  record(steps, "create calendar event", r.status === 201, r.json?.event?.id);

  r = await req(a, "POST", "/api/reminders", {
    title: "Pay water bill",
    due_at: new Date(Date.now() + 86400_000).toISOString(),
  });
  record(steps, "create reminder", r.status === 201 || r.status === 200, String(r.status));

  r = await req(a, "POST", "/api/lists", { title: "Shopping", kind: "shopping" });
  record(steps, "create list", r.status === 201 || r.status === 200, String(r.status));

  r = await req(a, "POST", "/api/talk", { message: "Remember that I prefer morning briefings." });
  record(steps, "authenticated talk", r.status === 200 && Boolean(r.json?.reply), r.json?.source);

  r = await req(a, "GET", "/api/home");
  record(steps, "home dashboard api", r.status === 200 && Boolean(r.json), Object.keys(r.json || {}).slice(0, 8).join(","));

  r = await req(a, "POST", "/api/teams", { name: "Audit Family" });
  record(steps, "create family team", r.status === 201, r.json?.id);

  r = await req(a, "GET", "/api/chores?status=pending");
  record(steps, "list chores after team", r.status === 200 || r.status === 400, String(r.status));

  r = await req(a, "POST", "/api/checkout", { plan: "personal" });
  const checkoutUrl = r.json?.url || "";
  record(
    steps,
    "stripe checkout session",
    r.status === 200 && /^https:\/\/checkout\.stripe\.com\//i.test(checkoutUrl),
    r.json?.error || checkoutUrl.slice(0, 60),
  );

  r = await req(a, "POST", "/api/checkout", { plan: "enterprise" });
  record(steps, "unknown plan blocked", r.status === 400);

  r = await req(a, "POST", "/api/auth/logout", {});
  record(steps, "logout", r.status === 200 || r.status === 204, String(r.status));

  r = await req(a, "GET", "/api/auth/me");
  record(steps, "session cleared", r.status === 401);

  r = await req(b, "POST", "/api/auth/signup", { name: "Audit B", email: emailB, password: pass });
  record(steps, "signup B", r.status === 201, r.json?.error || r.json?.user?.email);

  r = await req(b, "GET", `/api/notes?id=${encodeURIComponent(noteId || "note_missing")}`);
  record(steps, "tenant isolation notes", r.status === 404 || r.json?.note?.id !== noteId, String(r.status));

  r = await req(b, "GET", "/api/memories");
  const leaked = (r.json?.memories || []).some((m) => /March 4/i.test(m.content || ""));
  record(steps, "tenant isolation memories", r.status === 200 && !leaked, leaked ? "LEAK" : "isolated");

  r = await req(cookieJar(), "POST", "/api/auth/login", { email: emailA, password: "wrong-password" });
  record(steps, "login wrong password", r.status === 401);

  const relog = cookieJar();
  r = await req(relog, "POST", "/api/auth/login", { email: emailA, password: pass });
  record(steps, "login A", r.status === 200 && r.json?.user?.email === emailA, r.json?.error);

  const failed = steps.filter((s) => !s.ok);
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    pass: steps.filter((s) => s.ok).length,
    fail: failed.length,
    total: steps.length,
    failed: failed.map((s) => s.name),
    steps,
  };
  console.log(JSON.stringify({ pass: report.pass, fail: report.fail, total: report.total, failed: report.failed }, null, 2));
  return report;
}

const report = await main();
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync("docs", { recursive: true });
writeFileSync("docs/E2E-LAUNCH-AUDIT.json", JSON.stringify(report, null, 2));
process.exit(report.fail ? 1 : 0);
