import {
  getUserFromRequest,
  json,
  nowIso,
  publicUser,
  uid,
  verifyStripeSignature,
} from "../_lib/core.js";

export async function onRequestPost(context) {
  const payload = await context.request.text();
  const signature = context.request.headers.get("stripe-signature");
  const secret = context.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return json({
      status: "READY_FOR_CONFIGURATION",
      message: "Add STRIPE_WEBHOOK_SECRET to process billing events.",
    });
  }

  const verified = await verifyStripeSignature(payload, signature, secret);
  if (!verified.ok) return json({ error: verified.message }, 400);

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);

  const object = event.data?.object || {};
  const type = event.type || "unknown";
  await db
    .prepare(
      "INSERT INTO billing_events (id, user_id, type, stripe_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      uid("evt"),
      object.metadata?.userId || null,
      type,
      object.id || null,
      payload.slice(0, 100000),
      nowIso(),
    )
    .run();

  if (type === "checkout.session.completed") {
    const userId = object.metadata?.userId || object.client_reference_id;
    const customerId = typeof object.customer === "string" ? object.customer : null;
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
    const plan = object.metadata?.plan || null;
    if (userId) {
      await db
        .prepare(
          `UPDATE users SET
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            plan_slug = COALESCE(?, plan_slug),
            subscription_status = 'active',
            updated_at = ?
           WHERE id = ?`,
        )
        .bind(customerId, subscriptionId, plan, nowIso(), userId)
        .run();
    } else if (customerId) {
      await db
        .prepare(
          `UPDATE users SET
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            plan_slug = COALESCE(?, plan_slug),
            subscription_status = 'active',
            updated_at = ?
           WHERE stripe_customer_id = ?`,
        )
        .bind(subscriptionId, plan, nowIso(), customerId)
        .run();
    }
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const customerId = typeof object.customer === "string" ? object.customer : null;
    const subscriptionId = object.id || null;
    const remote = String(object.status || "").toLowerCase();
    let status = "active";
    if (type === "customer.subscription.deleted" || remote === "canceled") status = "canceled";
    else if (remote === "past_due") status = "past_due";
    else if (remote === "trialing") status = "trialing";
    else if (remote === "incomplete" || remote === "incomplete_expired") status = "incomplete";
    const plan = object.metadata?.plan || null;
    if (customerId) {
      await db
        .prepare(
          `UPDATE users SET
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            plan_slug = COALESCE(?, plan_slug),
            subscription_status = ?,
            updated_at = ?
           WHERE stripe_customer_id = ?`,
        )
        .bind(subscriptionId, plan, status, nowIso(), customerId)
        .run();
    }
  }

  return json({ received: true, type, note: verified.message });
}

export async function onRequestGet(context) {
  const user = context.env.DB
    ? await getUserFromRequest(context.env.DB, context.request).catch(() => null)
    : null;
  return json({
    ok: true,
    endpoint: "/api/webhook",
    configured: Boolean(context.env.STRIPE_WEBHOOK_SECRET),
    user: user ? publicUser(user) : null,
  });
}
