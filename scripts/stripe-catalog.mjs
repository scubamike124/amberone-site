/**
 * Create AmberOne Stripe products/prices on the shared Stripe account.
 * Usage: STRIPE_SECRET_KEY=sk_... node scripts/stripe-catalog.mjs
 * Prints price IDs to set as Cloudflare Pages secrets / .dev.vars.
 */
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY to create the AmberOne catalog.");
  process.exit(1);
}

const plans = [
  { env: "STRIPE_PRICE_PERSONAL", name: "AmberOne Personal", amount: 1999, slug: "personal" },
  { env: "STRIPE_PRICE_FAMILY_2", name: "AmberOne Family (2 users)", amount: 2999, slug: "family_2" },
  { env: "STRIPE_PRICE_FAMILY_5", name: "AmberOne Family (5 users)", amount: 4999, slug: "family_5" },
  { env: "STRIPE_PRICE_FAMILY_10", name: "AmberOne Family (10 users)", amount: 7999, slug: "family_10" },
  { env: "STRIPE_PRICE_EXECUTIVE", name: "AmberOne Executive", amount: 5999, slug: "executive" },
  { env: "STRIPE_PRICE_BUSINESS_SMALL", name: "AmberOne Business Small", amount: 9900, slug: "business_small" },
  { env: "STRIPE_PRICE_BUSINESS_MEDIUM", name: "AmberOne Business Medium", amount: 19900, slug: "business_medium" },
];

async function stripe(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe HTTP ${res.status}`);
  return data;
}

const out = {};
for (const plan of plans) {
  const product = await stripe(
    "products",
    new URLSearchParams({
      name: plan.name,
      "metadata[product]": "amberone",
      "metadata[plan]": plan.slug,
    }),
  );
  const price = await stripe(
    "prices",
    new URLSearchParams({
      product: product.id,
      currency: "usd",
      unit_amount: String(plan.amount),
      "recurring[interval]": "month",
      "metadata[product]": "amberone",
      "metadata[plan]": plan.slug,
    }),
  );
  out[plan.env] = price.id;
  console.log(`${plan.env}=${price.id}`);
}

console.log(JSON.stringify({ ok: true, prices: out }, null, 2));
