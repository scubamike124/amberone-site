/**
 * Prove live Checkout session creation. Does not complete a card charge.
 */
const BASES = process.env.AO_CHECKOUT_BASES
  ? process.env.AO_CHECKOUT_BASES.split(",")
  : ["https://da623da1.amberone.pages.dev", "https://amberoneai.com"];
const pass = "AuditPass9!";

async function jarFetch(base, cookies, method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const set = res.headers.getSetCookie?.() || (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  for (const line of set) cookies.push(line.split(";")[0]);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text: text.slice(0, 180) };
}

const rows = [];
for (const base of BASES) {
  const cookies = [];
  const stamp = Date.now().toString(36);
  const email = `ao.stripe.${stamp}@example.com`;
  const health = await jarFetch(base, cookies, "GET", "/api/health");
  const signup = await jarFetch(base, cookies, "POST", "/api/auth/signup", {
    name: "Stripe Check",
    email,
    password: pass,
  });
  const checkout = await jarFetch(base, cookies, "POST", "/api/checkout", { plan: "personal" });
  const url = checkout.json?.url || "";
  const ok = checkout.status === 200 && /^https:\/\/checkout\.stripe\.com\//i.test(url);
  rows.push({
    base,
    health: health.status,
    signup: signup.status,
    checkoutStatus: checkout.status,
    checkoutOk: ok,
    checkoutHost: url ? new URL(url).host : null,
    error: checkout.json?.error || (ok ? null : checkout.text),
  });
}

console.log(JSON.stringify(rows, null, 2));
process.exit(rows.every((r) => r.checkoutOk) ? 0 : 1);
