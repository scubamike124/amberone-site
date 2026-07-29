import { getUserFromRequest, json, publicUser } from "../_lib/core.js";

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const events = await db
    .prepare(
      "SELECT id, type, stripe_id, created_at FROM billing_events WHERE user_id = ? OR user_id IS NULL ORDER BY created_at DESC LIMIT 20",
    )
    .bind(user.id)
    .all();

  return json({
    user: publicUser(user),
    billing: {
      planSlug: user.plan_slug,
      status: user.subscription_status,
      stripeCustomerId: user.stripe_customer_id,
      stripeSubscriptionId: user.stripe_subscription_id,
    },
    events: events.results || [],
    stripeConfigured: Boolean(context.env.STRIPE_SECRET_KEY),
    portalReady: Boolean(user.stripe_customer_id),
  });
}
