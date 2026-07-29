/**
 * AmberOne production QA suite — pages, APIs, auth, assets, env presence, links.
 * Uses fetch + Playwright for console/mobile. No secrets printed.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const BASE = process.env.AO_BASE || "https://amberone.pages.dev";
const SITE = "C:\\Users\\michael\\Downloads\\amberone-site";

const PAGES = [
  "/",
  "/index.html",
  "/pricing",
  "/pricing.html",
  "/signup",
  "/signup.html",
  "/login",
  "/login.html",
  "/forgot-password",
  "/forgot-password.html",
  "/reset-password",
  "/reset-password.html",
  "/faq",
  "/faq.html",
  "/privacy",
  "/privacy.html",
  "/terms",
  "/terms.html",
  "/dashboard/",
  "/dashboard/index.html",
  "/dashboard/billing",
  "/dashboard/billing.html",
  "/dashboard/settings",
  "/dashboard/settings.html",
];

const ASSETS = ["/assets/styles.css", "/assets/app.js"];

function sev(level, area, title, detail, fixable = false) {
  return { level, area, title, detail, fixable };
}

async function req(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const started = Date.now();
  const headers = { ...(opts.headers || {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  return {
    url,
    status: res.status,
    ms: Date.now() - started,
    headers: Object.fromEntries(res.headers.entries()),
    text: text.slice(0, 4000),
    json,
    setCookie,
    location: res.headers.get("location"),
  };
}

function extractCookie(setCookie) {
  for (const c of setCookie) {
    const m = String(c).match(/ao_session=[^;]+/);
    if (m) return m[0];
  }
  return null;
}

function extractLinks(html) {
  const hrefs = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
  return [...new Set(hrefs)];
}

const report = {
  at: new Date().toISOString(),
  base: BASE,
  issues: [],
  pages: [],
  assets: [],
  apis: [],
  auth: {},
  env: {},
  browser: {},
  mobile: {},
  performance: {},
  security: {},
  scores: {},
};

// --- Pages ---
for (const path of PAGES) {
  const r = await req(path);
  const ok = r.status >= 200 && r.status < 400;
  const isHtml = /text\/html/i.test(r.headers["content-type"] || "") || r.text.includes("<!DOCTYPE");
  const deploymentNotFound = /Nothing is here yet|Deployment Not Found/i.test(r.text);
  const prettyMissing =
    (path.endsWith(".html") === false &&
      path !== "/" &&
      path !== "/dashboard/" &&
      r.status === 404) ||
    false;
  report.pages.push({
    path,
    status: r.status,
    ms: r.ms,
    ok,
    isHtml,
    deploymentNotFound,
    location: r.location,
  });
  if (!ok || deploymentNotFound) {
    report.issues.push(
      sev(
        path.includes(".html") ? "medium" : "high",
        "pages",
        `Page failed: ${path}`,
        `HTTP ${r.status}${deploymentNotFound ? " (deployment not found)" : ""}${r.location ? ` loc=${r.location}` : ""}`,
        true,
      ),
    );
  }
  if (!path.includes(".html") && path !== "/" && path !== "/dashboard/" && r.status === 404) {
    report.issues.push(
      sev("critical", "routing", `Pretty URL 404: ${path}`, "Extensionless route not serving HTML", true),
    );
  }
}

// --- Assets ---
for (const path of ASSETS) {
  const r = await req(path);
  report.assets.push({ path, status: r.status, ms: r.ms, bytes: r.text.length });
  if (r.status !== 200) {
    report.issues.push(sev("critical", "assets", `Missing asset ${path}`, `HTTP ${r.status}`, true));
  }
}

// --- Env presence via Pages API (from local cf-env) ---
try {
  const cf = JSON.parse(await (await import("node:fs")).promises.readFile(join(SITE, ".tmp/cf-env.json"), "utf8"));
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.CLOUDFLARE_ACCOUNT_ID}/pages/projects/amberone`,
    { headers: { Authorization: `Bearer ${cf.CLOUDFLARE_API_TOKEN}` } },
  );
  const body = await res.json();
  const envVars = body.result?.deployment_configs?.production?.env_vars || {};
  const d1 = body.result?.deployment_configs?.production?.d1_databases || {};
  const required = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "OPENAI_API_KEY",
    "EMAIL_FROM",
    "STRIPE_PRICE_PERSONAL",
    "STRIPE_PRICE_FAMILY_2",
    "STRIPE_PRICE_FAMILY_5",
    "STRIPE_PRICE_FAMILY_10",
    "STRIPE_PRICE_EXECUTIVE",
    "STRIPE_PRICE_BUSINESS_SMALL",
    "STRIPE_PRICE_BUSINESS_MEDIUM",
  ];
  report.env = {
    present: Object.keys(envVars),
    missing: required.filter((k) => !envVars[k]),
    d1Bound: Boolean(d1.DB?.id),
    d1Id: d1.DB?.id || null,
  };
  for (const k of report.env.missing) {
    report.issues.push(sev("critical", "env", `Missing Pages secret ${k}`, "Required for production", true));
  }
  if (!report.env.d1Bound) {
    report.issues.push(sev("critical", "env", "D1 binding missing", "DB not bound on production", true));
  }
} catch (e) {
  report.env = { error: String(e) };
  report.issues.push(sev("high", "env", "Could not verify Pages env", String(e)));
}

// --- Health / Talk / Auth APIs ---
const health = await req("/api/health");
report.apis.push({ name: "health", status: health.status, body: health.json });
if (!health.json?.ok) {
  report.issues.push(sev("critical", "api", "Health check failed", JSON.stringify(health.json || health.text)));
}

const talk = await req("/api/talk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "What is AmberOne Personal?" }),
});
report.apis.push({
  name: "talk",
  status: talk.status,
  source: talk.json?.source,
  hasReply: Boolean(talk.json?.reply),
});
if (!(talk.status === 200 && talk.json?.reply)) {
  report.issues.push(sev("high", "api", "Talk API failed", JSON.stringify(talk.json || { status: talk.status })));
}

const stamp = Date.now();
const email = `qa.prod.${stamp}@example.com`;
const password = "QaPass123!";

const signup = await req("/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "QA Prod" }),
});
const cookie = extractCookie(signup.setCookie);
report.auth.signup = { status: signup.status, ok: signup.status === 201, hasCookie: Boolean(cookie), body: signup.json };
if (signup.status !== 201) {
  report.issues.push(sev("critical", "auth", "Signup failed", JSON.stringify(signup.json || { status: signup.status })));
}

const me = await req("/api/auth/me", { cookie });
report.auth.me = { status: me.status, ok: me.status === 200 && Boolean(me.json?.user) };
if (!report.auth.me.ok) {
  report.issues.push(sev("critical", "auth", "Session /me failed after signup", JSON.stringify(me.json)));
}

const checkout = await req("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  cookie,
  body: JSON.stringify({ plan: "personal" }),
});
report.apis.push({
  name: "checkout",
  status: checkout.status,
  hasUrl: Boolean(checkout.json?.url),
  urlPrefix: checkout.json?.url ? String(checkout.json.url).slice(0, 32) : null,
});
if (!(checkout.status === 200 && checkout.json?.url?.includes("checkout.stripe.com"))) {
  report.issues.push(
    sev("critical", "api", "Checkout failed", JSON.stringify(checkout.json || { status: checkout.status })),
  );
}

const billing = await req("/api/billing", { cookie });
report.apis.push({ name: "billing", status: billing.status, ok: billing.status === 200 });
if (billing.status !== 200) {
  report.issues.push(sev("high", "api", "Billing API failed", JSON.stringify(billing.json)));
}

const portal = await req("/api/portal", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  cookie,
  body: "{}",
});
report.apis.push({
  name: "portal",
  status: portal.status,
  body: portal.json,
  note: "May 400 without stripe customer — expected pre-payment",
});
if (portal.status >= 500) {
  report.issues.push(sev("high", "api", "Portal API 5xx", JSON.stringify(portal.json)));
}

const forgot = await req("/api/auth/forgot-password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});
report.auth.forgot = {
  status: forgot.status,
  ok: forgot.status === 200,
  hasResetUrl: Boolean(forgot.json?.resetUrl),
  body: {
    ok: forgot.json?.ok,
    message: forgot.json?.message,
    hasResetUrl: Boolean(forgot.json?.resetUrl),
  },
};
if (forgot.status !== 200) {
  report.issues.push(sev("high", "auth", "Forgot password failed", JSON.stringify(forgot.json)));
}
if (forgot.json?.resetUrl) {
  report.issues.push(
    sev(
      "high",
      "security",
      "Forgot password leaked resetUrl in production",
      "Reset tokens must not be returned in API responses on public hosts",
      true,
    ),
  );
}

let resetOk = false;
// Production no longer returns resetUrl. Create reset token via direct DB path is unavailable —
// verify reset endpoint rejects bad tokens and forgot returns generic success.
const resetBad = await req("/api/auth/reset-password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: "invalid", password: "QaPass456!" }),
});
report.auth.resetRejectsBadToken = {
  status: resetBad.status,
  ok: resetBad.status >= 400,
};
if (resetBad.status < 400) {
  report.issues.push(sev("critical", "auth", "Reset accepted invalid token", JSON.stringify(resetBad.json)));
}

// Keep login using original password (reset not exercised without email/token)
resetOk = false;

if (false && forgot.json?.resetUrl) {
  const u = new URL(forgot.json.resetUrl);
  const token = u.searchParams.get("token");
  const reset = await req("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: "QaPass456!" }),
  });
  report.auth.reset = { status: reset.status, ok: reset.status === 200, body: reset.json };
  resetOk = reset.status === 200;
  if (!resetOk) {
    report.issues.push(sev("high", "auth", "Reset password failed", JSON.stringify(reset.json)));
  }
} else {
  report.auth.reset = {
    status: null,
    ok: null,
    note: "Skipped end-to-end reset (production withholds resetUrl; email path used)",
  };
}

const loginNew = await req("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: resetOk ? "QaPass456!" : password }),
});
const loginCookie = extractCookie(loginNew.setCookie) || cookie;
report.auth.login = { status: loginNew.status, ok: loginNew.status === 200 };
if (!report.auth.login.ok) {
  report.issues.push(sev("critical", "auth", "Login failed", JSON.stringify(loginNew.json)));
}

const logout = await req("/api/auth/logout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  cookie: loginCookie,
  body: "{}",
});
report.auth.logout = { status: logout.status, ok: logout.status === 200 || logout.status === 204 };
const meAfter = await req("/api/auth/me", { cookie: loginCookie });
report.auth.meAfterLogout = { status: meAfter.status, stillAuthed: Boolean(meAfter.json?.user) };
if (meAfter.json?.user) {
  report.issues.push(sev("high", "auth", "Session still valid after logout", "Cookie/session not cleared"));
}

const webhook = await req("/api/webhook", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
report.apis.push({ name: "webhook", status: webhook.status, body: webhook.json });
if (webhook.status === 200) {
  report.issues.push(sev("high", "security", "Webhook accepted empty body", "Should reject invalid signatures"));
}

// --- Link crawl from homepage + pricing ---
const homeHtml = (await req("/")).text;
const pricingHtml = (await req("/pricing.html")).text;
const allLinks = [...extractLinks(homeHtml), ...extractLinks(pricingHtml)];
const internal = allLinks.filter((h) => h.startsWith("/") || h.startsWith("#") || h.startsWith(BASE));
report.linkSamples = internal.slice(0, 40);
for (const href of internal) {
  if (href.startsWith("#") || href.startsWith("mailto:") || href === "#") continue;
  const path = href.startsWith("http") ? new URL(href).pathname : href.split("#")[0];
  if (!path || path === "/") continue;
  const r = await req(path);
  if (r.status >= 400) {
    report.issues.push(sev("high", "links", `Broken link ${href}`, `HTTP ${r.status}`, true));
  }
}

// --- Playwright: console errors + mobile ---
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext();
  const page = await desktop.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const pathsToVisit = ["/", "/pricing.html", "/signup.html", "/login.html", "/faq.html", "/privacy.html", "/terms.html"];
  const navResults = [];
  for (const p of pathsToVisit) {
    const resp = await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 45000 });
    navResults.push({ path: p, status: resp?.status(), title: await page.title() });
    // click primary CTAs if present
    const buttons = await page.locator("a.btn, button.btn, .nav-cta").all();
    report.browser.buttonCount = (report.browser.buttonCount || 0) + buttons.length;
  }

  // Mobile viewport
  const iPhone = devices["iPhone 13"];
  const mobile = await browser.newContext({ ...iPhone });
  const mpage = await mobile.newPage();
  const mConsole = [];
  mpage.on("console", (msg) => {
    if (msg.type() === "error") mConsole.push(msg.text());
  });
  await mpage.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
  const toggle = mpage.locator("[data-nav-toggle]");
  const toggleVisible = await toggle.isVisible().catch(() => false);
  if (toggleVisible) await toggle.click();
  const navOpen = await mpage.locator("[data-nav-links].is-open").count();
  const overflow = await mpage.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  });

  // Auth UI flow on signup page
  await page.goto(`${BASE}/signup.html`, { waitUntil: "networkidle" });
  const formVisible = await page.locator("form").first().isVisible();

  report.browser = {
    consoleErrors: [...new Set(consoleErrors)].slice(0, 30),
    pageErrors: [...new Set(pageErrors)].slice(0, 30),
    navResults,
    formVisible,
  };
  report.mobile = {
    consoleErrors: [...new Set(mConsole)].slice(0, 20),
    toggleVisible,
    navOpenAfterToggle: navOpen,
    overflow,
  };

  if (consoleErrors.length) {
    report.issues.push(sev("high", "browser", "Desktop console errors", consoleErrors.slice(0, 5).join(" | ")));
  }
  if (pageErrors.length) {
    report.issues.push(sev("critical", "browser", "Uncaught page errors", pageErrors.slice(0, 5).join(" | ")));
  }
  if (overflow.hasHorizontalOverflow) {
    report.issues.push(
      sev(
        "medium",
        "mobile",
        "Horizontal overflow on mobile",
        `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`,
        true,
      ),
    );
  }
  if (!toggleVisible) {
    report.issues.push(sev("medium", "mobile", "Nav toggle not visible on iPhone", "Check mobile nav CSS", true));
  }

  await desktop.close();
  await mobile.close();
} catch (e) {
  report.browser = { error: String(e) };
  report.issues.push(sev("high", "browser", "Playwright QA failed", String(e)));
} finally {
  await browser?.close();
}

// Performance rough score from timings
const pageMs = report.pages.filter((p) => p.ok).map((p) => p.ms);
const avg = pageMs.length ? pageMs.reduce((a, b) => a + b, 0) / pageMs.length : 9999;
const p95 = pageMs.length ? pageMs.sort((a, b) => a - b)[Math.floor(pageMs.length * 0.95)] : 9999;
report.performance = { avgMs: Math.round(avg), p95Ms: p95, assetMs: report.assets.map((a) => a.ms) };

// Security checks
const homeSec = await req("/");
report.security = {
  https: BASE.startsWith("https"),
  hasHsts: Boolean(homeSec.headers["strict-transport-security"]),
  xfo: homeSec.headers["x-frame-options"] || null,
  csp: homeSec.headers["content-security-policy"] || null,
  webhookRejectsBad: webhook.status >= 400,
  cookiesHttpOnlyNoted: true,
};

// Pretty URL diagnosis
const prettyPaths = ["/pricing", "/signup", "/login", "/faq", "/privacy", "/terms"];
const prettyFails = report.pages.filter((p) => prettyPaths.includes(p.path) && (p.status >= 400 || p.deploymentNotFound));
if (prettyFails.length) {
  report.prettyUrlBroken = true;
}

// Scores
const critical = report.issues.filter((i) => i.level === "critical").length;
const high = report.issues.filter((i) => i.level === "high").length;
const medium = report.issues.filter((i) => i.level === "medium").length;
const perfScore = Math.max(0, Math.min(100, Math.round(100 - avg / 20 - (p95 > 2000 ? 15 : 0))));
const securityScore =
  (report.security.https ? 30 : 0) +
  (report.security.webhookRejectsBad ? 25 : 0) +
  (report.security.hasHsts ? 15 : 5) +
  (report.env.d1Bound ? 15 : 0) +
  (report.env.missing?.length === 0 ? 15 : 0);
const readiness = Math.max(
  0,
  Math.min(
    100,
    100 - critical * 20 - high * 8 - medium * 3 - (report.prettyUrlBroken ? 10 : 0),
  ),
);

report.scores = {
  performance: perfScore,
  security: Math.min(100, securityScore),
  productionReadinessPercent: readiness,
  issueCounts: { critical, high, medium, low: report.issues.filter((i) => i.level === "low").length },
};

report.launch = {
  readyForPublicLaunch: critical === 0 && high === 0,
  remainingIssues: report.issues.filter((i) => i.level === "critical" || i.level === "high"),
  allIssues: report.issues,
};

mkdirSync(join(SITE, "docs"), { recursive: true });
writeFileSync(join(SITE, "docs/PROD-QA-REPORT.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      at: report.at,
      scores: report.scores,
      launchReady: report.launch.readyForPublicLaunch,
      issueCounts: report.scores.issueCounts,
      issues: report.issues,
      auth: report.auth,
      envMissing: report.env.missing,
      prettyUrlBroken: report.prettyUrlBroken || false,
      pagesSummary: report.pages.map((p) => `${p.path}:${p.status}`),
      browserConsole: report.browser.consoleErrors,
      mobile: report.mobile,
    },
    null,
    2,
  ),
);
process.exit(critical || high ? 2 : 0);
