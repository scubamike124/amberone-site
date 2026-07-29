/**
 * AmberOne API Readiness Report — inventory + E2E tests for required integrations.
 * Does NOT declare production-ready. Never prints secret values.
 */
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SITE = process.cwd();
const BASE = process.env.AO_BASE || "https://amberone.pages.dev";
const WEBHOOK_URL = `${BASE}/api/webhook`;

function fp(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s.length < 12) return { length: s.length, first4: s.slice(0, 4), last4: s.slice(-4) };
  return { length: s.length, first4: s.slice(0, 4), last4: s.slice(-4) };
}

function loadDevVars() {
  const p = join(SITE, ".dev.vars");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

async function pagesEnvPresence(cf) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.CLOUDFLARE_ACCOUNT_ID}/pages/projects/amberone`,
    { headers: { Authorization: `Bearer ${cf.CLOUDFLARE_API_TOKEN}` } },
  );
  const body = await res.json().catch(() => ({}));
  const envVars = body.result?.deployment_configs?.production?.env_vars || {};
  const d1 = body.result?.deployment_configs?.production?.d1_databases || {};
  return {
    http: res.status,
    secretKeysPresent: Object.keys(envVars),
    d1: d1.DB || null,
  };
}

async function httpJson(path, opts = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  return { status: res.status, json, text: text.slice(0, 800), setCookie };
}

function cookieFrom(setCookie) {
  for (const c of setCookie) {
    const m = String(c).match(/ao_session=[^;]+/);
    if (m) return m[0];
  }
  return null;
}

async function stripeGet(secret, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function stripeForm(secret, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

async function resendGet(key, path) {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

const local = loadDevVars();
const cf = existsSync(join(SITE, ".tmp/cf-env.json"))
  ? JSON.parse(readFileSync(join(SITE, ".tmp/cf-env.json"), "utf8"))
  : {};

const pages = cf.CLOUDFLARE_API_TOKEN
  ? await pagesEnvPresence(cf)
  : { http: 0, secretKeysPresent: [], d1: null, error: "no cf-env" };

const inventory = [
  {
    id: "cloudflare-pages",
    name: "Cloudflare Pages hosting",
    type: "infrastructure",
    required: true,
    purpose: "Serve site + Functions",
    config: ["Pages project amberone"],
    secrets: [],
  },
  {
    id: "cloudflare-d1",
    name: "Cloudflare D1 (binding DB)",
    type: "database",
    required: true,
    purpose: "Users, sessions, password resets, billing_events",
    config: ["database_id 0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a", "binding DB"],
    secrets: [],
  },
  {
    id: "stripe-api",
    name: "Stripe API (Checkout + Portal)",
    type: "payments",
    required: true,
    purpose: "Subscription checkout + customer portal",
    config: ["Live mode expected"],
    secrets: ["STRIPE_SECRET_KEY"],
  },
  {
    id: "stripe-prices",
    name: "Stripe Price IDs (catalog)",
    type: "payments",
    required: true,
    purpose: "Stable plan prices for all 7 self-service plans",
    config: [
      "STRIPE_PRICE_PERSONAL",
      "STRIPE_PRICE_FAMILY_2",
      "STRIPE_PRICE_FAMILY_5",
      "STRIPE_PRICE_FAMILY_10",
      "STRIPE_PRICE_EXECUTIVE",
      "STRIPE_PRICE_BUSINESS_SMALL",
      "STRIPE_PRICE_BUSINESS_MEDIUM",
    ],
    secrets: [
      "STRIPE_PRICE_PERSONAL",
      "STRIPE_PRICE_FAMILY_2",
      "STRIPE_PRICE_FAMILY_5",
      "STRIPE_PRICE_FAMILY_10",
      "STRIPE_PRICE_EXECUTIVE",
      "STRIPE_PRICE_BUSINESS_SMALL",
      "STRIPE_PRICE_BUSINESS_MEDIUM",
    ],
  },
  {
    id: "stripe-webhook",
    name: "Stripe Webhook → /api/webhook",
    type: "webhook",
    required: true,
    purpose: "Persist customer/subscription after checkout; keep plan status in sync",
    config: [`Endpoint URL must be ${WEBHOOK_URL}`, "Events: checkout.session.completed, customer.subscription.*"],
    secrets: ["STRIPE_WEBHOOK_SECRET"],
  },
  {
    id: "openai",
    name: "OpenAI Chat Completions",
    type: "ai",
    required: true,
    purpose: "Talk to Amber product experience",
    config: ["model gpt-4o-mini"],
    secrets: ["OPENAI_API_KEY"],
    note: "Code falls back to FAQ if missing; product Talk experience requires live OpenAI",
  },
  {
    id: "resend",
    name: "Resend Email API",
    type: "email",
    required: true,
    purpose: "Password reset email delivery",
    config: ["Verified sending domain", "EMAIL_FROM matching verified domain"],
    secrets: ["RESEND_API_KEY", "EMAIL_FROM"],
  },
  {
    id: "google-fonts",
    name: "Google Fonts CDN",
    type: "frontend",
    required: false,
    purpose: "Typography",
    config: ["fonts.googleapis.com"],
    secrets: [],
  },
  {
    id: "cf-api-token-deploy",
    name: "Cloudflare API Token (deploy/ops)",
    type: "ops",
    required: false,
    purpose: "Deploy + manage Pages secrets (not used at request runtime)",
    config: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    secrets: ["CLOUDFLARE_API_TOKEN"],
  },
  {
    id: "allow-reset-url-fallback",
    name: "ALLOW_RESET_URL_FALLBACK",
    type: "config",
    required: false,
    purpose: "Dev-only reset URL in API response",
    config: ["Must stay unset/false in production"],
    secrets: [],
  },
];

const tests = [];
const gaps = [];

function addTest(id, title, required, result) {
  tests.push({ id, title, required, ...result });
  if (required && result.status !== "pass") {
    gaps.push({
      id,
      title,
      severity: result.status === "fail" ? "blocking" : "blocking",
      reason: result.detail,
      missing: result.missing || [],
    });
  }
}

// --- Presence on Pages ---
const requiredSecrets = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "STRIPE_PRICE_PERSONAL",
  "STRIPE_PRICE_FAMILY_2",
  "STRIPE_PRICE_FAMILY_5",
  "STRIPE_PRICE_FAMILY_10",
  "STRIPE_PRICE_EXECUTIVE",
  "STRIPE_PRICE_BUSINESS_SMALL",
  "STRIPE_PRICE_BUSINESS_MEDIUM",
];
const missingOnPages = requiredSecrets.filter((k) => !pages.secretKeysPresent.includes(k));
addTest("pages-secrets", "Pages production secrets present", true, {
  status: missingOnPages.length === 0 ? "pass" : "fail",
  detail:
    missingOnPages.length === 0
      ? `All ${requiredSecrets.length} required secrets present on Pages`
      : `Missing on Pages: ${missingOnPages.join(", ")}`,
  missing: missingOnPages,
  evidence: { presentCount: pages.secretKeysPresent.length },
});

addTest("d1-binding", "D1 binding DB on Pages production", true, {
  status: pages.d1?.id ? "pass" : "fail",
  detail: pages.d1?.id
    ? `Bound DB id=${pages.d1.id}`
    : "No d1_databases.DB binding on production deployment config",
  missing: pages.d1?.id ? [] : ["D1 binding DB"],
  evidence: { d1: pages.d1 },
});

// --- Health / D1 E2E ---
const health = await httpJson("/api/health");
addTest("d1-runtime", "D1 runtime read/write schema (health)", true, {
  status: health.status === 200 && health.json?.ok && health.json?.db ? "pass" : "fail",
  detail:
    health.status === 200 && health.json?.ok
      ? `tables=${(health.json.tables || []).join(",")}; users=${health.json.userCount}`
      : `HTTP ${health.status} ${JSON.stringify(health.json || health.text)}`,
  evidence: health.json,
});

// --- Auth E2E (depends on D1) ---
const stamp = Date.now();
const email = `api.ready.${stamp}@example.com`;
const password = "ApiReady123!";
const signup = await httpJson("/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ email, password, name: "API Ready" }),
});
const cookie = cookieFrom(signup.setCookie);
addTest("auth-signup", "Auth signup → session cookie", true, {
  status: signup.status === 201 && cookie ? "pass" : "fail",
  detail: `HTTP ${signup.status}; cookie=${Boolean(cookie)}`,
  evidence: { status: signup.status, userId: signup.json?.user?.id || null },
});

// --- Stripe secret mode + prices ---
const stripeKey = local.STRIPE_SECRET_KEY || null;
const stripeMode = stripeKey?.startsWith("sk_live")
  ? "live"
  : stripeKey?.startsWith("sk_test")
    ? "test"
    : "unknown";

if (!stripeKey) {
  addTest("stripe-key", "Stripe secret key available for E2E validation", true, {
    status: "fail",
    detail: "STRIPE_SECRET_KEY not in local .dev.vars for validation (Pages may still have it)",
    missing: ["STRIPE_SECRET_KEY (local probe)"],
  });
} else {
  const acct = await stripeGet(stripeKey, "account");
  addTest("stripe-api", "Stripe API authentication (GET /v1/account)", true, {
    status: acct.ok ? "pass" : "fail",
    detail: acct.ok
      ? `mode=${stripeMode}; charges_enabled=${acct.json.charges_enabled}; country=${acct.json.country}`
      : `HTTP ${acct.status} ${acct.json?.error?.message || ""}`,
    evidence: {
      mode: stripeMode,
      fingerprint: fp(stripeKey),
      chargesEnabled: acct.json?.charges_enabled ?? null,
      payoutsEnabled: acct.json?.payouts_enabled ?? null,
    },
  });

  const priceKeys = [
    "STRIPE_PRICE_PERSONAL",
    "STRIPE_PRICE_FAMILY_2",
    "STRIPE_PRICE_FAMILY_5",
    "STRIPE_PRICE_FAMILY_10",
    "STRIPE_PRICE_EXECUTIVE",
    "STRIPE_PRICE_BUSINESS_SMALL",
    "STRIPE_PRICE_BUSINESS_MEDIUM",
  ];
  const priceResults = [];
  for (const k of priceKeys) {
    const id = local[k];
    if (!id) {
      priceResults.push({ key: k, ok: false, reason: "missing locally" });
      continue;
    }
    const pr = await stripeGet(stripeKey, `prices/${id}`);
    priceResults.push({
      key: k,
      id,
      ok: pr.ok && pr.json?.active !== false,
      active: pr.json?.active ?? null,
      unitAmount: pr.json?.unit_amount ?? null,
      currency: pr.json?.currency ?? null,
      error: pr.json?.error?.message || null,
    });
  }
  const badPrices = priceResults.filter((p) => !p.ok);
  addTest("stripe-prices", "Stripe Price IDs resolve & active", true, {
    status: badPrices.length === 0 ? "pass" : "fail",
    detail:
      badPrices.length === 0
        ? `All ${priceResults.length} prices active`
        : `Failed: ${badPrices.map((p) => `${p.key}(${p.error || p.reason})`).join(", ")}`,
    missing: badPrices.map((p) => p.key),
    evidence: { prices: priceResults.map(({ key, id, ok, active, unitAmount }) => ({ key, id, ok, active, unitAmount })) },
  });
}

// --- Checkout E2E ---
const checkout = await httpJson("/api/checkout", {
  method: "POST",
  cookie,
  body: JSON.stringify({ plan: "personal" }),
});
addTest("stripe-checkout", "Checkout session create (production)", true, {
  status:
    checkout.status === 200 && String(checkout.json?.url || "").includes("checkout.stripe.com")
      ? "pass"
      : "fail",
  detail:
    checkout.status === 200
      ? `session=${checkout.json?.id || "ok"}; urlHost=checkout.stripe.com`
      : `HTTP ${checkout.status} ${JSON.stringify(checkout.json)}`,
  evidence: {
    status: checkout.status,
    sessionId: checkout.json?.id || null,
    urlPrefix: checkout.json?.url ? String(checkout.json.url).slice(0, 40) : null,
  },
});

// --- Portal E2E: create Stripe customer, attach to user via simulated signed webhook, then portal ---
let portalPass = false;
let webhookEndpointPass = false;
let webhookSignedPass = false;

if (stripeKey && cookie && signup.json?.user?.id) {
  const whSecret = local.STRIPE_WEBHOOK_SECRET;
  // List webhook endpoints
  const endpoints = await stripeGet(stripeKey, "webhook_endpoints?limit=100");
  const list = Array.isArray(endpoints.json?.data) ? endpoints.json.data : [];
  const match = list.find((e) => String(e.url || "").replace(/\/$/, "") === WEBHOOK_URL.replace(/\/$/, ""));
  const enabledMatch = match && match.status === "enabled";
  webhookEndpointPass = Boolean(enabledMatch);
  addTest("stripe-webhook-endpoint", "Stripe Dashboard webhook points at AmberOne", true, {
    status: enabledMatch ? "pass" : "fail",
    detail: enabledMatch
      ? `Found enabled endpoint ${match.id} → ${match.url}`
      : match
        ? `Endpoint exists but status=${match.status}`
        : `No Stripe webhook endpoint registered for ${WEBHOOK_URL}. Found ${list.length} endpoint(s): ${list
            .map((e) => e.url)
            .slice(0, 8)
            .join(" | ") || "(none)"}`,
    missing: enabledMatch ? [] : [`Stripe webhook endpoint ${WEBHOOK_URL}`],
    evidence: {
      amberoneEndpoint: match
        ? { id: match.id, url: match.url, status: match.status, apiVersion: match.api_version }
        : null,
      otherEndpoints: list.map((e) => ({ url: e.url, status: e.status })),
    },
  });

  // Signed webhook E2E with local signing secret (proves app accepts THIS secret)
  if (whSecret) {
    const cus = await stripeForm(stripeKey, "customers", new URLSearchParams({
      email,
      "metadata[product]": "amberone",
      "metadata[userId]": signup.json.user.id,
    }));
    const customerId = cus.json?.id;
    const event = {
      id: `evt_api_ready_${stamp}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_api_ready_${stamp}`,
          object: "checkout.session",
          customer: customerId,
          subscription: null,
          client_reference_id: signup.json.user.id,
          metadata: { userId: signup.json.user.id, plan: "personal", product: "amberone" },
        },
      },
    };
    const payload = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", whSecret).update(`${ts}.${payload}`).digest("hex");
    const wh = await httpJson("/api/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${ts},v1=${sig}` },
      body: payload,
    });
    // Note: httpJson always sets content-type json; webhook expects raw body — we pass body string OK
    webhookSignedPass = wh.status === 200 && wh.json?.received === true;
    addTest("stripe-webhook-signed", "Signed webhook accepted by production /api/webhook", true, {
      status: webhookSignedPass ? "pass" : "fail",
      detail: webhookSignedPass
        ? `received type=${wh.json?.type}`
        : `HTTP ${wh.status} ${JSON.stringify(wh.json)} — secret may not match Stripe endpoint signing secret`,
      missing: webhookSignedPass ? [] : ["Matching STRIPE_WEBHOOK_SECRET for AmberOne endpoint"],
      evidence: { status: wh.status, body: wh.json },
    });

    // Portal after customer attached
    const portal = await httpJson("/api/portal", {
      method: "POST",
      cookie,
      body: "{}",
    });
    portalPass = portal.status === 200 && String(portal.json?.url || "").includes("billing.stripe.com");
    addTest("stripe-portal", "Customer Portal session (after customer link)", true, {
      status: portalPass ? "pass" : "fail",
      detail: portalPass
        ? "billing.stripe.com portal URL returned"
        : `HTTP ${portal.status} ${JSON.stringify(portal.json)}`,
      evidence: { status: portal.status, urlPrefix: portal.json?.url ? String(portal.json.url).slice(0, 40) : null },
    });
  } else {
    addTest("stripe-webhook-signed", "Signed webhook accepted by production /api/webhook", true, {
      status: "fail",
      detail: "STRIPE_WEBHOOK_SECRET missing locally; cannot sign E2E event",
      missing: ["STRIPE_WEBHOOK_SECRET"],
    });
    addTest("stripe-portal", "Customer Portal session (after customer link)", true, {
      status: "fail",
      detail: "Skipped — depends on webhook customer attach",
      missing: ["prior webhook success"],
    });
  }
} else {
  addTest("stripe-webhook-endpoint", "Stripe Dashboard webhook points at AmberOne", true, {
    status: "fail",
    detail: "Cannot list Stripe webhooks without STRIPE_SECRET_KEY",
    missing: ["STRIPE_SECRET_KEY"],
  });
}

