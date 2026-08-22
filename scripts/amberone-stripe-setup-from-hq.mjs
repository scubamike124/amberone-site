/**
 * Set up Stripe on AmberOne the same way Amber did the other portfolio sites.
 * Run with HQ production env injected (railway run). Never prints secret values.
 *
 *   railway run -s amber-hq-web -e production -p a7d16c96-0692-4b93-b5c1-07c3eb5b32ae -- node scripts/amberone-stripe-setup-from-hq.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "C:\\Users\\michael\\Downloads\\amberone-site";
const WEBHOOK_URL = "https://amberoneai.com/api/webhook";
const LEGACY_WEBHOOK_URL = "https://amberone.pages.dev/api/webhook";
const PROJECT = "amberone";

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

const PLANS = [
  { env: "STRIPE_PRICE_PERSONAL", name: "AmberOne Personal", amount: 1999, slug: "personal" },
  { env: "STRIPE_PRICE_FAMILY_2", name: "AmberOne Family (2 users)", amount: 2999, slug: "family_2" },
  { env: "STRIPE_PRICE_FAMILY_5", name: "AmberOne Family (5 users)", amount: 4999, slug: "family_5" },
  { env: "STRIPE_PRICE_FAMILY_10", name: "AmberOne Family (10 users)", amount: 7999, slug: "family_10" },
  { env: "STRIPE_PRICE_EXECUTIVE", name: "AmberOne Executive", amount: 5999, slug: "executive" },
  { env: "STRIPE_PRICE_BUSINESS_SMALL", name: "AmberOne Business Small", amount: 9900, slug: "business_small" },
  { env: "STRIPE_PRICE_BUSINESS_MEDIUM", name: "AmberOne Business Medium", amount: 19900, slug: "business_medium" },
];

function fp(v) {
  if (!v) return null;
  const s = String(v);
  return { length: s.length, prefix: s.slice(0, 7), last4: s.slice(-4) };
}

function redact(s) {
  return String(s || "").replace(/(sk|pk|rk|whsec)_[A-Za-z0-9]+/g, "***");
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

function saveDevVars(updates) {
  const p = join(SITE, ".dev.vars");
  const current = loadDevVars();
  Object.assign(current, updates);
  const text = Object.entries(current)
    .filter(([, v]) => v != null && String(v).length)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(p, text, "utf8");
}

function pagesSecretPut(name, value) {
  const r = spawnSync(
    "npx",
    ["wrangler", "pages", "secret", "put", name, `--project-name=${PROJECT}`],
    {
      cwd: SITE,
      env: process.env,
      shell: true,
      encoding: "utf8",
      input: String(value).endsWith("\n") ? String(value) : `${value}\n`,
      timeout: 180_000,
    },
  );
  return {
    name,
    ok: r.status === 0,
    status: r.status,
    snippet: redact(((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).slice(0, 8).join(" | ")),
  };
}

const report = { at: new Date().toISOString(), site: "https://amberoneai.com", steps: [] };

const secret = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_LIVE_API_KEY || "").trim();
if (!secret.startsWith("sk_")) {
  report.error = "HQ env has no STRIPE_SECRET_KEY / STRIPE_LIVE_API_KEY";
  writeFileSync(join(SITE, "docs", "AMBERONE-STRIPE-FROM-HQ.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

const acct = await stripe(secret, "GET", "/account");
report.account = {
  ok: acct.ok,
  id: acct.json.id || null,
  chargesEnabled: acct.json.charges_enabled ?? null,
  payoutsEnabled: acct.json.payouts_enabled ?? null,
  key: fp(secret),
  error: acct.json.error?.message || null,
};
report.steps.push({ step: "probe_hq_stripe_key", ok: acct.ok && !/expired/i.test(acct.json.error?.message || "") });
if (!acct.ok) {
  writeFileSync(join(SITE, "docs", "AMBERONE-STRIPE-FROM-HQ.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

const pricesDoc = existsSync(join(SITE, "docs", "stripe-prices.json"))
  ? JSON.parse(readFileSync(join(SITE, "docs", "stripe-prices.json"), "utf8")).prices
  : {};
const vars = loadDevVars();
const priceMap = {};
const priceChecks = [];
for (const plan of PLANS) {
  const existingId = vars[plan.env] || pricesDoc[plan.env];
  let id = existingId;
  let livemode = null;
  let active = null;
  if (existingId) {
    const pr = await stripe(secret, "GET", `/prices/${existingId}`);
    livemode = pr.json.livemode ?? null;
    active = pr.json.active ?? null;
    if (!(pr.ok && pr.json.active !== false)) id = null;
  }
  if (!id) {
    const product = await stripe(secret, "POST", "/products", {
      name: plan.name,
      "metadata[product]": "amberone",
      "metadata[plan]": plan.slug,
    });
    const price = await stripe(secret, "POST", "/prices", {
      product: product.json.id,
      currency: "usd",
      unit_amount: String(plan.amount),
      "recurring[interval]": "month",
      "metadata[product]": "amberone",
      "metadata[plan]": plan.slug,
    });
    id = price.json.id;
    livemode = price.json.livemode ?? null;
    active = price.json.active ?? null;
    priceChecks.push({
      key: plan.env,
      id,
      created: true,
      ok: Boolean(id),
      livemode,
      active,
      error: price.json.error?.message || product.json.error?.message || null,
    });
  } else {
    priceChecks.push({ key: plan.env, id, created: false, ok: true, livemode, active });
  }
  priceMap[plan.env] = id;
}
report.priceChecks = priceChecks;
report.steps.push({
  step: "catalog_prices",
  ok: priceChecks.every((p) => p.ok && p.id),
  detail: `${priceChecks.filter((p) => p.ok).length}/7`,
});

const hooks = await stripe(secret, "GET", "/webhook_endpoints?limit=100");
const list = Array.isArray(hooks.json.data) ? hooks.json.data : [];
const sameUrl = (u) => String(u || "").replace(/\/$/, "");
let endpoint =
  list.find((h) => sameUrl(h.url) === sameUrl(WEBHOOK_URL)) ||
  list.find((h) => sameUrl(h.url) === sameUrl(LEGACY_WEBHOOK_URL));

let webhookSecret = loadDevVars().STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "";
let webhookId = endpoint?.id || null;

if (endpoint && sameUrl(endpoint.url) !== sameUrl(WEBHOOK_URL)) {
  const moved = await stripe(secret, "POST", `/webhook_endpoints/${endpoint.id}`, {
    url: WEBHOOK_URL,
    description: "AmberOne production webhooks",
    "metadata[product]": "amberone",
  });
  report.steps.push({
    step: "retarget_webhook_url",
    ok: moved.ok,
    from: endpoint.url,
    to: WEBHOOK_URL,
    error: moved.json.error?.message || null,
  });
  if (moved.ok) endpoint = { ...endpoint, url: WEBHOOK_URL };
}

if (!endpoint) {
  const form = {
    url: WEBHOOK_URL,
    description: "AmberOne production webhooks",
    "metadata[product]": "amberone",
  };
  EVENTS.forEach((e, i) => {
    form[`enabled_events[${i}]`] = e;
  });
  const created = await stripe(secret, "POST", "/webhook_endpoints", form);
  webhookId = created.json.id;
  webhookSecret = created.json.secret || webhookSecret;
  endpoint = created.json;
  report.steps.push({
    step: "create_webhook_endpoint",
    ok: created.ok && Boolean(created.json.secret || webhookSecret),
    id: webhookId,
    url: created.json.url,
    error: created.json.error?.message || null,
    secret: fp(created.json.secret),
  });
} else {
  const form = { description: "AmberOne production webhooks", "metadata[product]": "amberone" };
  EVENTS.forEach((e, i) => {
    form[`enabled_events[${i}]`] = e;
  });
  const updated = await stripe(secret, "POST", `/webhook_endpoints/${endpoint.id}`, form);
  webhookId = endpoint.id;
  report.steps.push({
    step: "update_webhook_events",
    ok: updated.ok,
    id: webhookId,
    url: endpoint.url,
    reusedWhsec: Boolean(webhookSecret?.startsWith("whsec_")),
    error: updated.json.error?.message || null,
  });
}

const toPush = {
  STRIPE_SECRET_KEY: secret,
  ...priceMap,
};
if (webhookSecret?.startsWith("whsec_")) toPush.STRIPE_WEBHOOK_SECRET = webhookSecret;
saveDevVars(toPush);

const secretPuts = [];
for (const [name, value] of Object.entries(toPush)) {
  secretPuts.push(pagesSecretPut(name, value));
}
report.pagesSecrets = secretPuts.map((s) => ({ name: s.name, ok: s.ok }));
report.steps.push({
  step: "pages_secrets",
  ok: secretPuts.every((s) => s.ok),
  pushed: secretPuts.filter((s) => s.ok).map((s) => s.name),
  failed: secretPuts.filter((s) => !s.ok).map((s) => s.name),
});

writeFileSync(
  join(SITE, "docs", "stripe-prices.json"),
  JSON.stringify({ product: "amberone", updatedAt: report.at, prices: priceMap }, null, 2),
);

const deploy = spawnSync(
  "npx",
  ["wrangler", "pages", "deploy", ".", "--project-name=amberone", "--commit-dirty=true"],
  { cwd: SITE, env: process.env, shell: true, encoding: "utf8", timeout: 180_000 },
);
const deployOut = (deploy.stdout || "") + (deploy.stderr || "");
report.steps.push({
  step: "redeploy",
  ok: deploy.status === 0,
  url: (deployOut.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i) || [])[0] || null,
});

report.ok = report.steps.every((s) => s.ok);
writeFileSync(join(SITE, "docs", "AMBERONE-STRIPE-FROM-HQ.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
