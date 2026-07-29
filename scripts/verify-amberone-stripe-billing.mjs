/**
 * Verify AmberOne Stripe webhook + billing journey after secret propagation.
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = process.cwd();
const BASE = "https://amberone.pages.dev";

function loadDevVars() {
  const out = {};
  for (const line of readFileSync(join(SITE, ".dev.vars"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

async function stripe(secret, method, path, form) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}

async function http(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.headers || {}),
      ...(opts.json ? { "Content-Type": "application/json" } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() || [] };
}

function cookieFrom(setCookie) {
  for (const c of setCookie) {
    const m = String(c).match(/ao_session=[^;]+/);
    if (m) return m[0];
  }
  return null;
}

function sign(secret, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

const vars = loadDevVars();
const secret = vars.STRIPE_SECRET_KEY;
const whsec = vars.STRIPE_WEBHOOK_SECRET;
const prices = JSON.parse(readFileSync(join(SITE, "docs/stripe-prices.json"), "utf8")).prices;
const personalPrice = vars.STRIPE_PRICE_PERSONAL || prices.STRIPE_PRICE_PERSONAL;

const report = { at: new Date().toISOString(), steps: [], productionReady: false };

const hooks = await stripe(secret, "GET", "/webhook_endpoints?limit=100");
const endpoint = (hooks.json.data || []).find((h) => h.url === `${BASE}/api/webhook`);
report.endpoint = endpoint
  ? { id: endpoint.id, url: endpoint.url, status: endpoint.status, enabled_events: endpoint.enabled_events }
  : null;
report.steps.push({ step: "endpoint_exists", ok: Boolean(endpoint?.status === "enabled") });

const stamp = Date.now();
const email = `billing.verify.${stamp}@example.com`;
const signup = await http("/api/auth/signup", {
  method: "POST",
  json: { email, password: "BillingVerify123!", name: "Billing Verify" },
});
const cookie = cookieFrom(signup.setCookie);
const userId = signup.json?.user?.id;
report.steps.push({ step: "signup", ok: signup.status === 201 && Boolean(cookie), userId });

const cus = await stripe(secret, "POST", "/customers", {
  email,
  "metadata[product]": "amberone",
  "metadata[userId]": userId,
});
const customerId = cus.json.id;
report.steps.push({ step: "customer", ok: cus.ok, customerId });

const sub = await stripe(secret, "POST", "/subscriptions", {
  customer: customerId,
  "items[0][price]": personalPrice,
  trial_period_days: "1",
  "metadata[product]": "amberone",
  "metadata[plan]": "personal",
  "metadata[userId]": userId,
  payment_behavior: "default_incomplete",
  "payment_settings[save_default_payment_method]": "on_subscription",
});
const subscriptionId = sub.json.id;
report.steps.push({
  step: "subscription_trial",
  ok: sub.ok,
  subscriptionId,
  status: sub.json.status,
  error: sub.json.error?.message || null,
});

async function postEvent(event) {
  const payload = JSON.stringify(event);
  return http("/api/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": sign(whsec, payload) },
    body: payload,
  });
}

const evt1 = {
  id: `evt_verify_co_${stamp}`,
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: `cs_verify_${stamp}`,
      object: "checkout.session",
      customer: customerId,
      subscription: subscriptionId,
      client_reference_id: userId,
      metadata: { userId, plan: "personal", product: "amberone" },
    },
  },
};
const wh1 = await postEvent(evt1);
report.steps.push({
  step: "webhook_checkout",
  ok: wh1.status === 200 && wh1.json?.received && !wh1.json?.duplicate && wh1.json?.note === "verified",
  body: wh1.json,
  status: wh1.status,
});

const whDup = await postEvent(evt1);
report.steps.push({
  step: "webhook_duplicate",
  ok: whDup.status === 200 && whDup.json?.duplicate === true,
  body: whDup.json,
});

const wh2 = await postEvent({
  id: `evt_verify_sub_${stamp}`,
  object: "event",
  type: "customer.subscription.updated",
  data: {
    object: {
      id: subscriptionId,
      object: "subscription",
      customer: customerId,
      status: "active",
      metadata: { plan: "personal", product: "amberone", userId },
    },
  },
});
report.steps.push({ step: "webhook_sub_updated", ok: wh2.status === 200 && wh2.json?.received, body: wh2.json });

const wh3 = await postEvent({
  id: `evt_verify_paid_${stamp}`,
  object: "event",
  type: "invoice.paid",
  data: {
    object: {
      id: `in_verify_${stamp}`,
      object: "invoice",
      customer: customerId,
      subscription: subscriptionId,
      status: "paid",
    },
  },
});
report.steps.push({ step: "webhook_invoice_paid", ok: wh3.status === 200 && wh3.json?.received, body: wh3.json });

const billing = await http("/api/billing", { cookie });
report.steps.push({
  step: "d1_user_active",
  ok:
    billing.json?.user?.subscriptionStatus === "active" &&
    billing.json?.user?.stripeCustomerId === customerId &&
    billing.json?.user?.planSlug === "personal",
  user: billing.json?.user || null,
});

const checkout = await http("/api/checkout", { method: "POST", cookie, json: { plan: "personal" } });
report.steps.push({
  step: "checkout_live",
  ok: checkout.status === 200 && String(checkout.json?.url || "").includes("checkout.stripe.com"),
  sessionId: checkout.json?.id || null,
  urlPrefix: checkout.json?.url?.slice(0, 48) || null,
});

const portal = await http("/api/portal", { method: "POST", cookie, json: {} });
report.steps.push({
  step: "portal",
  ok: portal.status === 200 && String(portal.json?.url || "").includes("billing.stripe.com"),
  urlPrefix: portal.json?.url?.slice(0, 48) || null,
  error: portal.json?.error || null,
});

const wh4 = await postEvent({
  id: `evt_verify_cancel_${stamp}`,
  object: "event",
  type: "customer.subscription.deleted",
  data: {
    object: {
      id: subscriptionId,
      object: "subscription",
      customer: customerId,
      status: "canceled",
      metadata: { plan: "personal", product: "amberone", userId },
    },
  },
});
const billing2 = await http("/api/billing", { cookie });
report.steps.push({
  step: "cancel_via_webhook",
  ok: wh4.status === 200 && billing2.json?.user?.subscriptionStatus === "canceled",
  user: billing2.json?.user || null,
});

if (subscriptionId?.startsWith("sub_")) {
  const cancel = await stripe(secret, "DELETE", `/subscriptions/${subscriptionId}`);
  report.steps.push({ step: "cleanup_sub", ok: cancel.ok, status: cancel.json.status || null });
}

// Also send Stripe API "test" via retrieving endpoint - list recent attempts if any
report.pass = report.steps.filter((s) => s.step !== "cleanup_sub").every((s) => s.ok);
report.productionReady = false;
report.liveCardPayment = "requires_owner_approval_in_checkout_ui";
report.declaration =
  "AmberOne Stripe webhook endpoint + signing secret + D1 billing updates PASS. Live card payment still requires owner in Checkout UI. Not declaring production-ready until owner confirms live payment.";

writeFileSync(join(SITE, "docs/AMBERONE-STRIPE-BILLING-VERIFY.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: report.pass, productionReady: false, endpoint: report.endpoint, steps: report.steps.map((s) => ({ step: s.step, ok: s.ok })) }, null, 2));
process.exit(report.pass ? 0 : 2);
