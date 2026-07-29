# AmberOne Launch Report

**Date:** 2026-07-29  
**Repo:** `C:\Users\michael\Downloads\amberone-site`  
**Local URL:** http://127.0.0.1:8788  
**Hosting target:** Cloudflare Pages project `amberone` (`wrangler.toml`)

## Search findings (before building)

No fuller AmberOne app existed in Downloads/Documents/HQ backups/git remotes/Lovable.

| Source | Result |
|--------|--------|
| `amberone-site` | Marketing shell + checkout function only |
| Amber HQ | Product Brain docs + stamp script only |
| Dayli / Relo / Drape | Separate products; patterns reusable, not AmberOne |
| GitHub remotes | No amberone repository |

**Conclusion:** AmberOne had to be built forward from the marketing shell + HQ blueprint `21-amberone.md`.

## What was fixed / built

- Full Cloudflare Pages platform with Functions + D1
- Auth: signup, login, logout, me, forgot-password, reset-password
- Dashboard: home, billing, settings
- Marketing: home, pricing (all Family tiers), FAQ, privacy, terms
- Talk to Amber (guided FAQ; OpenAI optional)
- Stripe: subscription checkout, Customer Portal, signed webhooks, catalog script
- AmberOne Stripe prices created on shared Stripe account (see `docs/stripe-prices.json`)
- Mobile nav, shared CSS/JS, production build gate, smoke test
- Git initialized and committed (`804c87d`)
- Fixed `_routes.json` so `/api/*` hits Functions
- Auto schema bootstrap for local/prod D1

## What was tested (live interface / HTTP, not code review only)

| Area | Result |
|------|--------|
| All 14 pages/assets | Pass (200) |
| Signup / login / me / logout | Pass |
| Forgot + reset password | Pass (reset URL returned; email provider not configured) |
| Talk to Amber | Pass |
| Stripe Checkout session create | Pass (live Checkout URL returned) |
| Billing API | Pass |
| Portal before customer | Correctly blocked |
| Webhook → persist customer → Portal | Pass (portal URL returned) |
| `npm run build` | Pass |
| `npm run typecheck` | Pass |
| `npm run test:smoke` | Pass |

## Confirmed working locally

- Marketing site + navigation
- Account creation and session auth
- Password reset flow (token path)
- Dashboard access gating
- Stripe Checkout session creation
- Stripe Customer Portal after webhook customer link
- Production build check

## Not yet a full AI OS (roadmap Phase 1+)

Blueprint systems still future work: Supabase migration, OpenAI memory/calendar/calls, Composio, Twilio voice/SMS, Family/Business operational dashboards beyond billing shell. Current release is the **production-ready website + accounts + billing platform**.

## Blocked on owner action (cannot finish without you)

1. **Cloudflare login / deploy** — `wrangler whoami` = not authenticated. Run `npx wrangler login`, then:
   - `npx wrangler d1 create amberone` → paste `database_id` into `wrangler.toml`
   - `npm run db:migrate:remote`
   - Set Pages secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs from `docs/stripe-prices.json`, optional `RESEND_API_KEY`, `OPENAI_API_KEY`
   - `npm run deploy`
2. **Custom domain / DNS** — attach domain in Cloudflare Pages (owner DNS/Cloudflare zone)
3. **Stripe webhook endpoint** — point to `https://<public-host>/api/webhook` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
4. **Resend (or email)** — `RESEND_API_KEY` + from-address for real password-reset emails
5. **Optional OpenAI** — `OPENAI_API_KEY` for live Talk to Amber (guided mode works without it)
6. **GitHub remote** — no remote yet; create `amberone` repo and `git push -u` if you want cloud git sync
7. **Payment / charge confirmation** — complete one real Checkout payment in Stripe test/live UI yourself (we created sessions + portal; did not complete a card charge)

## Is AmberOne truly ready to launch?

**Website + billing platform: YES for local production-readiness.**  
**Public launch: NO until Cloudflare deploy + domain + webhook + (recommended) email are completed by you.**

After you run Cloudflare login, I can continue deploy + public URL verification immediately.
