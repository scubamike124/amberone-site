# AmberOne API Readiness Report

**Generated:** 2026-07-29T14:11:10.073Z  
**Target:** https://amberone.pages.dev  
**Declaration:** **NOT production-ready** until every required integration passes end-to-end.

## Summary

| Metric | Value |
|--------|------:|
| Inventory items | 10 |
| Required integrations | 7 |
| Optional integrations | 3 |
| Required E2E tests passed | 15 / 15 |
| Blocking gaps | 0 |
| Production-ready | **NO** |

## Inventory

| ID | Service | Required? | Purpose | Secrets / config |
|----|---------|-----------|---------|------------------|
| cloudflare-pages | Cloudflare Pages hosting | **Required** | Serve site + Functions | Pages project amberone |
| cloudflare-d1 | Cloudflare D1 (binding DB) | **Required** | Users, sessions, password resets, billing_events | database_id 0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a, binding DB |
| stripe-api | Stripe API (Checkout + Portal) | **Required** | Subscription checkout + customer portal | STRIPE_SECRET_KEY |
| stripe-prices | Stripe Price IDs (catalog) | **Required** | Stable plan prices for all 7 self-service plans | STRIPE_PRICE_PERSONAL, STRIPE_PRICE_FAMILY_2, STRIPE_PRICE_FAMILY_5, STRIPE_PRICE_FAMILY_10, STRIPE_PRICE_EXECUTIVE, STRIPE_PRICE_BUSINESS_SMALL, STRIPE_PRICE_BUSINESS_MEDIUM |
| stripe-webhook | Stripe Webhook → /api/webhook | **Required** | Persist customer/subscription after checkout; keep plan status in sync | STRIPE_WEBHOOK_SECRET |
| openai | OpenAI Chat Completions | **Required** | Talk to Amber product experience | OPENAI_API_KEY |
| resend | Resend Email API | **Required** | Password reset email delivery | RESEND_API_KEY, EMAIL_FROM |
| google-fonts | Google Fonts CDN | **Optional** | Typography | fonts.googleapis.com |
| cf-api-token-deploy | Cloudflare API Token (deploy/ops) | **Optional** | Deploy + manage Pages secrets (not used at request runtime) | CLOUDFLARE_API_TOKEN |
| allow-reset-url-fallback | ALLOW_RESET_URL_FALLBACK | **Optional** | Dev-only reset URL in API response | Must stay unset/false in production |

## Required E2E test results

| Test | Status | Detail |
|------|--------|--------|
| Pages production secrets present | **PASS** | All 12 required secrets present on Pages |
| D1 binding DB on Pages production | **PASS** | Bound DB id=0b00c9b1-dbda-4be4-b603-1b5d3d16bc3a |
| D1 runtime read/write schema (health) | **PASS** | tables=_cf_KV,billing_events,password_resets,sessions,users; users=12 |
| Auth signup → session cookie | **PASS** | HTTP 201; cookie=true |
| Stripe API authentication (GET /v1/account) | **PASS** | mode=live; charges_enabled=true; country=US |
| Stripe Price IDs resolve & active | **PASS** | All 7 prices active |
| Checkout session create (production) | **PASS** | session=cs_live_b1yAlSC8lFwnUn9oKGXIUmbC0bYtvgynf0UAvykn7kUJM4MvSLhYLVyJcL; urlHost=checkout.stripe.com |
| Stripe Dashboard webhook points at AmberOne | **PASS** | Found enabled endpoint we_1TyYA6PuIFB5w4OsffjMshoU → https://amberone.pages.dev/api/webhook |
| Signed webhook accepted by production /api/webhook | **PASS** | received type=checkout.session.completed |
| Customer Portal session (after customer link) | **PASS** | billing.stripe.com portal URL returned |
| Talk to Amber via OpenAI | **PASS** | source=openai; replyLen=130 |
| Resend API authentication | **PASS** | domains=1; EMAIL_FROM fingerprint domain=myreelo.com |
| EMAIL_FROM domain verified in Resend | **PASS** | Domain myreelo.com verified |
| Resend can send with configured EMAIL_FROM | **PASS** | Send accepted to delivered@resend.dev id=ff7ae59a-57f0-4548-bc93-50cdc6dfdc58 |
| Webhook rejects unsigned payloads | **PASS** | HTTP 400 |

## Blocking gaps (must fix before production-ready)

_None — re-check optional items and ops checklist before launch._

## Notes

- Runtime Pages secrets were checked for **presence only** (values never printed).
- Stripe webhook readiness requires both: secret present on Pages **and** an enabled Stripe endpoint URL exactly matching `https://amberone.pages.dev/api/webhook`.
- Resend requires API key **and** a verified domain matching `EMAIL_FROM`.
