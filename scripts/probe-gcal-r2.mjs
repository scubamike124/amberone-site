/** Live probe: Google Calendar redirect + R2. Never prints secrets. */
const BASE = process.env.AO_BASE || "https://amberoneai.com";
const pass = "HandsOnPass9!";
const email = `ao.gcal2.${Date.now().toString(36)}@example.com`;
const cookies = [];

async function req(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text: text.slice(0, 240), location: res.headers.get("location") };
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
await req("POST", "/api/auth/signup", { name: "GCal Verify", email, password: pass });
const oauth = await req("GET", "/api/google-calendar-oauth");
const loc = oauth.location || "";
let google = { status: null, mismatch: false, title: null };
if (/accounts\.google\.com/.test(loc)) {
  const g = await fetch(loc, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await g.text();
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  google = {
    status: g.status,
    mismatch: /redirect_uri_mismatch|Error 400: redirect/i.test(html),
    hasSignIn: /identifierId|Sign in|accounts.google/i.test(html),
    title: titleMatch ? titleMatch[1] : null,
  };
}
const wwwHealth = await fetch("https://www.amberoneai.com/api/health").then((r) => r.json().catch(() => ({})));
const files = await req("POST", "/api/files", {
  name: "probe.txt",
  content_type: "text/plain",
  content_base64: Buffer.from("r2-ok").toString("base64"),
});
const sync = await req("POST", "/api/calendar-sync", {});
console.log(
  JSON.stringify(
    {
      health,
      wwwHealth: { ok: wwwHealth.ok, r2: wwwHealth.r2, googleCalendarOAuth: wwwHealth.googleCalendarOAuth },
      oauth: {
        status: oauth.status,
        toGoogle: /accounts\.google\.com/.test(loc),
        hasCallback: /amberoneai\.com/.test(loc),
      },
      google,
      files: { status: files.status, ok: files.status === 201, code: files.json?.code || null },
      sync: { status: sync.status, error: sync.json?.error || null },
    },
    null,
    2,
  ),
);
