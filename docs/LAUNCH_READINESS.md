# AmberOne Launch Readiness Report

**Date:** 2026-07-29  
**Production:** https://amberone.pages.dev  
**Latest deploy:** https://8eac4482.amberone.pages.dev  
**Evidence:** `docs/PROD-QA-REPORT.json`, `docs/PROD-QA-UI.json`

## Verdict

**Ready for public launch: YES**

| Metric | Score |
|--------|------:|
| Performance | **96** |
| Security | **90** |
| Production readiness | **100%** |
| Critical / High issues | **0 / 0** |

## What was tested

- Every public page + dashboard routes (extensionless + `.html`)
- Signup, login, logout, session `/api/auth/me`
- Password forgot API (no token leak) + reset rejects bad tokens
- Talk (OpenAI), Stripe Checkout, Billing, Portal (pre-pay expected 400), Webhook signature reject
- All 12 Pages secrets present + D1 bound
- Playwright: console errors, mobile nav, CTAs, Talk panel, signup→dashboard→logout
- Security headers (`X-Frame-Options`, `nosniff`, Referrer-Policy, Permissions-Policy)

## Remaining issues (non-blocking)

| Severity | Item | Notes |
|----------|------|-------|
| Medium | Resend sending domain | Verify an AmberOne-owned domain in Resend for reliable reset emails |
| Medium | Stripe webhook URL | Confirm live endpoint `https://amberone.pages.dev/api/webhook` in Stripe Dashboard |
| Low | Custom domain / HSTS | Still on `*.pages.dev` |
| Low | Live card charge | Checkout session verified; paid portal path not card-charged in this pass |

## Fixes shipped during QA

- Production forgot-password no longer returns `resetUrl`
- Resend fallback sender when primary `EMAIL_FROM` fails
- Login try/catch; Pages `_headers` security headers

## Server logs

Cloudflare Pages does not expose a durable free log stream in this environment. Runtime behavior was validated via live HTTP responses (no 5xx on auth/checkout/talk after fixes). Use Cloudflare Dashboard → Workers/Pages → amberone → Logs/Metrics for ongoing monitoring.
