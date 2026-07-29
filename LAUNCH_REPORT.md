# AmberOne Final Launch Report

**Date:** 2026-07-29  
**Public URL:** https://amberone.pages.dev  
**Latest deploy:** https://165a2dec.amberone.pages.dev  
**Local E2E:** http://127.0.0.1:8788 — **22/22 passed**  
**Repo:** `C:\Users\michael\Downloads\amberone-site`

---

## Go / No-Go

**NO-GO for full public launch** (accounts + subscriptions on production).

**CONDITIONAL GO for public marketing preview:** site, Talk to Amber, and Stripe Checkout session creation are live on https://amberone.pages.dev.

**Hard blocker remaining:** production database (Cloudflare D1). The reusable vault Cloudflare API token can manage Pages but returns **401 Authentication error** for D1 and KV. Without D1, production signup/login return `Database not configured`.

---

## Credential discovery (searched before asking)

| Credential | Found? | Source | Reused? |
|------------|--------|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Yes | Amber HQ Vault | Yes — Pages create/deploy/secrets |
| `CLOUDFLARE_ACCOUNT_ID` | Yes | Amber HQ Vault | Yes |
| `STRIPE_SECRET_KEY` (live) | Yes | HQ Vault + `.env.local` | Yes — local + Pages secrets |
| `STRIPE_WEBHOOK_SECRET` | Yes | HQ Vault | Yes locally; **production needs AmberOne-specific endpoint** |
| AmberOne Stripe Price IDs | Created | Shared Stripe account via catalog script | Yes — in Pages secrets |
| `RESEND_API_KEY` | Yes | HQ Vault | Yes — Pages secret; send fails until domain verified |
| `OPENAI_API_KEY` | Yes | HQ Vault | Yes — production Talk uses OpenAI |
| `MAIL_FROM` | Yes | HQ Vault | Yes as `EMAIL_FROM` |
| Wrangler OAuth login | No | Expired temp config only | Used vault token instead |
| Turso / Neon / KV | No usable | — | — |
| AmberOne custom domain zone | No | CF zones: grantpilot/forma/reelo/launchready only | — |

**No duplicate Stripe/OpenAI/Resend/CF credentials were requested.**

---

## What was tested (live, not code review)

### Local full customer journey — **22/22 PASS**
Evidence: `docs/E2E-CUSTOMER-JOURNEY.json`

1. Visit public pages  
2. Create account  
3. Session after signup  
4. Password reset path (Resend domain not verified → reset URL fallback works)  
5. Log in  
6. Dashboard / billing / settings pages  
7. Talk to Amber (OpenAI)  
8. Stripe Checkout session create  
9. Stripe customer + signed webhook → subscription **active**  
10. Success return URL  
11. Billing status confirmed  
12. Customer Portal URL  
13. Password reset complete  
14. Log back in with new password  
15. Talk again  
16. Log out + session cleared  
17. Final log back in  

### Production https://amberone.pages.dev
| Check | Result |
|------|--------|
| `/` `/pricing` `/signup` `/login` `/faq` `/privacy` `/terms` `/dashboard` | 200 |
| Talk to Amber API | 200 · OpenAI |
| Stripe Checkout API | 200 · live Checkout URL |
| Signup / auth DB | **503 Database not configured** (D1 missing) |
| SSL | HTTPS via Cloudflare Pages |
| DNS | `amberone.pages.dev` Cloudflare-managed |

### Build / quality
- `npm run build` pass  
- `npm run typecheck` pass  
- `npm run test:e2e` pass (local)

---

## What was fixed / built

- Full AmberOne platform (was marketing shell only)  
- Auth, dashboard, billing, webhooks, Talk, Stripe catalog  
- Vault secret export into AmberOne `.dev.vars` + Pages secrets  
- Cloudflare Pages project **amberone** created and deployed  
- Password-reset fallback when Resend domain fails  
- Extensionless URL normalization for Pages routing  
- Deploy script strips local D1 UUID so Pages deploy succeeds  

---

## What is deployed

- Cloudflare Pages project: `amberone`  
- Production alias: https://amberone.pages.dev  
- Pages secrets pushed: Stripe, Resend, OpenAI, EMAIL_FROM, price IDs  
- Functions: checkout, talk, portal, webhook, auth/* (auth needs D1)

---

## Remaining owner actions (only what cannot be done from vault)

### 1) Cloudflare D1 permission (REQUIRED for full launch)
**Service:** Cloudflare API Token already in Amber Vault  
**Why:** Token can deploy Pages but cannot create/list D1 (401). Auth storage needs D1.  
**Could not reuse:** no alternate Turso/Neon/KV credential exists in vault.  
**Do this:**
1. Cloudflare Dashboard → My Profile → API Tokens → edit the vault token  
2. Add permission: **Account → D1 → Edit** (and Memberships Read if prompted)  
3. Tell me when done — I will create D1, migrate schema, bind it, redeploy, and re-test production signup end-to-end  

**OR** create D1 named `amberone` in the dashboard and paste the UUID.

### 2) Stripe webhook for AmberOne (REQUIRED for auto subscription sync in prod)
**Service:** Stripe Dashboard (shared account)  
**Why:** Existing `STRIPE_WEBHOOK_SECRET` is for another endpoint; AmberOne needs its own.  
**Obtain:** Developers → Webhooks → Add endpoint  
`https://amberone.pages.dev/api/webhook`  
Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`  
Then paste the new signing secret (I can push it to Pages secrets).

### 3) Resend domain (REQUIRED for real reset emails)
**Service:** Resend  
**Why:** Key exists; sending fails without verified from-domain for AmberOne.  
**Obtain:** Verify a sending domain and set `EMAIL_FROM` (e.g. `AmberOne <noreply@yourdomain>`).  
Reset still works via secure link fallback until then.

### 4) Optional custom domain
Buy/attach e.g. `amberone.app` in Cloudflare Pages (not in current zones).

### 5) Optional real card payment
Stripe is **live** mode. Completing Checkout UI requires your real payment method (cannot automate live charges).

---

## Recommendation

Keep https://amberone.pages.dev as the public preview for marketing + Talk + Checkout.  
**Do not announce full launch** until D1 is attached and production signup/login/billing journey passes the same 22-step E2E against the public URL.

**Next message from you that unblocks me:**  
“D1 permission added” (or paste D1 UUID) — I will finish production auth and re-verify the full public customer journey.
