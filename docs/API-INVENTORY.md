# AmberOne Complete API Inventory

**Generated:** 2026-07-29T14:20:12.885Z  
**Target:** https://amberone.pages.dev  

## Summary

| Metric | Value |
|--------|------:|
| Total integrations | 12 |
| Required | 9 |
| Required obtained | 9 |
| Required missing/partial | 0 |
| All required obtained | **YES** |

## Inventory

| ID | Name | Required | Credential | Status | Source |
|----|------|----------|------------|--------|--------|
| cloudflare-pages | Cloudflare Pages | Required | `— (hosting)` | **obtained** | Cloudflare project amberone |
| cloudflare-d1 | Cloudflare D1 | Required | `D1_DATABASE_ID + binding DB` | **obtained** | D1 database amberone |
| cloudflare-api-token | Cloudflare API Token (ops) | Optional | `CLOUDFLARE_API_TOKEN` | **obtained** | Amber HQ Vault |
| cloudflare-account-id | Cloudflare Account ID | Required | `CLOUDFLARE_ACCOUNT_ID` | **obtained** | Amber HQ Vault |
| stripe-secret | Stripe Secret Key (live) | Required | `STRIPE_SECRET_KEY` | **obtained** | Amber HQ Vault |
| stripe-publishable | Stripe Publishable Key | Optional | `STRIPE_PUBLISHABLE_KEY` | **obtained** | Amber HQ Vault |
| stripe-webhook-secret | AmberOne Stripe Webhook Signing Secret | Required | `STRIPE_WEBHOOK_SECRET / AMBERONE_STRIPE_WEBHOOK_SECRET` | **obtained** | AmberOne endpoint we_1TyYA6PuIFB5w4OsffjMshoU |
| stripe-prices | Stripe Price IDs (7 plans) | Required | `STRIPE_PRICE_*` | **obtained** | docs/stripe-prices.json + live Stripe |
| openai | OpenAI API | Required | `OPENAI_API_KEY` | **obtained** | Amber HQ Vault |
| resend | Resend Email API | Required | `RESEND_API_KEY` | **obtained** | Amber HQ Vault |
| email-from | Email From address | Required | `EMAIL_FROM` | **obtained** | Vault MAIL_FROM / EMAIL_FROM |
| google-fonts | Google Fonts CDN | Optional | `none` | **obtained** | public CDN |

## Missing / partial required

_None — all required APIs/credentials obtained and verified._
