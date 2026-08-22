# AmberOne Feature-to-API Matrix (Master Roadmap)

**Generated:** 2026-07-29  
**Source of truth:** `AMBERONE_BLUEPRINT.md` / HQ `docs/blueprint/21-amberone.md` (ACTIVE)  
**Inherits:** Platform Brain · Experience Blueprint · AIS metrics  
**Production URL:** https://amberone.pages.dev  
**Production-ready declaration:** **NO** — analysis complete; product incomplete

Machine-readable twin: [`FEATURE-API-MATRIX.json`](./FEATURE-API-MATRIX.json)

---

## Executive verdict

Infrastructure credentials are obtained. That is **Phase 0 launch shell**, not AmberOne the product.

| Scope | Complete |
|-------|---------:|
| Full approved roadmap (effort-weighted) | **~30%** |
| Feature-count (Complete + 0.4× In Progress) | **~42%** |
| Phase 0 — launch shell | **~85%** |
| Phase 1 — Personal core | **~78%** |
| Phase 2 — Family / Executive / Business | **0%** |
| Phase 3 — Marketplace / white-label | **0%** |
| First production release scope* | **~68%** |

\*First production release = Phase 0 + Phase 1 Personal MVP **excluding** Twilio Calls/SMS/phone voice (Phase 1b). Includes Memory, Calendar, Reminders, Composio hub, Google Calendar sync, Home dashboard, Notifications, onboarding, audit/backup.

---

## Feature-to-API Matrix

