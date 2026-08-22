import { getUserFromRequest, json, originFrom, publicStripeError, readJson, stripeForm } from "../_lib/core.js";

export async function onRequestPost(context) {
  try {
    const secret = context.env.STRIPE_SECRET_KEY;
    if (!secret) return json({ error: "Stripe not configured yet." }, 503);
    const db = context.env.DB;
    if (!db) return json({ error: "Database not configured" }, 503);

    const user = await getUserFromRequest(db, context.request);
    if (!user) return json({ error: "Sign in required" }, 401);
    if (String(user.account_kind || "") === "beta" || String(user.plan_slug || "") === "beta_full") {
      return json(
        {
          error: "Beta testers cannot open the Stripe customer portal or change the owner’s billing.",
          code: "beta_restricted",
        },
        403,
      );
    }
    if (!user.stripe_customer_id) {
      return json({ error: "No Stripe customer yet. Complete checkout first." }, 400);
    }

    const body = await readJson(context.request);
    const returnUrl = body.returnUrl || `${originFrom(context.request)}/dashboard/billing`;
    const params = new URLSearchParams();
    params.set("customer", user.stripe_customer_id);
    params.set("return_url", returnUrl);

    const { ok, data } = await stripeForm(secret, "billing_portal/sessions", params);
    if (!ok) return json({ error: publicStripeError(data?.error?.message || "Portal failed") }, 502);
    return json({ url: data.url });
  } catch (err) {
    console.error("portal failed", err);
    return json({ error: "Billing portal is temporarily unavailable." }, 503);
  }
}
