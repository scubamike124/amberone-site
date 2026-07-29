const base = process.env.AMBERONE_URL || "http://127.0.0.1:8788";

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (raw.length) return raw.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function check(path, init = {}, cookie = "") {
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return {
    path,
    status: res.status,
    ok: res.status < 400,
    json,
    cookie: parseSetCookie(res),
    text: text.slice(0, 180),
  };
}

const pages = [
  "/",
  "/pricing.html",
  "/signup.html",
  "/login.html",
  "/forgot-password.html",
  "/reset-password.html",
  "/faq.html",
  "/privacy.html",
  "/terms.html",
  "/dashboard/",
  "/dashboard/billing.html",
  "/dashboard/settings.html",
  "/assets/styles.css",
  "/assets/app.js",
];

const results = [];
for (const p of pages) results.push(await check(p));

const email = `smoke_${Date.now()}@example.com`;
const password = "LaunchTest123!";
const signup = await check("/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "Smoke", plan: "personal" }),
});
results.push({ ...signup, path: "POST /api/auth/signup" });
let cookie = signup.cookie;

const me = await check("/api/auth/me", {}, cookie);
results.push({ ...me, path: "GET /api/auth/me" });

const login = await check("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
results.push({ ...login, path: "POST /api/auth/login" });
cookie = login.cookie || cookie;

const forgot = await check("/api/auth/forgot-password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});
results.push({ ...forgot, path: "POST /api/auth/forgot-password" });

let resetOk = false;
if (forgot.json?.resetUrl) {
  const token = new URL(forgot.json.resetUrl).searchParams.get("token");
  const reset = await check("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "LaunchTest1234!" }),
  });
  results.push({ ...reset, path: "POST /api/auth/reset-password" });
  resetOk = reset.ok;
  const relogin = await check("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "LaunchTest1234!" }),
  });
  results.push({ ...relogin, path: "POST /api/auth/login after reset" });
  cookie = relogin.cookie || cookie;
}

const talk = await check("/api/talk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "What plans do you offer?" }),
});
results.push({ ...talk, path: "POST /api/talk" });

const checkout = await check(
  "/api/checkout",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "personal" }),
  },
  cookie,
);
results.push({ ...checkout, path: "POST /api/checkout" });

const billing = await check("/api/billing", {}, cookie);
results.push({ ...billing, path: "GET /api/billing" });

const portal = await check(
  "/api/portal",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  },
  cookie,
);
results.push({ ...portal, path: "POST /api/portal" });

const logout = await check("/api/auth/logout", { method: "POST", body: "{}" }, cookie);
results.push({ ...logout, path: "POST /api/auth/logout" });

const pagePass = results.filter((r) => pages.includes(r.path) && r.ok).length;
const report = {
  base,
  pagePass,
  pageTotal: pages.length,
  signupOk: signup.ok,
  meOk: me.ok,
  loginOk: login.ok,
  forgotOk: forgot.ok,
  resetOk,
  talkOk: talk.ok,
  checkoutOk: Boolean(checkout.json?.url) || checkout.status === 503,
  billingOk: billing.ok,
  portalExpectedWithoutCustomer: portal.status === 400 || portal.ok,
  logoutOk: logout.ok,
  checkout: checkout.json,
  portal: portal.json,
  results: results.map(({ path, status, ok, json }) => ({ path, status, ok, json: json && { ...json, url: json.url ? "[stripe-url]" : undefined } })),
};

console.log(JSON.stringify(report, null, 2));

const criticalFail =
  pagePass < pages.length ||
  !signup.ok ||
  !me.ok ||
  !login.ok ||
  !forgot.ok ||
  !talk.ok ||
  !billing.ok ||
  !logout.ok;
if (criticalFail) process.exit(1);