| Feature | Purpose | Required API(s) | API status | Build | Priority | Effort | Dependencies |
|---------|---------|-----------------|------------|-------|----------|--------|--------------|
| User authentication | Signup/login/session/password reset | D1, Resend | Configured | Complete | Critical | 5d | — |
| Stripe billing | Checkout, portal, webhooks, 7 plans | Stripe secret, whsec, prices ×7 | Configured | Complete | Critical | 10d | Auth |
| Transactional email | Password reset / system mail | Resend, EMAIL_FROM | Configured | Complete | Critical | 2d | — |
| Marketing & pricing site | Landing, FAQ, legal, pricing | — | Not Required | Complete | High | 4d | Billing |
| Product Brain (docs) | Layer-2 AmberOne standards | — | Not Required | Complete | Critical | 2d | — |
| AI chat (Talk to Amber) | Central assistant; tool-using actions | OpenAI | Configured | Complete | Critical | 8d | Auth, Memory |
| Customer dashboard | Plan status, Talk, billing/settings | — | Not Required | Complete | Critical | 5d | Auth, Billing |
| Security (auth layer) | Hashing, sessions, HTTPS | Cloudflare Pages | Configured | Complete | Critical | 4d | Auth |
| Monitoring (health) | `/api/health` + future APM | D1 | Configured | Complete | High | 3d | — |
| AI memory / Memory Vault | People, places, prefs, natural search | OpenAI, D1 | Configured | Complete | Critical | 12d | Auth, Talk |
| Calendar engine | Events, recurrence, conflicts | D1; Composio for Google | Configured | Complete | Critical | 14d | Auth, Composio |
| Reminders | Timed/bill reminders | D1, Resend; Twilio for SMS | Configured | Complete | Critical | 8d | Auth, Notifications |
| Calls and messaging | Voice/SMS; receptionist foundation | Twilio, OpenAI | Missing | Not Started | Critical | 16d | Auth, Talk |
| Notes & shopping lists | Notes/lists via Talk | D1, OpenAI | Configured | Complete | High | 5d | Talk, Memory |
| Daily briefing & evening recap | Proactive summaries | OpenAI, D1 | Configured | Complete | High | 6d | Calendar, Reminders, Memory |
| Home dashboard (product) | Greeting, schedule, reminders, Talk | OpenAI, D1 | Configured | Complete | Critical | 7d | Briefing, Calendar |
| Notifications | In-app + email (+ SMS later) | Resend; Twilio SMS | Configured | Complete | High | 6d | Auth, Email |
| Composio / Connected Services | Integration Hub | **Composio API key** | Configured | Complete | Critical | 10d | Auth, Security |
| Google Calendar integration | Sync via Composio | Composio → Google Calendar | Configured | Complete | Critical | 6d | Composio, Calendar |
| Gmail integration | Exec email assist | Composio → Gmail | Configured | Complete | High | 8d | Composio, Talk |
| Google Drive integration | Docs for memory/workflows | Composio → Drive | Missing | Not Started | Medium | 5d | Composio |
| Microsoft 365 integration | Outlook/Calendar for Exec | Composio → Microsoft | Missing | Not Started | Medium | 8d | Composio |
| CRM | Contacts, follow-ups, pipeline | D1, OpenAI; Composio optional | Configured | Not Started | High | 12d | Memory, Talk |
| Social media publishing | Instagram / Nextdoor + full AI Marketing Manager (profile, calendar, approval modes, goals, recommendations) | Amber HQ `/dashboard/business-marketing` + vault | Partial (engine + hold) | In Progress | High | — | Business |
| Business / user onboarding | First-run connect + prefs | — | Not Required | Complete | High | 5d | Auth, Composio |
| AI automation engine | Manual / Assisted / Automatic | OpenAI, D1, Composio | Missing | Not Started | High | 14d | Talk, Memory, Composio |
| Workflow automation | Multi-step + approvals + resiliency | D1, OpenAI, Composio | Missing | Not Started | High | 12d | Composio, Audit |
| Family dashboard | Shared life for Family plans | D1, OpenAI | Configured | Not Started | High | 12d | Calendar, Memory |
| Business dashboard | Customers, appts, marketing, team | D1, OpenAI, Composio, Twilio | Missing | Not Started | High | 16d | CRM, Calls, Social |
| Executive suite | Email, meetings, prep, follow-ups | OpenAI, Composio Gmail/Cal, D1 | Missing | Not Started | High | 14d | Gmail, Calendar, CRM |
| Admin dashboard | Operator users/plans/audit | D1, CF API | Configured | Not Started | Medium | 8d | Audit, Health |
| Analytics | Usage / retention / conversion | D1 (first-party) | Configured | Not Started | Medium | 6d | Auth, Talk |
| Reports | User + resiliency summaries | OpenAI, D1 | Configured | Not Started | Medium | 5d | Workflows |
| File management | User file upload/store | **Cloudflare R2** (when built) | Missing | Not Started | Medium | 6d | Auth |
| Search | NL search memory/notes/CRM | OpenAI, D1 | Configured | Not Started | Medium | 7d | Memory |
| Learning engine | Preference learning over time | OpenAI, D1 | Configured | Not Started | Medium | 10d | Memory, Workflows |
| Business Brain (customer) | Per-customer private brain data | D1, OpenAI | Configured | Not Started | High | 10d | Memory |
| Customer Brain | Connected accts, memories, workflows | D1, Composio, OpenAI | Missing | Not Started | Critical | 12d | Memory, Composio, Calendar |
| API management | Versioned APIs / marketplace keys | — | Not Required | Not Started | Low | 8d | Security |
| Audit logs | Action trail for security | D1 | Configured | Complete | High | 4d | Auth |
| Backup and recovery | D1 backups + restore drills | D1 / CF API | Configured | Complete | Medium | 4d | Health |
| Voice-first experience | Browser + phone voice | OpenAI; Twilio phone | Missing | Not Started | High | 12d | Talk, Calls |
| Travel planning | Conversational travel assist | OpenAI | Configured | Not Started | Medium | 6d | Talk, Calendar |
| AI receptionist | Answer calls, book appts | Twilio, OpenAI | Missing | Not Started | High | 14d | Calls, Calendar, CRM |
| Marketplace skills | Industry packs $5–15 | New Stripe prices, OpenAI | Missing | Not Started | Low | 20d | Billing, Automation |
| White label | Partner branding $499–999 | Stripe, multi-tenant Pages | Missing | Not Started | Low | 30d | API mgmt |
| GitHub integration | — | — | Not Required | — | Low | — | **Out of Product Brain — do not obtain** |
| Slack integration | — | — | Not Required | — | Low | — | **Out of Product Brain — do not obtain** |

