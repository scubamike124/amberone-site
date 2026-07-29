import {

  getUserFromRequest,

  json,

  nowIso,

  publicUser,

  uid,

  verifyStripeSignature,

} from "../_lib/core.js";



function mapSubscriptionStatus(type, remote) {

  const r = String(remote || "").toLowerCase();

  if (type === "customer.subscription.deleted" || r === "canceled") return "canceled";

  if (r === "past_due") return "past_due";

  if (r === "trialing") return "trialing";

  if (r === "incomplete" || r === "incomplete_expired") return "incomplete";

  if (r === "unpaid") return "past_due";

  if (r === "active") return "active";

  return r || "active";

}



async function applySubscriptionObject(db, object, type) {

  const customerId = typeof object.customer === "string" ? object.customer : null;

  const subscriptionId = object.id || null;

  const status = mapSubscriptionStatus(type, object.status);

  const plan = object.metadata?.plan || null;

  if (!customerId) return;

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



async function applyCheckoutCompleted(db, object) {

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

    return;

  }

  if (customerId) {

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



async function applyInvoice(db, object, type) {

  const customerId = typeof object.customer === "string" ? object.customer : null;

  if (!customerId) return;

  const subscriptionId =

    typeof object.subscription === "string" ? object.subscription : object.subscription?.id || null;

  const status = type === "invoice.payment_failed" ? "past_due" : "active";

  await db

    .prepare(

      `UPDATE users SET

        stripe_subscription_id = COALESCE(?, stripe_subscription_id),

        subscription_status = ?,

        updated_at = ?

       WHERE stripe_customer_id = ?`,

    )

    .bind(subscriptionId, status, nowIso(), customerId)

    .run();

}



export async function onRequestPost(context) {

  const payload = await context.request.text();

  const signature = context.request.headers.get("stripe-signature");

  const secret = context.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {

    return json({

      status: "READY_FOR_CONFIGURATION",

      message: "Add STRIPE_WEBHOOK_SECRET to process live billing events.",

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



  const eventId = event.id || null;

  const type = event.type || "unknown";

  const object = event.data?.object || {};



  // Idempotency: Stripe may retry; event.id must only process once.

  if (eventId) {

    const prior = await db

      .prepare("SELECT id FROM billing_events WHERE stripe_id = ? LIMIT 1")

      .bind(eventId)

      .first();

    if (prior) {

      return json({ received: true, duplicate: true, type, eventId });

    }

  }



  await db

    .prepare(

      "INSERT INTO billing_events (id, user_id, type, stripe_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",

    )

    .bind(

      uid("evt"),

      object.metadata?.userId || null,

      type,

      eventId,

      payload.slice(0, 100000),

      nowIso(),

    )

    .run();



  if (type === "checkout.session.completed") {

    await applyCheckoutCompleted(db, object);

  } else if (

    type === "customer.subscription.created" ||

    type === "customer.subscription.updated" ||

    type === "customer.subscription.deleted"

  ) {

    await applySubscriptionObject(db, object, type);

  } else if (type === "invoice.paid" || type === "invoice.payment_failed") {

    await applyInvoice(db, object, type);

  }



  return json({ received: true, type, eventId, note: verified.message });

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


