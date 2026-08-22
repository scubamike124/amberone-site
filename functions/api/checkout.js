import {
  PLANS,
  getUserFromRequest,
  json,
  originFrom,
  publicStripeError,
  readJson,
  stripeForm,
} from "../_lib/core.js";

export async function onRequestPost(context) {
  try {
    const secret = context.env.STRIPE_SECRET_KEY;
    if (!secret) return json({ error: "Stripe not configured yet. Add STRIPE_SECRET_KEY." }, 503);

    const db = context.env.DB;
    const user = db ? await getUserFromRequest(db, context.request) : null;
    if (user && (String(user.account_kind || "") === "beta" || String(user.plan_slug || "") === "beta_full")) {
      return json(
        {
          error: "Beta testers use a complimentary full-access workspace. Billing and payment credentials stay with the owner.",
          code: "beta_restricted",
        },
        403,
      );
    }
    const body = await readJson(context.request);
    const planId = String(body.plan || "personal").toLowerCase();
    const plan = PLANS[planId];
    if (!plan) return json({ error: "Unknown plan" }, 400);
    if (/enterprise|custom/.test(planId)) {
      return json({ error: "That plan is not available — choose a self-service plan." }, 400);
    }

    const origin = originFrom(context.request);
    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set(
      "success_url",
      `${origin}/dashboard/billing?checkout=success&plan=${encodeURIComponent(planId)}`,
    );
    params.set(
      "cancel_url",
      `${origin}/pricing?checkout=cancel&plan=${encodeURIComponent(planId)}`,
    );
    params.set("allow_promotion_codes", "true");
    params.set("billing_address_collection", "required");
    params.set("line_items[0][quantity]", "1");

    const priceId = context.env[plan.priceEnv];
    if (priceId) {
      params.set("line_items[0][price]", String(priceId));
    } else {
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", String(plan.amount));
      params.set("line_items[0][price_data][recurring][interval]", "month");
      params.set("line_items[0][price_data][product_data][name]", plan.name);
      params.set("line_items[0][price_data][product_data][metadata][product]", "amberone");
    }

    params.set("metadata[plan]", planId);
    params.set("metadata[product]", "amberone");
    if (user) {
      params.set("metadata[userId]", user.id);
      params.set("client_reference_id", user.id);
      if (user.stripe_customer_id) params.set("customer", user.stripe_customer_id);
      else params.set("customer_email", user.email);
      params.set("subscription_data[metadata][userId]", user.id);
      params.set("subscription_data[metadata][plan]", planId);
      params.set("subscription_data[metadata][product]", "amberone");
    } else if (body.email) {
      params.set("customer_email", String(body.email));
    }

    const { ok, data } = await stripeForm(secret, "checkout/sessions", params);
    if (!ok || !data?.url) {
      const message = publicStripeError(data?.error?.message || "Checkout failed");
      const status = /temporarily unavailable/i.test(message) ? 503 : 502;
      console.error("checkout stripe error");
      return json({ error: message }, status);
    }
    return json({ url: data.url, id: data.id });
  } catch (err) {
    console.error("checkout failed", err);
    return json({ error: "Checkout is temporarily unavailable. Try again in a moment." }, 503);
  }
}

export async function onRequestGet() {
  return json({ error: "POST { plan }" }, 405);
}