---

## 1. APIs already complete

| API | Role |
|-----|------|
| Cloudflare Pages | Hosting + Functions |
| Cloudflare D1 | Primary DB (current stack; blueprint named Supabase — **do not migrate unless owner decides**) |
| Cloudflare Account ID + API token | Deploy / secrets |
| Stripe live secret + 7 prices + AmberOne webhook | Billing |
| OpenAI | Talk / AI Brain |
| Resend + EMAIL_FROM | Transactional email |

These are **sufficient** for: auth, billing, basic Talk, email reset, Memory v1 (D1), notes, first-party CRM schema, audit logs, analytics (first-party).

---

## 2. APIs still required

| API | Why (roadmap-required) | Needed before |
|-----|------------------------|---------------|
| **Twilio** (SID, Auth Token, number) | Phase 1 Communications: Calls, SMS, receptionist | Calls/Messaging, SMS notifications, phone voice |

**Composio** is obtained and verified (Google Calendar + Gmail ACTIVE). Do **not** obtain standalone Gmail/Calendar/Drive OAuth apps unless Composio requires app credentials during setup.

---

## 3. APIs optional for future versions

| API | When / note |
|-----|-------------|
| Cloudflare R2 | Phase 2 file uploads (preferred on CF stack) |
| New Stripe prices | Phase 3 marketplace / white-label only |
| Product analytics SaaS | Only if first-party D1 analytics insufficient |
| Paid weather API | Prefer free Open-Meteo for briefing |
| Supabase | Named in blueprint; **not required** while D1 is the live stack |
| Slack / GitHub | **Not in Product Brain — do not obtain for AmberOne** |

---

## 4. Recommended implementation order

1. Owner confirms **live card Checkout** charge  
2. Talk upgrade — history + authenticated context + tool framework  
3. **Memory Vault** (D1 + OpenAI grounding)  
4. Obtain **Composio** → Connected Services connect UI  
5. Internal **Calendar** + **Reminders** (email via Resend)  
6. **Google Calendar** sync via Composio  
7. Product **Home dashboard** + Notifications center  
8. **Onboarding** wizard  
9. **Audit logs** + D1 backup runbook  
10. Obtain **Twilio** → Calls / SMS / Messaging (Phase 1b)  
11. Browser voice-first  
12. Family dashboard → Executive (Gmail) → Business (CRM + social)  
13. Automation Center + workflows  
14. Marketplace / white-label (Phase 3)

---

## 5. Roadmap completion

| Metric | Value |
|--------|------:|
| Full approved roadmap | **~30%** (effort-weighted) |
| First production release scope | **~68%** |
| Phase 0 launch shell | **~85%** |
| Phase 1 Personal core | **~78%** |

**Infrastructure inventory complete ≠ AmberOne complete.** Composio Google connections verified; live Stripe card + Twilio Phase 1b + remaining Personal features still open.

---

## 6. Top remaining tasks before first production release

1. Optional travel planning  
2. Full owner walkthrough / regression  
3. **Live card Checkout confirmation** — final gate only, after E2E testing is complete  
4. **Phase 1b Twilio** — Calls / SMS when owner prioritizes  

---

## Stack note

Blueprint lists **Supabase**. Live AmberOne uses **Cloudflare D1**. Treat D1 as the approved implementation stack unless the owner explicitly reverses that decision. Do not obtain Supabase “to match the doc.”

---

## Production readiness

**AmberOne is not production-ready** until the final live card Checkout gate passes. Phase 1 Personal core is largely verified (Talk, Memory, Calendar, Reminders, Notes/Lists, Briefing, Google Calendar sync, Gmail read/draft). Twilio remains Phase 1b.
