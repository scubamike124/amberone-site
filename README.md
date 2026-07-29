# AmberOne

**Mission:** One Assistant. One Place. One Life.

Production surface for the AmberOne Product Blueprint (`AMBERONE_BLUEPRINT.md`).

## Stack

- Cloudflare Pages (static site + Functions)
- Cloudflare D1 (users, sessions, password resets, billing events)
- Shared Amber Stripe account (Checkout + Customer Portal + webhooks)
- Optional: Resend (password-reset email), OpenAI (Talk to Amber)

## Local

```bash
npm install
npm run db:migrate:local
# copy .env.example → .dev.vars and fill secrets
npm run dev
```

Open http://127.0.0.1:8788

## Production

1. `npx wrangler login` (owner Cloudflare account)
2. `npx wrangler d1 create amberone` → paste `database_id` into `wrangler.toml`
3. `npm run db:migrate:remote`
4. Set Pages secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, optional price IDs / `RESEND_API_KEY` / `OPENAI_API_KEY`
5. `npm run stripe:catalog` (with Stripe key) then store printed price IDs as secrets
6. Point Stripe webhook to `https://<host>/api/webhook` for:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
7. `npm run deploy`
8. Attach custom domain in Cloudflare Pages (owner DNS)

## Scripts

- `npm run build` — production file/build gate
- `npm run test:smoke` — HTTP smoke against local/dev URL
- `npm run stripe:catalog` — create AmberOne products/prices on Stripe