// --- OpenAI E2E ---
const talk = await httpJson("/api/talk", {
  method: "POST",
  body: JSON.stringify({ message: "Summarize AmberOne Personal in one sentence." }),
});
addTest("openai-talk", "Talk to Amber via OpenAI", true, {
  status: talk.status === 200 && talk.json?.source === "openai" && talk.json?.reply ? "pass" : "fail",
  detail:
    talk.json?.source === "openai"
      ? `source=openai; replyLen=${String(talk.json.reply || "").length}`
      : `source=${talk.json?.source || "none"}; HTTP ${talk.status} — OpenAI missing or failing (FAQ fallback only)`,
  missing: talk.json?.source === "openai" ? [] : ["Working OPENAI_API_KEY"],
  evidence: { status: talk.status, source: talk.json?.source || null },
});

// --- Resend E2E ---
const resendKey = local.RESEND_API_KEY;
const emailFrom = local.EMAIL_FROM || "";
if (!resendKey) {
  addTest("resend-api", "Resend API key valid", true, {
    status: "fail",
    detail: "RESEND_API_KEY missing locally",
    missing: ["RESEND_API_KEY"],
  });
  addTest("resend-domain", "Resend sending domain verified for EMAIL_FROM", true, {
    status: "fail",
    detail: "Cannot verify without RESEND_API_KEY",
    missing: ["RESEND_API_KEY", "Verified domain", "EMAIL_FROM"],
  });
  addTest("resend-send", "Password-reset email delivery E2E", true, {
    status: "fail",
    detail: "Skipped — no Resend key",
    missing: ["RESEND_API_KEY"],
  });
} else {
  const domains = await resendGet(resendKey, "/domains");
  const domainList = Array.isArray(domains.json?.data) ? domains.json.data : [];
  const fromMatch = emailFrom.match(/@([A-Za-z0-9.-]+)/);
  const fromDomain = fromMatch ? fromMatch[1].toLowerCase() : null;
  const verified = domainList.find(
    (d) =>
      String(d.name || "").toLowerCase() === fromDomain &&
      (d.status === "verified" || d.status === "success"),
  );
  addTest("resend-api", "Resend API authentication", true, {
    status: domains.ok ? "pass" : "fail",
    detail: domains.ok
      ? `domains=${domainList.length}; EMAIL_FROM fingerprint domain=${fromDomain}`
      : `HTTP ${domains.status} ${JSON.stringify(domains.json).slice(0, 200)}`,
    evidence: {
      fingerprint: fp(resendKey),
      emailFromFingerprint: emailFrom ? fp(emailFrom) : null,
      domains: domainList.map((d) => ({ name: d.name, status: d.status })),
    },
  });

  addTest("resend-domain", "EMAIL_FROM domain verified in Resend", true, {
    status: verified ? "pass" : "fail",
    detail: verified
      ? `Domain ${fromDomain} verified`
      : `EMAIL_FROM domain "${fromDomain}" is not verified in Resend. Verified/available: ${
          domainList.map((d) => `${d.name}:${d.status}`).join(", ") || "(none)"
        }`,
    missing: verified ? [] : [`Verified Resend domain for ${fromDomain || "EMAIL_FROM"}`],
    evidence: { fromDomain, verified: Boolean(verified) },
  });

  // Probe send using Resend's documented test recipient (not example.com)
  const forgot = await httpJson("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  const leaked = Boolean(forgot.json?.resetUrl);
  const sendProbe = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom || "AmberOne <onboarding@resend.dev>",
      to: ["delivered@resend.dev"],
      subject: "AmberOne API readiness probe",
      html: "<p>API readiness probe — ignore.</p>",
    }),
  });
  const sendJson = await sendProbe.json().catch(() => ({}));
  const sendOk = sendProbe.ok && Boolean(sendJson.id);
  addTest("resend-send", "Resend can send with configured EMAIL_FROM", true, {
    status: sendOk ? "pass" : "fail",
    detail: sendOk
      ? `Send accepted to delivered@resend.dev id=${sendJson.id}`
      : `Send failed HTTP ${sendProbe.status}: ${sendJson?.message || JSON.stringify(sendJson).slice(0, 240)}`,
    missing: sendOk ? [] : ["Working Resend FROM/domain that can deliver"],
    evidence: {
      forgotStatus: forgot.status,
      resetUrlLeaked: leaked,
      sendStatus: sendProbe.status,
      sendMessage: sendJson?.message || null,
      to: "delivered@resend.dev",
    },
  });
  if (leaked) {
    gaps.push({
      id: "reset-url-leak",
      title: "Forgot-password leaked resetUrl",
      severity: "blocking",
      reason: "Production must not return reset tokens",
      missing: [],
    });
  }
}

