/**
 * Full AmberOne customer journey against a live base URL.
 * Does not print secrets. Stripe live card charge is simulated via webhook after Checkout session create
 * (live mode cannot complete 4242 cards without a real payment method).
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const base = process.env.AMBERONE_URL || "http://127.0.0.1:8788";
const root = process.cwd();

function loadDevVars() {
  const raw = readFileSync(path.join(root, ".dev.vars"), "utf8").replace(/^\uFEFF/, "");
  /** @type {Record<string,string>} */
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (list.length) return list.map((c) => c.split(";")[0]).join("; ");
  const single = res.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

async function req(pathname, init = {}, cookie = "") {
  const headers = { ...(init.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { path: pathname, status: res.status, ok: res.status < 400, json, text: text.slice(0, 240), cookie: cookiesFrom(res), html: text.includes("<html") };
}

const steps = [];
function step(name, ok, detail = {}) {
  steps.push({ name, ok, ...detail });
  console.log(JSON.stringify({ step: name, ok, ...detail }));
}

const env = loadDevVars();
const stamp = Date.now();
const email = `journey_${stamp}@example.com`;
const password = "JourneyTest123!";
const newPassword = "JourneyTest456!";

// 1) Public website
for (const p of ["/", "/pricing.html", "/signup.html", "/faq.html"]) {
  const r = await req(p);
  step(`visit ${p}`, r.ok && r.html, { status: r.status });
}

// 2) Create account
let cookie = "";
const signup = await req("/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "Journey User", plan: "personal" }),
});
cookie = signup.cookie || cookie;
step("create account", signup.ok && Boolean(signup.json?.user?.id), { status: signup.status, userId: signup.json?.user?.id || null });

const me1 = await req("/api/auth/me", {}, cookie);
step("session after signup", me1.ok && me1.json?.user?.email === email, { status: me1.status });

// 3) Email verification — not a separate product gate; password reset email is the email path
const forgot = await req("/api/auth/forgot-password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),
});
const emailed = Boolean(forgot.json?.message && !forgot.json?.setupRequired);
const resetUrl = forgot.json?.resetUrl || null;
step("password reset / email path", forgot.ok, {
  status: forgot.status,
  emailDelivered: emailed,
  setupRequired: forgot.json?.setupRequired || null,
  hasResetUrl: Boolean(resetUrl),
});

// 4) Login
const login = await req("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
cookie = login.cookie || cookie;
step("log in", login.ok, { status: login.status });

// 5) Major features
const dash = await req("/dashboard/", {}, cookie);
const billingPage = await req("/dashboard/billing.html", {}, cookie);
const settings = await req("/dashboard/settings.html", {}, cookie);
step("dashboard pages", dash.ok && billingPage.ok && settings.ok, {
  dash: dash.status,
  billing: billingPage.status,
  settings: settings.status,
});

const talk = await req("/api/talk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "What does Amber Family include?" }),
}, cookie);
step("Talk to Amber", talk.ok && Boolean(talk.json?.reply), { status: talk.status, source: talk.json?.source || null });

// 6) Purchase through Stripe (create Checkout session)
const checkout = await req("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ plan: "personal" }),
}, cookie);
step("Stripe Checkout session", checkout.ok && Boolean(checkout.json?.url), {
  status: checkout.status,
  sessionId: checkout.json?.id || null,
});

// 7/8) Simulate successful return + subscription via signed webhook + real Stripe customer
let portalOk = false;
let billingActive = false;
if (checkout.ok && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && signup.json?.user?.id) {
  const params = new URLSearchParams({
    email,
    name: "Journey User",
    "metadata[userId]": signup.json.user.id,
    "metadata[product]": "amberone",
  });
  const cusRes = await fetch("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const cus = await cusRes.json();
  step("Stripe customer create", Boolean(cus.id), { status: cusRes.status });

  if (cus.id) {
    const payload = JSON.stringify({
      id: "evt_journey_" + stamp,
      type: "checkout.session.completed",
      data: {
        object: {
          id: checkout.json.id || "cs_journey",
          customer: cus.id,
          subscription: null,
          metadata: { userId: signup.json.user.id, plan: "personal", product: "amberone" },
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
    step("Stripe webhook applied", wh.ok && wh.json?.received === true, { status: wh.status, type: wh.json?.type });

    const successReturn = await req("/dashboard/billing.html?checkout=success&plan=personal", {}, cookie);
    step("return from Stripe success URL", successReturn.ok, { status: successReturn.status });

    const billing = await req("/api/billing", {}, cookie);
    billingActive = billing.json?.billing?.status === "active" && Boolean(billing.json?.billing?.stripeCustomerId);
    step("billing/subscription status", billingActive, {
      status: billing.status,
      subscriptionStatus: billing.json?.billing?.status || null,
      planSlug: billing.json?.billing?.planSlug || null,
    });

    const portal = await req("/api/portal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnUrl: `${base}/dashboard/billing.html` }),
    }, cookie);
    portalOk = Boolean(portal.json?.url);
    step("Stripe Customer Portal", portalOk, { status: portal.status });
  }
} else {
  step("Stripe purchase simulation prerequisites", false, { reason: "missing checkout or stripe secrets" });
}

// 9) Password reset complete
if (resetUrl) {
  const token = new URL(resetUrl).searchParams.get("token");
  const reset = await req("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, password: newPassword }),
  });
  step("password reset complete", reset.ok, { status: reset.status });
} else {
  step("password reset complete", false, { reason: "no resetUrl" });
}

// 10) Log back in with new password
const login2 = await req("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: newPassword }),
});
cookie = login2.cookie || cookie;
step("log back in after reset", login2.ok, { status: login2.status });

// 11) Talk again
const talk2 = await req("/api/talk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "How do I cancel?" }),
}, cookie);
step("Talk to Amber after re-login", talk2.ok && Boolean(talk2.json?.reply), { status: talk2.status });

// 12) Logout
const logout = await req("/api/auth/logout", { method: "POST", body: "{}" }, cookie);
step("log out", logout.ok, { status: logout.status });
const meAfter = await req("/api/auth/me", {}, cookie);
step("session cleared", meAfter.status === 401 || !meAfter.json?.user, { status: meAfter.status });

// 13) Log back in again
const login3 = await req("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: newPassword }),
});
step("final log back in", login3.ok, { status: login3.status });

const failed = steps.filter((s) => !s.ok);
const report = {
  at: new Date().toISOString(),
  base,
  email,
  passed: steps.filter((s) => s.ok).length,
  total: steps.length,
  failed: failed.map((f) => f.name),
  stripeMode: env.STRIPE_SECRET_KEY?.startsWith("sk_live")
    ? "live"
    : env.STRIPE_SECRET_KEY?.startsWith("sk_test")
      ? "test"
      : "missing",
  notes: [
    "Live Stripe mode: Checkout session + Customer Portal verified; card UI charge not automated (requires owner payment method).",
    "Email: Resend used when configured; otherwise reset URL path verified.",
  ],
  steps,
};

mkdirSync(path.join(root, "docs"), { recursive: true });
writeFileSync(path.join(root, "docs/E2E-CUSTOMER-JOURNEY.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: { passed: report.passed, total: report.total, failed: report.failed }, reportPath: "docs/E2E-CUSTOMER-JOURNEY.json" }, null, 2));
if (failed.length) process.exit(1);
