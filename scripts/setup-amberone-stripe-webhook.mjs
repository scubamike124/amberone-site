/**
 * Create AmberOne-only Stripe live webhook, push whsec to Pages, redeploy, verify E2E.
 * Does not overwrite other sites' webhook endpoints. Never prints full secrets.
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SITE = "C:\\Users\\michael\\Downloads\\amberone-site";
const HQ = "C:\\Users\\michael\\Documents\\New folder\\amberAI delelopment manager";
const WEBHOOK_URL = "https://amberone.pages.dev/api/webhook";
const BASE = "https://amberone.pages.dev";

const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const PRICE_KEYS = [
  "STRIPE_PRICE_PERSONAL",
  "STRIPE_PRICE_FAMILY_2",
  "STRIPE_PRICE_FAMILY_5",
  "STRIPE_PRICE_FAMILY_10",
  "STRIPE_PRICE_EXECUTIVE",
  "STRIPE_PRICE_BUSINESS_SMALL",
  "STRIPE_PRICE_BUSINESS_MEDIUM",
];

function fp(v) {
  if (!v) return null;
  const s = String(v).trim();
  return { length: s.length, first4: s.slice(0, 4), last4: s.slice(-4) };
}

function loadDevVars() {
  const p = join(SITE, ".dev.vars");
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function saveDevVar(key, value) {
  const p = join(SITE, ".dev.vars");
  let text = existsSync(p) ? readFileSync(p, "utf8").replace(/^\uFEFF/, "") : "";
  const lines = text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(key + "=")) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(p, next.filter((l, idx, arr) => !(l === "" && idx === arr.length - 1)).join("\n") + (text.endsWith("\n") ? "\n" : "\n"));
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
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function http(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
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
  return {
    status: res.status,
    json,
    text: text.slice(0, 1000),
    setCookie: res.headers.getSetCookie?.() || [],
  };
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
  return { header: `t=${ts},v1=${sig}`, ts };
}

const report = { at: new Date().toISOString(), steps: [], productionReady: false };

const vars = loadDevVars();
const cf = JSON.parse(readFileSync(join(SITE, ".tmp/cf-env.json"), "utf8"));
const secret = vars.STRIPE_SECRET_KEY;
if (!secret?.startsWith("sk_live_")) {
  report.error = "STRIPE_SECRET_KEY missing or not live in .dev.vars";
  writeFileSync(join(SITE, "docs/AMBERONE-STRIPE-WEBHOOK-SETUP.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const account = await stripe(secret, "GET", "/account");
report.account = {
  id: account.json.id,
  chargesEnabled: account.json.charges_enabled,
  mode: "live",
  keyFingerprint: fp(secret),
};
report.steps.push({ step: "identify_stripe_account", ok: account.ok, accountId: account.json.id });

// Verify all 7 prices belong to this account / live
const pricesDoc = JSON.parse(readFileSync(join(SITE, "docs/stripe-prices.json"), "utf8")).prices;
const priceChecks = [];
for (const key of PRICE_KEYS) {
  const id = vars[key] || pricesDoc[key];
  const pr = await stripe(secret, "GET", `/prices/${id}`);
  priceChecks.push({
    key,
    id,
    ok: pr.ok && pr.json.active !== false && !String(pr.json.id || "").includes("test"),
    livemode: pr.json.livemode ?? null,
    active: pr.json.active ?? null,
    unitAmount: pr.json.unit_amount ?? null,
    error: pr.json.error?.message || null,
  });
}
report.priceChecks = priceChecks;
report.steps.push({
  step: "verify_live_prices_same_account",
  ok: priceChecks.every((p) => p.ok && p.livemode === true),
  detail: `${priceChecks.filter((p) => p.ok).length}/7 ok`,
});

// List existing webhooks — create AmberOne if missing
const hooks = await stripe(secret, "GET", "/webhook_endpoints?limit=100");
const list = Array.isArray(hooks.json.data) ? hooks.json.data : [];
let existing = list.find((h) => String(h.url || "").replace(/\/$/, "") === WEBHOOK_URL.replace(/\/$/, ""));
let webhookSecret = null;
let webhookId = existing?.id || null;

if (existing) {
  report.steps.push({
    step: "webhook_endpoint",
    ok: true,
    created: false,
    id: existing.id,
    status: existing.status,
    note: "Endpoint already exists — cannot retrieve existing signing secret via API. Will rotate by deleting+recreating if Pages secret may be stale, OR keep and require secret from create-only path.",
  });
  // If endpoint exists but we don't have matching secret, delete and recreate to get a fresh AmberOne-only secret
  // Safer: update enabled_events on existing, then create won't return secret — use webhook endpoint secret rotate
  // Stripe: POST /v1/webhook_endpoints/:id with enabled_events
  const form = { description: "AmberOne production webhooks (portfolio)" };
  EVENTS.forEach((e, i) => {
    form[`enabled_events[${i}]`] = e;
  });
  form["metadata[product]"] = "amberone";
  form["metadata[business]"] = "amberone";
  const updated = await stripe(secret, "POST", `/webhook_endpoints/${existing.id}`, form);
  report.steps.push({
    step: "update_existing_endpoint_events",
    ok: updated.ok,
    status: updated.status,
    error: updated.json.error?.message || null,
  });

  // Rotate secret: delete + recreate only if we don't already have a working AmberOne whsec in .dev.vars
  // Test current Pages/local secret against production first
  const probePayload = JSON.stringify({
    id: `evt_probe_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: "cs_probe", object: "checkout.session", metadata: {} } },
  });
  const localWh = vars.STRIPE_WEBHOOK_SECRET;
  let localWorks = false;
  if (localWh?.startsWith("whsec_")) {
    const { header } = sign(localWh, probePayload);
    const probe = await http("/api/webhook", {
      method: "POST",
      headers: { "stripe-signature": header, "Content-Type": "application/json" },
      body: probePayload,
    });
    localWorks = probe.status === 200 && probe.json?.received === true;
  }
  if (!localWorks) {
    // Recreate endpoint to obtain a fresh secret (do not touch other URLs)
    const del = await stripe(secret, "DELETE", `/webhook_endpoints/${existing.id}`);
    report.steps.push({ step: "delete_stale_amberone_endpoint", ok: del.ok, status: del.status });
    existing = null;
    webhookId = null;
  } else {
    webhookSecret = localWh;
    report.steps.push({ step: "reuse_working_amberone_whsec", ok: true, fingerprint: fp(localWh) });
  }
}

if (!existing) {
  const form = {
    url: WEBHOOK_URL,
    description: "AmberOne production webhooks (portfolio)",
    "metadata[product]": "amberone",
    "metadata[business]": "amberone",
  };
  EVENTS.forEach((e, i) => {
    form[`enabled_events[${i}]`] = e;
  });
  const created = await stripe(secret, "POST", "/webhook_endpoints", form);
  webhookId = created.json.id;
  webhookSecret = created.json.secret || null;
  report.steps.push({
    step: "create_webhook_endpoint",
    ok: created.ok && Boolean(webhookSecret),
    id: webhookId,
    url: created.json.url,
    status: created.json.status,
    enabledEvents: EVENTS,
    secretFingerprint: fp(webhookSecret),
    error: created.json.error?.message || null,
  });
  if (!created.ok || !webhookSecret) {
    writeFileSync(join(SITE, "docs/AMBERONE-STRIPE-WEBHOOK-SETUP.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
}

// Confirm endpoint in list
const hooks2 = await stripe(secret, "GET", "/webhook_endpoints?limit=100");
const confirmed = (hooks2.json.data || []).find((h) => h.url === WEBHOOK_URL);
report.endpointConfirmed = confirmed
  ? { id: confirmed.id, url: confirmed.url, status: confirmed.status, enabled_events: confirmed.enabled_events }
  : null;

// Push Pages secret
saveDevVar("STRIPE_WEBHOOK_SECRET", webhookSecret);
const put = spawnSync(
  "npx",
  ["wrangler", "pages", "secret", "put", "STRIPE_WEBHOOK_SECRET", "--project-name=amberone"],
  {
    cwd: SITE,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
    },
    shell: true,
    encoding: "utf8",
    input: webhookSecret + "\n",
  },
);
report.steps.push({
  step: "pages_secret_put",
  ok: put.status === 0,
  status: put.status,
  snippet: ((put.stdout || "") + (put.stderr || "")).split(/\r?\n/).slice(0, 8),
});

// Redeploy so Functions pick up secret (Pages secrets apply without rebuild, but we redeploy for webhook code changes)
const deploy = spawnSync(
  "npx",
  ["wrangler", "pages", "deploy", ".", "--project-name=amberone", "--commit-dirty=true"],
  {
    cwd: SITE,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: cf.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: cf.CLOUDFLARE_ACCOUNT_ID,
    },
    shell: true,
    encoding: "utf8",
  },
);
const deployOut = (deploy.stdout || "") + (deploy.stderr || "");
const deployUrl = (deployOut.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i) || [])[0] || null;
report.steps.push({
  step: "redeploy",
  ok: deploy.status === 0,
  status: deploy.status,
  deployUrl,
  tail: deployOut.split(/\r?\n/).slice(-15),
});

// Wait for propagation
await new Promise((r) => setTimeout(r, 8000));

// --- Signed event battery ---
const stamp = Date.now();
const email = `billing.e2e.${stamp}@example.com`;
const password = "BillingE2E123!";
const signup = await http("/api/auth/signup", {
  method: "POST",
  json: { email, password, name: "Billing E2E" },
});
const cookie = cookieFrom(signup.setCookie);
const userId = signup.json?.user?.id;
report.steps.push({ step: "signup", ok: signup.status === 201 && Boolean(cookie), userId });

const cus = await stripe(secret, "POST", "/customers", {
  email,
  "metadata[product]": "amberone",
  "metadata[userId]": userId,
  name: "AmberOne Billing E2E",
});
const customerId = cus.json.id;
report.steps.push({ step: "stripe_customer", ok: cus.ok, customerId, fingerprint: fp(customerId) });

const personalPrice = vars.STRIPE_PRICE_PERSONAL || pricesDoc.STRIPE_PRICE_PERSONAL;

// Trial subscription (live) — may require payment method; attempt first
const subAttempt = await stripe(secret, "POST", "/subscriptions", {
  customer: customerId,
  "items[0][price]": personalPrice,
  trial_period_days: "1",
  "metadata[product]": "amberone",
  "metadata[plan]": "personal",
  "metadata[userId]": userId,
  payment_behavior: "default_incomplete",
  "payment_settings[save_default_payment_method]": "on_subscription",
  "expand[0]": "latest_invoice.payment_intent",
});
let subscriptionId = subAttempt.json.id || null;
let subscriptionVia = "api_trial_incomplete";
if (!subAttempt.ok) {
  report.steps.push({
    step: "live_subscription_create",
    ok: false,
    error: subAttempt.json.error?.message || null,
    note: "Will activate via signed checkout.session.completed webhook simulation",
  });
  subscriptionId = `sub_sim_${stamp}`;
  subscriptionVia = "simulated";
} else {
  report.steps.push({
    step: "live_subscription_create",
    ok: true,
    subscriptionId,
    status: subAttempt.json.status,
    via: subscriptionVia,
  });
}

async function postEvent(event) {
  const payload = JSON.stringify(event);
  const { header } = sign(webhookSecret, payload);
  return http("/api/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "Content-Type": "application/json" },
    body: payload,
  });
}

const evtCheckout = {
  id: `evt_ao_checkout_${stamp}`,
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: `cs_ao_${stamp}`,
      object: "checkout.session",
      customer: customerId,
      subscription: subscriptionId,
      client_reference_id: userId,
      metadata: { userId, plan: "personal", product: "amberone" },
    },
  },
};
const wh1 = await postEvent(evtCheckout);
report.steps.push({
  step: "webhook_checkout_completed",
  ok: wh1.status === 200 && wh1.json?.received === true && !wh1.json?.duplicate,
  status: wh1.status,
  body: wh1.json,
});

const whDup = await postEvent(evtCheckout);
report.steps.push({
  step: "webhook_duplicate_safe",
  ok: whDup.status === 200 && whDup.json?.duplicate === true,
  status: whDup.status,
  body: whDup.json,
});

const evtSubUp = {
  id: `evt_ao_sub_upd_${stamp}`,
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
};
const wh2 = await postEvent(evtSubUp);
report.steps.push({
  step: "webhook_subscription_updated",
  ok: wh2.status === 200 && wh2.json?.received === true,
  status: wh2.status,
  body: wh2.json,
});

const evtPaid = {
  id: `evt_ao_inv_paid_${stamp}`,
  object: "event",
  type: "invoice.paid",
  data: {
    object: {
      id: `in_ao_${stamp}`,
      object: "invoice",
      customer: customerId,
      subscription: subscriptionId,
      status: "paid",
    },
  },
};
const wh3 = await postEvent(evtPaid);
report.steps.push({
  step: "webhook_invoice_paid",
  ok: wh3.status === 200 && wh3.json?.received === true,
  status: wh3.status,
  body: wh3.json,
});

// Verify user state via /api/billing
const billing = await http("/api/billing", { cookie });
report.steps.push({
  step: "billing_status_after_webhooks",
  ok:
    billing.status === 200 &&
    billing.json?.user?.subscriptionStatus === "active" &&
    billing.json?.user?.stripeCustomerId === customerId,
  status: billing.status,
  user: billing.json?.user || null,
});

// Checkout session (live)
const checkout = await http("/api/checkout", {
  method: "POST",
  cookie,
  json: { plan: "personal" },
});
report.steps.push({
  step: "checkout_session",
  ok: checkout.status === 200 && String(checkout.json?.url || "").includes("checkout.stripe.com"),
  sessionId: checkout.json?.id || null,
  urlPrefix: checkout.json?.url ? String(checkout.json.url).slice(0, 48) : null,
});

// Customer portal
const portal = await http("/api/portal", {
  method: "POST",
  cookie,
  json: {},
});
report.steps.push({
  step: "customer_portal",
  ok: portal.status === 200 && String(portal.json?.url || "").includes("billing.stripe.com"),
  urlPrefix: portal.json?.url ? String(portal.json.url).slice(0, 48) : null,
  error: portal.json?.error || null,
});

// Cancel / update via subscription.deleted webhook
const evtDel = {
  id: `evt_ao_sub_del_${stamp}`,
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
};
const wh4 = await postEvent(evtDel);
const billing2 = await http("/api/billing", { cookie });
report.steps.push({
  step: "webhook_subscription_deleted",
  ok: wh4.status === 200 && billing2.json?.user?.subscriptionStatus === "canceled",
  webhook: wh4.json,
  user: billing2.json?.user || null,
});

// If we created a real incomplete/trialing sub, cancel it in Stripe to avoid stray live subs
if (subscriptionVia !== "simulated" && subscriptionId?.startsWith("sub_")) {
  const cancel = await stripe(secret, "DELETE", `/subscriptions/${subscriptionId}`);
  report.steps.push({
    step: "cleanup_stripe_subscription",
    ok: cancel.ok,
    status: cancel.json.status || cancel.status,
  });
}

const required = [
  "verify_live_prices_same_account",
  "pages_secret_put",
  "redeploy",
  "webhook_checkout_completed",
  "webhook_duplicate_safe",
  "webhook_subscription_updated",
  "webhook_invoice_paid",
  "billing_status_after_webhooks",
  "checkout_session",
  "customer_portal",
  "webhook_subscription_deleted",
];
const stepMap = Object.fromEntries(report.steps.map((s) => [s.step, s]));
// also accept create_webhook_endpoint or reuse
const webhookReady =
  (stepMap.create_webhook_endpoint?.ok ||
    stepMap.reuse_working_amberone_whsec?.ok ||
    stepMap.update_existing_endpoint_events?.ok) &&
  Boolean(report.endpointConfirmed || webhookId);

report.summary = {
  webhookEndpointUrl: WEBHOOK_URL,
  webhookEndpointId: webhookId || report.endpointConfirmed?.id || null,
  events: EVENTS,
  requiredSteps: required.map((k) => ({ step: k, ok: Boolean(stepMap[k]?.ok) })),
  allRequiredOk: required.every((k) => stepMap[k]?.ok) && webhookReady,
  liveCardPayment: "not_completed — requires owner card approval in Checkout UI",
  note: "Subscription activation verified via signed AmberOne webhook events + D1 billing state; live card charge still needs owner in Stripe Checkout.",
};

report.productionReady = false; // explicit: do not declare until live card also done if that is the bar
report.stripeWebhookAndBillingFlowPass = report.summary.allRequiredOk;

writeFileSync(join(SITE, "docs/AMBERONE-STRIPE-WEBHOOK-SETUP.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      stripeWebhookAndBillingFlowPass: report.stripeWebhookAndBillingFlowPass,
      productionReady: false,
      accountId: report.account?.id,
      endpoint: report.endpointConfirmed,
      summary: report.summary,
      steps: report.steps.map((s) => ({ step: s.step, ok: s.ok, detail: s.error || s.status || s.note || null })),
    },
    null,
    2,
  ),
);
process.exit(report.summary.allRequiredOk ? 0 : 2);
