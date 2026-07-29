# AmberOne Milestone Progress

Living tracker for the AmberOne roadmap (M1–M10). Update this file whenever a milestone's status changes — this is the single source of truth for "what's actually live" vs. "what's blocked."

Status legend: `PASS` (verified working) · `PARTIAL` (some sub-items pass, some don't) · `BLOCKED` (cannot proceed without an external dependency) · `OWNER BLOCKER` (needs the Owner to provide a key, account, or decision) · `NOT STARTED`.

---

## M1 — Foundation: Auth, Billing, Marketing Site

**Status: PASS (automated) / OWNER BLOCKER (live card charge)**

- Signup / login / logout / password reset — **PASS** (`scripts/e2e-customer-journey.mjs`)
- Stripe Checkout session creation — **PASS** (test + live mode verified via API)
- Stripe webhook signature verification + idempotency — **PASS**
- Customer Portal — **PASS**
- Marketing pages (`/`, `/pricing`, `/faq`, etc.) — **PASS**
- **Live card charge end-to-end (real payment in live mode) — OWNER BLOCKER.** Live Stripe mode does not accept test cards; a real payment method from the Owner is required to fully close the loop on a paid subscription. Checkout session + webhook application logic are verified; only the actual card-present charge step is outstanding.

Evidence: `docs/AMBERONE-STRIPE-BILLING-VERIFY.json`, `docs/E2E-CUSTOMER-JOURNEY.json`, `docs/LAUNCH_READINESS.md`.

---

## M2 — AI Conversations (Talk) with Memory & Tool Calling

**Status: PASS (production verified 2026-07-29)**

- `functions/api/talk.js` rewritten with OpenAI function calling: `save_memory`, `list_memories`, `create_calendar_event`, `list_calendar_events`, `create_reminder`, `list_reminders`, `get_account_status`
- Conversation persistence (`conversations`, `messages` tables), last-20-message context window
- Anonymous/marketing visitors keep the lightweight FAQ/OpenAI flow (no tools, no history)
- Audit log entry written for every tool-driven mutation

Evidence: `docs/PHASE1-CORE-VERIFY.json` — **18/18 PASS** on https://amberone.pages.dev

---

## M3 — Calendar Engine

**Status: PASS (local CRUD + Google sync verified)**

- Local calendar CRUD (`functions/api/calendar.js`) — **PASS** (production verified)
- Google Calendar sync (`functions/api/calendar-sync.js` via Composio) — **PASS** — imported live events from connected Google account (`docs/COMPOSIO-CONNECT-VERIFY.json`)

---

## M4 — Memory System

**Status: PASS (production verified)**

- CRUD via `functions/api/memories.js`
- Assistant can save/read memories via Talk tool calls
- Grounding: top memories are injected into the Talk system prompt

---

## M5 — Reminders & Notifications

**Status: PASS (production verified)**

- Reminder CRUD (`functions/api/reminders.js`), due-reminder dispatch on every GET/POST
- In-app notifications (`functions/api/notifications.js`)
- Email delivery via Resend when `RESEND_API_KEY` + `EMAIL_FROM` are configured (already set in this environment) — otherwise notification is still created in-app, email is skipped silently (no fake "sent" claims)

---

## M6 — Connected Services / Integration Hub (Composio)

**Status: PASS (hub + Google Calendar + Gmail live)**

- `COMPOSIO_API_KEY` in vault, verified against Composio API, pushed to Pages
- Created Composio-managed auth configs for Google Calendar + Gmail; IDs in vault + Pages
- Production `/api/connected-services`: both toolkits **ACTIVE** after owner OAuth
- Calendar sync: `synced: 1` event imported into D1

Evidence: `docs/COMPOSIO-OBTAIN.json`, `docs/COMPOSIO-AUTH-CONFIGS.json`, `docs/COMPOSIO-CONNECT-VERIFY.json`

---

## M7 — Onboarding

**Status: PASS (production verified)**

- `functions/api/onboarding.js` + `dashboard/onboarding.html`: welcome → plan → connect calendar (optional) → memory permission prefs → done
- Home dashboard surfaces a "finish setup" CTA until onboarding is complete

---

## M8 — Audit & Trust

**Status: PASS (production verified)**

- `writeAudit()` helper in `functions/_lib/core.js`, called from every mutating API (memories, calendar, reminders, notifications, connections, onboarding, talk tool calls)
- `functions/api/audit.js` exposes the last 50 entries per user
- D1 backup/recovery runbook: `docs/D1-BACKUP-RECOVERY.md`

---

## M9 — Communications (Phone / SMS via Twilio)

**Status: NOT STARTED (Phase 1b, intentionally deferred)**

Per product scope, Twilio integration is explicitly out of scope for this phase. No Twilio code, env vars, or UI affordances have been added.

---

## M10 — Family / Executive / Business Dashboards, Marketplace, White-Label

**Status: NOT STARTED (Phase 2/3 per `AMBERONE_BLUEPRINT.md` roadmap)**

---

## Outstanding Owner blockers (summary)

| Blocker | Needed for | What to provide |
|---|---|---|
| Live payment method | Final E2E / production-ready gate only | A real card **after** full product testing is complete |
| Re-paste KieAI (optional) | Reelo video | Real `KIE_API_KEY` if still needed |

## M11 — Notes & Shopping Lists

**Status: PASS (production verified 2026-07-29)**

- D1 tables: `notes`, `lists`, `list_items`
- APIs: `/api/notes`, `/api/lists`
- Talk tools: `create_note`, `list_notes`, `create_list`, `add_list_item`, `list_lists`, `complete_list_item`
- UI: `/dashboard/notes`

Evidence: `docs/PHASE1-CORE-VERIFY.json`

---

## M12 — Daily Briefing & Evening Recap

**Status: PASS (production verified 2026-07-29)**

- `/api/briefing` (morning / evening / auto) with day cache in D1 `briefings`
- OpenAI polish when key present; template fallback otherwise
- Optional weather via free Open-Meteo (city from onboarding prefs)
- Home panel + Talk tool `get_briefing`
- Onboarding captures timezone + optional weather city

Evidence: `docs/PHASE1-CORE-VERIFY.json` — **27/27 PASS** on https://amberone.pages.dev

---

## M13 — Gmail Assist (read + draft)

**Status: PASS (production verified 2026-07-29)**

- `/api/gmail` inbox fetch + draft create (send intentionally not enabled)
- Talk tools: `list_emails`, `create_email_draft`
- Connections page inbox preview when Gmail is ACTIVE
- Live send remains owner-gated

Evidence: `docs/GMAIL-ASSIST-VERIFY.json` — **7/7 PASS**

No feature in this document is marked `PASS` unless it was verified against real code paths (see `scripts/verify-phase1-core.mjs` and the JSON reports it produces).

**Latest production suite:** 27/27 Phase 1 core PASS · Gmail assist 7/7 PASS · Live card deferred to **final E2E gate** per owner · Google Calendar + Gmail Connected Services **PASS** · Notes & Lists **PASS** · Briefing / Recap **PASS**.