// Unsigned webhook must fail
const badWh = await httpJson("/api/webhook", { method: "POST", body: "{}" });
addTest("webhook-reject-unsigned", "Webhook rejects unsigned payloads", true, {
  status: badWh.status >= 400 ? "pass" : "fail",
  detail: `HTTP ${badWh.status}`,
  evidence: badWh.json,
});

const requiredTests = tests.filter((t) => t.required);
const requiredPassed = requiredTests.filter((t) => t.status === "pass").length;
const requiredFailed = requiredTests.filter((t) => t.status !== "pass");

const report = {
  at: new Date().toISOString(),
  base: BASE,
  title: "AmberOne API Readiness Report",
  declaration: "NOT production-ready until all required integrations pass end-to-end.",
  productionReady: false,
  summary: {
    inventoryCount: inventory.length,
    requiredIntegrations: inventory.filter((i) => i.required).length,
    optionalIntegrations: inventory.filter((i) => !i.required).length,
    requiredTestsTotal: requiredTests.length,
    requiredTestsPassed: requiredPassed,
    requiredTestsFailed: requiredFailed.length,
    blockingGaps: gaps.length,
  },
  inventory,
  tests,
  blockingGaps: gaps,
  requiredFailures: requiredFailed.map((t) => ({
    id: t.id,
    title: t.title,
    detail: t.detail,
    missing: t.missing || [],
  })),
  pagesSecretPresence: {
    keys: pages.secretKeysPresent,
    d1: pages.d1,
  },
};

