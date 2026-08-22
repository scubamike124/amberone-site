import { getUserFromRequest, json, publicUser } from "../_lib/core.js";
import { isBetaAccount } from "../_lib/beta.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const events = await db
    .prepare(
      "SELECT id, type, stripe_id, created_at FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(user.id)
    .all();

  const beta = isBetaAccount(user);
  return json({
    user: publicUser(user),
    billing: {
      planSlug: user.plan_slug,
      status: beta ? "beta" : user.subscription_status,
      stripeCustomerId: beta ? null : user.stripe_customer_id,
      stripeSubscriptionId: beta ? null : user.stripe_subscription_id,
      note: beta
        ? "Complimentary beta workspace. Payment credentials and the owner’s Stripe account are not available here."
        : null,
    },
    events: beta ? [] : events.results || [],
    stripeConfigured: beta ? false : Boolean(context.env.STRIPE_SECRET_KEY),
    portalReady: beta ? false : Boolean(user.stripe_customer_id),
  });
}
