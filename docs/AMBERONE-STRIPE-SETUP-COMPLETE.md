# AmberOne Stripe Webhook + Billing Setup

**Date:** 2026-07-29  
**Stripe account:** `acct_1TktITPuIFB5w4Os` (live)  
**Status:** Webhook + billing sync **PASS** · Live card charge still needs owner in Checkout UI  
**Production-ready declaration:** **NO** (pending live payment confirmation)

## Completed

1. Identified shared live Stripe account; verified all 7 AmberOne price IDs are live/active on that account.
2. Reviewed portfolio webhook pattern (Dayli/Reelo: dedicated URL + unique `whsec_`).
3. Created AmberOne-only endpoint:
   - **ID:** `we_1TyYA6PuIFB5w4OsffjMshoU`
   - **URL:** `https://amberone.pages.dev/api/webhook`
   - **Status:** enabled
4. Subscribed events (handler-supported + required invoice sync):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
5. Stored **new** AmberOne signing secret as Pages production `STRIPE_WEBHOOK_SECRET` (and `.dev.vars`). Did **not** replace other sites’ endpoints.
6. Redeployed AmberOne (`e674e260.amberone.pages.dev` → production alias).
7. Hardened webhook: idempotent by Stripe `event.id`; handles subscription created/updated/deleted + invoice paid/failed.
8. Verified signed events → 2xx, signature verified, D1 user plan/status updates, duplicates return `{ duplicate: true }`.
9. Billing journey verified: signup → Stripe customer → trial sub → webhooks activate plan in D1 → live Checkout session URL → Customer Portal URL → cancel webhook → status `canceled`.

## Evidence

- `docs/AMBERONE-STRIPE-WEBHOOK-SETUP.json`
- `docs/AMBERONE-STRIPE-BILLING-VERIFY.json`
- `docs/API-READINESS-REPORT.json` (15/15 required tests)

## Still required from owner (payment approval)

Complete one live Checkout payment in the browser (card approval). Automation created `cs_live_…` sessions but cannot enter card details without you.