writeFileSync(join(SITE, "docs/API-READINESS-REPORT.json"), JSON.stringify(report, null, 2));

// Human markdown
const md = `# AmberOne API Readiness Report

**Generated:** ${report.at}  
**Target:** ${BASE}  
**Declaration:** **NOT production-ready** until every required integration passes end-to-end.

## Summary

| Metric | Value |
|--------|------:|
| Inventory items | ${report.summary.inventoryCount} |
| Required integrations | ${report.summary.requiredIntegrations} |
| Optional integrations | ${report.summary.optionalIntegrations} |
| Required E2E tests passed | ${requiredPassed} / ${requiredTests.length} |
| Blocking gaps | ${gaps.length} |
| Production-ready | **NO** |

## Inventory

| ID | Service | Required? | Purpose | Secrets / config |
|----|---------|-----------|---------|------------------|
${inventory
  .map(
    (i) =>
      `| ${i.id} | ${i.name} | **${i.required ? "Required" : "Optional"}** | ${i.purpose} | ${(i.secrets.length ? i.secrets : i.config).join(", ")} |`,
  )
  .join("\n")}

## Required E2E test results

| Test | Status | Detail |
|------|--------|--------|
${requiredTests.map((t) => `| ${t.title} | **${t.status.toUpperCase()}** | ${t.detail.replace(/\|/g, "/")} |`).join("\n")}

## Blocking gaps (must fix before production-ready)

${
  gaps.length
    ? gaps.map((g, i) => `${i + 1}. **${g.title}** — ${g.reason}${g.missing?.length ? ` (missing: ${g.missing.join(", ")})` : ""}`).join("\n")
    : "_None — re-check optional items and ops checklist before launch._"
}

## Notes

- Runtime Pages secrets were checked for **presence only** (values never printed).
- Stripe webhook readiness requires both: secret present on Pages **and** an enabled Stripe endpoint URL exactly matching \`${WEBHOOK_URL}\`.
- Resend requires API key **and** a verified domain matching \`EMAIL_FROM\`.
`;

writeFileSync(join(SITE, "docs/API-READINESS-REPORT.md"), md);
console.log(
  JSON.stringify(
    {
      productionReady: false,
      summary: report.summary,
      requiredFailures: report.requiredFailures,
      blockingGaps: gaps,
    },
    null,
    2,
  ),
);
process.exit(requiredFailed.length ? 2 : 0);
