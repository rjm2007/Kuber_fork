# HOW OUR ENTIRE SYSTEM WORKS

**Scope:** the architecture that is COMMON to every pipeline. No pipeline deep-dives (Apollo search, enrichment, scraping, draft generation, bulk regeneration, Company Lookup are all deliberately left for later).

**Method:** everything below was read out of the repository at `Kuber/` and out of the live Supabase database (`cron.job`, `information_schema.triggers`, `pg_proc`). Nothing here comes from the PRD or from generic knowledge. Where the code cannot confirm something, it says **NOT CONFIRMED FROM CURRENT CODE**.

**Date of inspection:** 2026-08-13. Git HEAD: `4470fae`.

---

## 1. START WITH THE BIG PICTURE

### 1.1 The diagram, with our actual components

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│  Next.js 15 App Router pages (React 19, Tailwind 4)                  │
│  app/(app)/leads, /campaigns, /dashboard, /unibox, /settings         │
│  Client components call lib/api-client.ts                            │
└───────────────┬──────────────────────────────────────────────────────┘
                │  fetch() with  Authorization: Bearer <Supabase JWT>
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  API LAYER — Next.js Route Handlers (serverless functions)           │
│  app/api/v1/**    → user-facing, JWT-authenticated                   │
│  app/api/enrich/**→ internal workers, x-internal-secret only         │
│  app/api/internal/** → cron/watchdog entry points, secret only       │
│                                                                      │
│  requireAuth / requireManager / requireSuperAdmin (lib/auth)         │
│  dbForUser(user) → company-scoped Supabase client (lib/supabase)     │
└───────────────┬──────────────────────────────────────────────────────┘
                │  supabase-js, SERVICE ROLE key (RLS bypassed)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DATABASE — Supabase Postgres (34 public tables)                     │
│  Application data  +  the work queue  +  job state  +  locks         │
│  RLS is ON everywhere with (effectively) no policies: server only.   │
│  Extensions in use: pg_cron, pg_net, supabase_vault                  │
│  DB triggers: lead_status_self, org_sync_leads                       │
│  Claim RPCs: claim_queued_orgs, claim_unenriched_leads,              │
│              assignment_pick_round_robin (all FOR UPDATE SKIP LOCKED │
│              or FOR UPDATE)                                          │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                ├──► BACKGROUND WORK (there is no separate worker tier)
                │    Same Next.js route handlers, invoked by:
                │      • after() + fetch() self-calls (in-app relay)
                │      • pg_cron → pg_net → HTTPS POST back into the app
                │      • Vercel Cron (GET)
                │      • GitHub Actions (curl)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  EXTERNAL SERVICES (all plain HTTPS from a route handler)            │
│  Apollo.io      people search + people/bulk_match email reveal       │
│  Firecrawl      company website → markdown                           │
│  LLM providers  OpenRouter / OpenAI / Anthropic / Gemini / Mistral / │
│                 Groq  (tiered fallback, lib/services/llm.ts)         │
│  Instantly.ai   actual email sending, sequences, inbox               │
│  Supabase Auth  login / JWT / JWKS                                   │
│  Supabase Vault provider API keys at rest                            │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  DATABASE UPDATE — result written + state column advanced            │
│  organizations.enrichment_stage, leads.status, email_drafts.status,  │
│  draft_regeneration_job_items.status, enrichment_logs, lead_events   │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  NEXT STEP  — "is there more work?" COUNT query                      │
│    yes → after(() => fetch(same route again))   ← the self-chain     │
│    no  → mark complete, return                                       │
│  If the chain dies → pg_cron watchdog restarts it within 10 minutes  │
└──────────────────────────────────────────────────────────────────────┘
                ▲
                │  Instantly posts reply/bounce/open events INBOUND
        ┌───────┴────────────────────────────────┐
        │ POST /api/v1/webhooks/instantly        │
        └────────────────────────────────────────┘
```

### 1.2 Answers to your specific questions

| Question | Answer from the code |
|---|---|
| **What is our frontend?** | Next.js 15.5 App Router + React 19 + Tailwind 4, in the same repo. Pages under `app/(app)/`. Client components use `lib/api-client.ts`; server components read the DB directly through `lib/server/session.ts` → `createScopedClient()`. Also Radix UI, TipTap (email editor), Recharts, `xlsx` (client-side Excel parse), `sonner` (toasts). |
| **What is our backend?** | The same Next.js app. There is **no separate backend service**. Backend = ~100 route handlers under `app/api/`. |
| **Where does the backend run?** | Vercel serverless functions. Evidence: `vercel.json` with a `crons` array, `.env.vercel`, `export const maxDuration = …` on 22 routes, and dozens of code comments referring to "the lambda", "Vercel Cron", "Hobby plan". The exact Vercel project/plan is **NOT CONFIRMED FROM CURRENT CODE** (only asserted in comments — e.g. `app/api/v1/leads/enrich/route.ts:49` says the 300s ceiling "is only real on a paid Vercel plan, and this project deploys to Hobby"). |
| **What database do we use?** | Supabase Postgres. 34 tables in `public`. Server code always uses the **service-role** key (`lib/supabase/admin.ts`), which bypasses RLS; tenant isolation is done in app code by the scoping proxy, not by RLS policies. |
| **Where does background processing happen?** | Inside ordinary Next.js route handlers. There is no worker process, no container, no daemon. |
| **Do we have dedicated workers?** | **No.** The closest thing is the `app/api/enrich/*` route family, which is only callable with the shared `INTERNAL_SECRET` header. Those are "workers" by convention, not by infrastructure. |
| **Do we have a queue?** | **No queue product.** Postgres rows are the queue. See §4. |
| **Do we have cron jobs?** | Yes, in **three different places**: Supabase `pg_cron` (4 jobs, the real ones), Vercel Cron (1 job), GitHub Actions (1 scheduled + 2 manual-only). See §10. |
| **Which external services are involved?** | Apollo, Firecrawl, six LLM providers, Instantly, Supabase (Auth + Postgres + Vault + pg_cron/pg_net). |
| **How do components communicate?** | Browser → API: HTTPS + Supabase JWT bearer. API → DB: supabase-js over HTTPS with the service-role key. API → API: **HTTPS calls to itself** with the `x-internal-secret` header (or a service-role bearer). DB → API: `pg_net.http_post` from a pg_cron job, secret read out of Supabase Vault. Instantly → API: webhook POST. |

### 1.3 One thing worth naming up front: the app talks to itself over HTTP

Every "background job" in this system is the app making an HTTPS request to its own public URL. `lib/internal-url.ts` builds that URL from the incoming request's `x-forwarded-host`/`host` header, falling back to `INTERNAL_APP_URL` → `NEXT_PUBLIC_APP_URL` → `http://localhost:3000`.

That single fact explains most of the architecture: batching, self-chaining, watchdogs, `maxDuration` tuning, and the shared-secret auth model all exist because the unit of background work is *one HTTP request that must finish before the platform kills it*.

---

## 2. WHAT CAN TRIGGER WORK?

Every door through which work enters the system.

| # | TRIGGER | WHAT IT STARTS | WHERE IT IS IMPLEMENTED | WHAT HAPPENS NEXT |
|---|---|---|---|---|
| 1 | **User clicks in the browser** | Any `/api/v1/*` route | `lib/api-client.ts` (client) → `app/api/v1/**/route.ts` | JWT verified, company-scoped DB client built, work done inline and/or handed to a worker via `after()` |
| 2 | **Server-rendered page load** | Direct DB reads, no API hop | `app/(app)/layout.tsx` → `lib/server/session.ts:requireAppSessionContext()`; `lib/server/{leads,campaigns,dashboard,imports}.ts` | Renders HTML. Starts no background work. |
| 3 | **Browser polling timers** | Repeated GETs while a screen is open | `components/app/campaign-drawer.tsx:861` (3s while drafts generating), `:871` (3s while a regen job is active), `:594` (10s comments); `app/(app)/leads/page.tsx:777` (30s, skipped when tab hidden); `app/(app)/app-shell.tsx:99` (60s unread), `:112` (3min Apollo credits); `components/app/service-health-banner.tsx:25` (60s) | Read-only. This is how the UI "sees" background progress — there is **no websocket and no Supabase Realtime** anywhere in the repo. |
| 4 | **`after()` + `fetch()` — the self-chain** | The next batch of the same job, or the next stage | 13 call sites; see §2.1 | The lambda stays alive until the outbound request leaves, then the next invocation claims the next batch |
| 5 | **pg_cron (Supabase, live DB)** | 4 scheduled jobs | `supabase/migrations/2026_07_23_pg_cron_internal_jobs.sql`, `2026_08_04_apollo_reveal_daily_cron.sql`; verified live in `cron.job` | `public.ping_internal_route()` reads `internal_secret` + `app_base_url` from Vault and `net.http_post`s our own route |
| 6 | **Vercel Cron** | `/api/internal/reconcile-counters` daily at `30 2 * * *` | `vercel.json` | GET with `Authorization: Bearer <CRON_SECRET>`; recomputes campaign counters, then also runs the enrichment watchdog |
| 7 | **GitHub Actions** | `retry-failed-orgs` every 3h (`0 */3 * * *`) | `.github/workflows/retry-failed-orgs.yml` | `curl -X POST` with `INTERNAL_SECRET`. The other two workflows (`watchdog.yml`, `unibox-sync.yml`) are `workflow_dispatch:` **only** — their schedules moved to pg_cron on 2026-07-23. |
| 8 | **Instantly webhook** | Reply / sent / open / bounce / unsubscribe ingestion | `app/api/v1/webhooks/instantly/route.ts` | Verifies `INSTANTLY_WEBHOOK_SECRET`, resolves Instantly campaign UUID → our sub-campaign → company, then writes `reply_events`, `campaign_leads`, `unibox_emails`, `lead_events` |
| 9 | **Database triggers** | Automatic state recomputation (no external work) | Live DB: `lead_status_self` (BEFORE INSERT/UPDATE on `leads`), `org_sync_leads` (AFTER UPDATE on `organizations`), `provider_keys_delete_vault_secret` (AFTER DELETE), `*_set_updated_at` | `compute_lead_status()` derives `leads.status` from the lead's email + its org's stage. An org finishing enrichment **fans its new status out to every lead under it, inside the same transaction**. |
| 10 | **Local dev watchdog** | Same internal routes, on localhost | `scripts/watchdog.js` (`npm run watchdog`) | Stand-in for cron when running `npm run dev` |
| 11 | **Manual / operational scripts** | One-off maintenance | `scripts/register-webhook.mjs`, `create-admin-user.mjs`, `check-*.ts` | Run by a human, not by the system |

### 2.1 Every internal self-call in the repo (the complete relay map)

Found by grepping `after(` + `internalAppBaseUrl` across `app/`:

| Caller | Calls | Why |
|---|---|---|
| `api/v1/leads/apollo-search:395` | `/api/v1/leads/enrich` | hand Phase 1 → Phase 2A |
| `api/v1/leads/company-import:199` | `/api/v1/leads/enrich` | same handoff for Company Lookup |
| `api/v1/leads/enrich:249` | `/api/enrich/scrape-orgs` | reveal done → start scraping |
| `api/v1/leads/enrich:283` | `/api/v1/leads/enrich` | **self-chain**, next batch of the same import |
| `api/v1/leads/enrich:314` | `/api/v1/leads/enrich` | service-role only: walk on to the *next* import |
| `api/v1/leads/import-excel:273` | `/api/enrich/scrape-orgs` | Excel import → scraping |
| `api/v1/leads/route.ts:265` | `/api/enrich/scrape-orgs` | one manually-added lead → scraping |
| `api/v1/organizations/[id]/rescrape:61` | `/api/enrich/scrape-orgs` | manager button |
| `api/enrich/retry:53` and `retry-all:56` | `/api/enrich/scrape-orgs` | manager retry buttons |
| `api/enrich/scrape-orgs:781` | `/api/enrich/scrape-orgs` | **self-chain** |
| `api/v1/campaigns/[id]/generate-drafts:45` | `/api/enrich/generate-drafts` | user "Generate drafts" |
| `api/enrich/generate-drafts:173` | `/api/enrich/generate-drafts` | **self-chain** |
| `api/v1/campaigns/[id]/regenerate-drafts:107` | `/api/enrich/regenerate-drafts` | user bulk regenerate |
| `api/enrich/regenerate-drafts:141` | `/api/enrich/regenerate-drafts` | **self-chain** |
| `api/internal/auto-retry-failed-orgs:93` | `/api/enrich/scrape-orgs` | 3-hourly retry job |
| `lib/services/enrichment-watchdog.ts` | `scrape-orgs`, `regenerate-drafts`, `generate-drafts`, `leads/enrich` | the watchdogs |

---

## 3. WHAT HAPPENS AFTER AN API REQUEST?

### 3.1 The general lifecycle

```
User clicks
   ↓
lib/api-client.ts  →  getToken() reads the Supabase session in the browser
   ↓                  fetch("/api/v1/...", { Authorization: "Bearer <jwt>" })
Next.js middleware.ts
   ↓   (only for PAGE routes — the matcher excludes /api/, so API calls skip it)
Route handler starts
   ↓
requireAuth / requireManager / requireSuperAdmin        ← lib/auth/api-auth.ts
   • Bearer == SUPABASE_SERVICE_ROLE_KEY? → synthetic super-admin, companyId = null
   • otherwise verify JWT against Supabase JWKS (lib/auth/verify-jwt.ts)
   • then read role + is_active + company_id from `profiles` (NOT from the JWT claim,
     so a role change or deactivation takes effect immediately)
   ↓
zod validation                                          ← lib/validators/*
   ↓
dbForUser(user)                                         ← lib/supabase/scoped.ts
   • returns a Proxy around the service-role client
   • every .select/.update/.delete gets .eq("company_id", …) added automatically
   • every .insert/.upsert gets company_id stamped automatically
   ↓
scope assertions where relevant                         ← lib/auth/scope.ts
   (assertCampaignAccess, assertLeadAccess, assertDraftAccess, …)
   ↓
DB work  and/or  external API calls  (lib/http.ts fetchWithRetry)
   ↓
after(() => fetch(<internal worker route>))   ← if background work is needed
   ↓
ok(data) / fail(status, code, message)                  ← lib/api-response.ts
   { success, data, error }  — one envelope for every route
   ↓
Response returned to the browser
   ↓
after() callbacks now run — the platform keeps the function alive for them
```

### 3.2 A — work that happens DURING the user's request

Anything the user must see the result of, or anything cheap:

- `POST /api/v1/campaigns/[id]/send` (`maxDuration = 120`) — the entire Instantly fan-out runs inline: bucket leads by country/timezone, create or patch one Instantly sub-campaign per bucket, push leads in batches of 500 with a 2s gap, activate. The user waits.
- `POST /api/v1/leads/apollo-search` (`maxDuration = 300`) — pages through Apollo, inserts orgs + leads. The user waits for this too.
- `POST /api/v1/drafts/[id]/regenerate` (`maxDuration = 60`) — one LLM call, inline.
- All reads, all settings writes, all comment/reaction writes.

### 3.3 B — work that continues AFTER the response

Done with Next.js's `after()`. From `app/api/v1/campaigns/[id]/generate-drafts/route.ts:42`:

> `after()` keeps the serverless function alive until this kickoff actually leaves the machine — a plain un-awaited fetch can be dropped when the response returns and the lambda freezes.

That is the exact reason `after()` is used rather than a bare `void fetch(...)`: on a serverless platform the instance is frozen the moment the response is flushed, and a pending un-awaited fetch dies with it.

**Important nuance:** `after()` is *not* used to do the work. It is used only to **fire the starting gun**. The actual work happens in a *separate HTTP request* to a *separate function invocation*. This is what makes work survive past one function's time limit.

### 3.4 Concrete example from our code — "Generate drafts"

```
1. User clicks Generate on a campaign
2. POST /api/v1/campaigns/[id]/generate-drafts
      requireAuth → assertCampaignAccess
      UPDATE campaigns SET status='processing', draft_generation_started_at=now()
      after(() => POST /api/enrich/generate-drafts { campaign_id })  ← x-internal-secret
      return { queued: true, lead_count }          ← user's request is DONE, ~200ms
3. ── new invocation ─────────────────────────────────────────────
   POST /api/enrich/generate-drafts   (maxDuration = 55)
      rpc reset_stuck_draft_generation(stale_minutes: 5)
      hasUsableLlmKey(company)?  no → log DRAFT_LLM_UNAVAILABLE, stop
      fetchDraftTargets(campaign, limit 10)
      loop while (elapsed < 40_000 ms):  generateOneDraft(...)   ← ~6.4s each
      countPendingDrafts()
      remaining > 0  → after(() => POST /api/enrich/generate-drafts { same campaign })
      remaining == 0 → UPDATE campaigns SET status='draft'
4. Repeat step 3 until the campaign is done.
5. Meanwhile the browser polls /api/v1/campaigns/[id]/draft-progress every 3s
   (campaign-drawer.tsx:861) and the numbers move.
```

The 40-second budget (not a fixed count of 10) exists because of a real production failure documented at `app/api/enrich/generate-drafts/route.ts:18-32`: a draft takes ~6.4s, ten of them need ~64s, the 55s lambda was killed during the ninth **before reaching the self-chain code**, and every campaign over ~8 leads silently capped at 8 drafts.

---

## 4. DO WE HAVE A QUEUE?

**No queue technology. Postgres is the queue.**

Checked `package.json` — the dependency list contains **no** Redis, RabbitMQ, Kafka, BullMQ, Temporal, SQS, Inngest, Trigger.dev, QStash, or any other queue/job client. The full runtime dependency list is: Radix UI, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Tailwind, TipTap, `class-variance-authority`, `clsx`, `date-fns`, `jose`, `lucide-react`, `next`, `postcss`, `react`, `react-day-picker`, `recharts`, `sanitize-html`, `sonner`, `tailwind-merge`, `xlsx`, `zod`. Nothing else.

### 4.1 What makes a database row "a piece of work"?

A row is pending work when it matches the worker's WHERE clause. There is no `jobs` table for most of the system — the **business table itself** carries the state.

**Queue 1 — company scraping.** `organizations.enrichment_stage` is a Postgres enum: `queued | scraping | done | failed`.

```
Org A → queued    ← waiting, will be picked up
Org B → queued
Org C → scraping  ← claimed by a running invocation
Org D → done      ← finished
Org E → failed    ← finished badly
```

The worker's claim is `claim_queued_orgs(p_batch_size)`:
```sql
update organizations set enrichment_stage='scraping', enrichment_started_at=now()
where id in (
  select id from organizations
  where enrichment_stage='queued' and domain is not null and domain <> ''
  order by created_at asc limit p_batch_size
  for update skip locked
) returning *;
```

**Queue 2 — Apollo email reveal.** There is no status column here; the queue is defined by a *predicate*:
`lead_source='apollo' AND has_email=true AND email IS NULL AND is_deleted=false AND enrich_attempts < 2`.
"Apollo said this person has an email, and we haven't got it yet." The claim is a dedicated lock column, `leads.enrich_locked_at`, via `claim_unenriched_leads(p_ids)` — a timestamp that **self-expires after 10 minutes**, so no separate stuck-lead watchdog is needed. The migration explains why `status` could not be reused as the lock column: the `lead_status_self` trigger recomputes `NEW.status` on every update and would immediately overwrite any lock marker.

**Queue 3 — initial draft generation.** Pending = a `campaign_leads` row with no usable draft yet, minus leads whose `email_drafts` rows show 3+ non-outage failures for that step. Selection is `fetchDraftTargets()` in `lib/services/generate-drafts.ts:683`. The in-flight marker is `email_drafts.status = 'generating'`.

**Queue 4 — bulk draft regeneration.** This one **does** have real job tables, because progress had to be reportable, resumable and cancellable:
- `draft_regeneration_jobs` — `queued | running | completed | cancelled | failed`, plus `total/succeeded/failed`, `heartbeat_at`.
- `draft_regeneration_job_items` — one row per lead, `pending | running | done | failed | skipped`.

**Queue 5 — Instantly inbox sync.** A cursor, not a queue: `system_state.unibox_sync_state`.

### 4.2 How does the system know which rows still need work?

A `COUNT(*)` with the same predicate, run at the end of every batch. Examples:

- `scrape-orgs/route.ts:773` — `count organizations where enrichment_stage='queued'`
- `generate-drafts/route.ts:157` — `countPendingDrafts(campaign)`
- `regenerate-drafts/route.ts:134` — `countPendingItems(job)`
- `leads/enrich/route.ts:276` — `count leads where import_id=… and email is null`

`count > 0` → chain again. `count == 0` → mark finished.

---

## 5. WHAT IS OUR WORKER?

**Next.js API routes are the workers.** No permanent processes, no server instances, no daemons, no container. Each "worker run" is one serverless function invocation with a hard wall-clock limit declared in the file (`export const maxDuration`).

```
User click  /  pg_cron  /  Vercel Cron  /  GitHub Action  /  previous batch
                            │
                            ▼
              POST /api/enrich/<worker>      (x-internal-secret)
                            │
                            ├─ 1. AUTHENTICATE   safeSecretEqual(header, INTERNAL_SECRET)
                            │                    — constant-time compare, lib/auth/secret.ts
                            ├─ 2. SELF-HEAL      reset stuck rows from a previous dead run
                            ├─ 3. PRE-FLIGHT     do we have credits / a usable key?
                            │                    if no → log + return WITHOUT touching any row
                            ├─ 4. CLAIM          RPC with FOR UPDATE SKIP LOCKED
                            │                    (rows flip to an "in progress" state)
                            ├─ 5. PROCESS        external API calls, within a time budget
                            ├─ 6. WRITE          results + advance state + write log rows
                            ├─ 7. COUNT          how much is left?
                            └─ 8. CHAIN          after(() => fetch(this same route))
                                                 or mark the job complete
```

### 5.1 The actual worker routes

| Route | maxDuration | Batch size | Auth |
|---|---|---|---|
| `/api/enrich/scrape-orgs` | 300 | up to 15 orgs, processed **concurrently** via `Promise.allSettled`; clamped down to the real remaining Firecrawl balance | `x-internal-secret` only |
| `/api/enrich/generate-drafts` | 55 | fetch 10 targets, stop starting new ones after a **40s time budget**; sequential | `x-internal-secret` only |
| `/api/enrich/regenerate-drafts` | 55 | 5 items, sequential | `x-internal-secret` only |
| `/api/v1/leads/enrich` | 300 | 50 leads per pass, 10 per Apollo `bulk_match` call | JWT manager **or** service-role bearer |
| `/api/v1/unibox/sync` | 55 | 8 pages per pass | `x-internal-secret` or any JWT |

Note the asymmetry: `/api/v1/leads/enrich` is both a user-facing route (a manager clicking "Enrich") and a background worker (the daily resume job calling it as the service role). The route branches on `user.companyId === null` to tell the two apart — that is how it knows whether it is allowed to walk on to the *next* import after finishing this one.

### 5.2 Two authentication models for "internal"

1. **Shared secret** — `x-internal-secret: $INTERNAL_SECRET`, compared with `timingSafeEqual` (`lib/auth/secret.ts`). Used by the `api/enrich/*` and `api/internal/*` family.
2. **Service-role bearer** — `Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY`. `requireAuth` short-circuits on this and returns a synthetic user: `id = SERVICE_ROLE_USER_ID` (all-zeros UUID), `role: manager`, `isSuperAdmin: true`, **`companyId: null`**. That null is load-bearing: it makes `dbForUser()` return the *unscoped* admin client, which is exactly what a cross-company relay needs — and exactly why several services carry `company_id` explicitly through their arguments.

Cron entry points also accept a third form: `Authorization: Bearer $CRON_SECRET` on the GET handler, for Vercel Cron.

---

## 6. HOW DOES THE SYSTEM CONTINUE AFTER ONE BATCH?

**100 records, 50 processed. Then what?**

### 6.1 Who knows the other 50 remain, and how?

Nobody remembers. **Nothing is held in memory.** At the end of every batch the worker asks the database a fresh COUNT with the same "is this pending?" predicate it used to select the batch. The database is the only memory.

This is why the design is robust to the process dying: there is no in-memory cursor to lose.

### 6.2 Who triggers the next batch?

**The same route triggers itself**, over HTTP, from inside `after()`:

```ts
// app/api/enrich/generate-drafts/route.ts:168
if (remaining > 0 || ranOutOfTime) {
  after(async () => {
    await fetch(`${baseUrl}/api/enrich/generate-drafts`, {
      method: "POST",
      headers: { "x-internal-secret": secret },
      body: JSON.stringify({ campaign_id: campaignId, step_number: stepNumber }),
    }).catch(() => {});
  });
}
```

So: same route, new HTTP request, **new function invocation with a fresh time budget**. Not `after()` doing the work; `after()` only guarantees the outbound request escapes before the function freezes.

### 6.3 Does the user have to do anything?

No. The user's request returned long ago. They can close the tab. The chain continues server-side. The only thing the browser does is poll to *watch*.

### 6.4 What if the next trigger fails?

This is the single most important failure mode in this architecture, and the code treats it as a certainty, not a possibility.

`.catch(() => {})` on every self-chain call means a failed handoff is **silent**. If the fetch is dropped, or the receiving invocation dies before it does anything, or a redeploy kills the instance mid-`after()`, the chain simply stops. Rows stay in `scraping` / `generating` / `running` forever with nothing coming to move them.

The answer is the **watchdog layer** — a second, independent trigger source that does not depend on the chain being alive:

```
pg_cron (in the database, always awake, not affected by our lambdas)
   every 10 min → POST /api/internal/enrichment-watchdog
                     → runEnrichmentWatchdog(baseUrl, db)
                          ├─ triggerScrapeWatchdog        nudge scrape-orgs unconditionally
                          ├─ triggerRegenerationWatchdog  find jobs with a stale heartbeat_at
                          └─ triggerDraftGenerationWatchdog  find campaigns with no recent draft
   daily 04:10  → POST /api/internal/resume-apollo-reveal
                     → triggerEnrichWatchdog   (the ONLY paid recovery job)
```

Liveness is measured by **evidence of recent output**, not by a status column. From `lib/services/enrichment-watchdog.ts`:

> Liveness is measured by the most recent draft row, not `campaigns.updated_at`, which only moves on a status flip — a healthy run writes a draft every ~6s and so is never mistaken for stalled, while a dead one is picked up on the next pass. That matters: kicking a campaign that is still running would hand two workers the same targets and duplicate drafts.

Three separate staleness signals are in use:
- **drafts**: newest `email_drafts.created_at` for the campaign older than 5 minutes
- **regeneration jobs**: `draft_regeneration_jobs.heartbeat_at` older than 5 minutes (bumped at the end of every batch)
- **orgs**: `enrichment_started_at` older than 10 minutes while still `stage='scraping'`

---

## 7. DATABASE'S ROLE IN THE SYSTEM

The database is doing **eight jobs at once**, not one:

1. **Application data** — leads, orgs, campaigns, drafts, emails.
2. **The work queue** — pending rows identified by predicate.
3. **Job state** — job/item status, counters, heartbeats.
4. **Processing state** — `scraping`, `generating`, `running`.
5. **Failure state** — attempt counters, `last_error`, permanent-failure statuses.
6. **Completion state** — `done`, `completed`, `enrichment_done_at`.
7. **Locking/claiming** — `FOR UPDATE SKIP LOCKED` inside RPCs; `enrich_locked_at`; unique partial indexes.
8. **Credit / spend tracking** — `enrichment_logs` rows with `payload.credits_consumed`, plus cached balances in `system_state`.
9. **Secret storage** — Supabase Vault holds provider API keys and the cron's `internal_secret` + `app_base_url`.
10. **Scheduling** — `pg_cron` + `pg_net` make the database itself a scheduler and an HTTP client.

### 7.1 Tables that matter for background processing

| TABLE | WHAT IT STORES | WHY THE SYSTEM NEEDS IT |
|---|---|---|
| `organizations` (4,379 rows) | Company + `enrichment_stage` (enum `queued/scraping/done/failed`), `enrichment_status` (free-text detail like `SCRAPE_STARTED`, `ENRICHMENT_FAILED_PERMANENT`), `enrichment_attempts`, `domain`, `scraped_markdown` + `scraped_at` (7-day cache), `has_scraped`, `last_error` | **This is the scraping queue.** `enrichment_stage` is simultaneously the queue, the lock, and the completion record. `scraped_markdown` exists so an LLM-only retry doesn't re-pay Firecrawl for the same page. |
| `leads` (4,849 rows) | Person + `status` (enum `new/enriching/enriched/input_required/open/closed`), `has_email`, `email`, `enrich_attempts`, `enrich_locked_at`, `assigned_to`, `import_id`, `is_deleted`, `company_id` | **The Apollo reveal queue** (predicate on `has_email`/`email`/`enrich_attempts`) plus the reveal lock (`enrich_locked_at`). `status` is *derived*, not written by hand — see §8. |
| `imports` (29 rows) | One row per import batch: `lead_count`, `assignment_strategy`, `assignment_target` | The **batch identity** that the reveal chain walks. Also holds the deferred assignment decision — assignment is applied later, when a lead becomes workable, not at import time. |
| `campaigns` (62 rows) | Campaign + `status` (`draft/processing/...`), `draft_generation_started_at`, denormalised counters (`sent_count`, `replied_count`, `bounced_count`, `hot_count`, `cold_count`, `total_leads`) | `draft_generation_started_at` is the **durable signal** the draft watchdog scans on, precisely because `status` gets reset by the self-heal RPC. The counters drift and are rebuilt nightly by `reconcile-counters`. |
| `campaign_leads` (1,292 rows) | Membership of a lead in a campaign + `crm_status`, `draft_id`, `first_sent_at`, `last_reply_at`, `lead_temperature` | The unit of draft work and the join target for every Instantly webhook. `first_sent_at` (not `instantly_lead_id`) is ground truth for "sent". |
| `email_drafts` (3,407 rows) | Generated emails + `status` (`generating/…/failed`), `step_number`, `rejection_reason` | `status='generating'` is the **in-flight marker**; 3 non-outage `failed` rows for a lead+step is the per-lead retry cap. `rejection_reason` starting with `PROVIDER_UNAVAILABLE` marks a failure as *forgiven* so an outage doesn't burn a lead's retries. |
| `draft_regeneration_jobs` (47) | `status`, `total/succeeded/failed`, `heartbeat_at`, `created_at`, `finished_at` | The only **explicit job table**. `heartbeat_at` is the liveness signal; `uq_draft_regen_active_job` (unique partial index on `campaign_id, step_number` where status in queued/running) is what prevents two concurrent runs on one campaign. |
| `draft_regeneration_job_items` (2,373) | Per-lead `pending/running/done/failed/skipped` + `error` | Exact progress and exact resume point. Items left `running` by a dead batch are reset to `pending` by the watchdog. |
| `enrichment_logs` (44,179) | Technical event trail: `source` (system/apollo/firecrawl/llm/email_fallback), `event`, `error`, `payload`, `duration_ms`, `company_id` | Three jobs at once: debugging, the **credit ledger** (`payload.credits_consumed` summed by Settings → Keys → Usage), and the **service-health banner** (last 6 hours, newest row per provider wins). |
| `lead_events` (11,906) | Human-readable per-lead timeline: `created`, `enriched`, `assigned`, `email_delivered`, `reply_received`, … | Deliberately separate from `enrichment_logs`, which is full of raw HTTP 402 dumps not fit for a UI. |
| `unenrichable_leads` (9) | Archive of leads Apollo could not resolve, with `reason` | A flat table with **no foreign keys into the working schema**, so an archived person can never re-enter the reveal queue and be charged again. |
| `system_state` (10) | `unibox_sync_state` cursor, `credit_check_*` cached balances | **Deliberately has no `company_id`** — both tenants share one Instantly workspace and one set of provider keys, so these are genuinely global. It is one of only two tables the scoping proxy passes through untouched (the other is `companies`). |
| `provider_keys` (11), `provider_settings`, `llm_tier_config` | API keys (secret in Vault, only the vault id here), health flags, primary/fallback tier order | Providers are **DB-first, not env-first**. Workers resolve keys, models and tier order at call time, so a key rotation needs no redeploy. |
| `assignment_cursors` (4) | Round-robin position per `(company_id, lane)` | Fair lead distribution that survives restarts. |
| `companies` (2) | Tenant root | Every scoped query filters on it. |
| `audit_log` (158) | Cross-cutting audit rows | e.g. `org_enrichment_shared` when one org's enrichment changes leads belonging to several employees. |

---

## 8. HOW DOES THE SYSTEM KNOW WHAT TO DO NEXT?

### 8.1 The state machines actually in the code

```
ORGANISATION (enrichment_stage, a Postgres enum)
   queued ──claim_queued_orgs──► scraping ──success──► done
      ▲                              │
      │                              └──failure──► failed  (or back to queued if
      │                                                     retryable + attempts < 3)
      └── auto-retry-failed-orgs (3-hourly) requeues stale failures, up to 3 lifetime attempts

LEAD (status, a Postgres enum — DERIVED, never hand-written)
   enriching  (org still queued/scraping, no email yet)
   new        (org still queued/scraping, email exists)
   enriched   (email + org domain + org description all present)
   input_required (email missing, or org failed, or no domain, or no description)
   open / closed  (terminal, set by humans/webhooks — compute_lead_status refuses to
                   override these)

EMAIL DRAFT (status)
   generating ──► (generated) ──► ... ──► failed
   'generating' older than 5 min → flipped to 'failed' by reset_stuck_draft_generation
   3 non-outage 'failed' rows for a lead+step → that lead is excluded from selection

REGENERATION JOB
   queued ──► running ──► completed
                 │  └──► cancelled (user)
                 └──► failed (watchdog, after 24h of stalling)

CAMPAIGN
   draft ⇄ processing   (step-1 draft generation only; follow-up steps never touch it)
```

### 8.2 Who changes the state?

Three different actors, and it matters which:

1. **The worker**, explicitly — `claim_queued_orgs` writes `scraping`; `processOneOrg` writes `done`; `markFailed` writes `failed`.
2. **A database trigger**, automatically — `leads.status` is *never* set by hand for the pipeline states. `trg_lead_status_self` (BEFORE INSERT/UPDATE on `leads`) recomputes it from `compute_lead_status(status, email, org.domain, org.enrichment_stage, org.company_description)`. And `trg_org_sync_leads` (AFTER UPDATE on `organizations`) fans a stage/domain/description change out to **every non-deleted, non-terminal lead under that org in the same transaction**. This is why finishing one company's scrape instantly flips all its leads to `enriched` with no application code doing a loop.
3. **A watchdog**, correctively — `reset_stuck_draft_generation` demotes stale `generating` drafts to `failed` and releases campaigns from `processing`; the regeneration watchdog resets `running` items back to `pending`.

### 8.3 Why the state matters, and how the next process uses it

State is the **only** handoff mechanism between invocations. Invocation N does not tell invocation N+1 anything; it just leaves rows in a state, and N+1 runs a query. That is what makes the system restartable at any point: any invocation can die at any moment and the next one re-derives everything from the rows.

The one thing this costs is that a state must be *unambiguous*. There are two live examples of that being carefully handled:

- The draft watchdog **cannot** filter on `status='processing'`, because `reset_stuck_draft_generation` (which it calls first) has already flipped exactly those campaigns to `'draft'`. It filters on `draft_generation_started_at IS NOT NULL` instead — "generation was asked for, whatever the status has since become".
- `claim_queued_orgs` was amended (`2026_07_30`) to require `domain IS NOT NULL`, because Apollo Phase 1 inserts domainless org shells as `queued` and the scraper was claiming and instantly failing them, racing the reveal stage that would have supplied the domain.

### 8.4 What happens when something fails?

Failure is itself a state, with an attempt counter attached:

- `organizations.enrichment_attempts` — capped at 3 lifetime attempts; on reaching it the org is parked at `ENRICHMENT_FAILED_PERMANENT` and excluded from every future auto-retry. A human "Retry all" resets the counter — that is the deliberate manual escape hatch.
- `leads.enrich_attempts` — capped at **2** (`MAX_ENRICH_ATTEMPTS`), enforced *in the candidate SELECT*, not in the cleanup path, so it holds even if the archive write fails.
- `email_drafts` — 3 non-outage failures per lead+step.
- `draft_regeneration_jobs` — 24 hours of stalling → the job is failed and its items are failed, which also **releases the unique active-job index** so a human can start a fresh run.

Retryable vs. permanent is an explicit decision, not a default. `scrape-orgs` defines `RETRYABLE_STATUSES = { SCRAPE_FAILED, LLM_EXTRACTION_FAILED }` — plausibly transient. `NO_DOMAIN` and `NO_EMAILED_LEADS` are permanent: retrying changes nothing because there is no new data for a fresh attempt to find.

---

## 9. CONCURRENCY — VERY HIGH LEVEL

**Can multiple users trigger work at the same time?** Yes. Nothing serialises users.

**Can multiple API executions happen at the same time?** Yes, routinely, and not only from users. On a serverless platform each request is its own invocation, and this system makes *itself* concurrent in at least four ways:

1. a user clicks while a chain is already running;
2. pg_cron fires a watchdog while a chain is running;
3. two watchdogs (the 10-minute one and the daily one, plus `reconcile-counters` which also calls `runEnrichmentWatchdog`) overlap;
4. `scrape-orgs` processes up to 15 orgs **in parallel inside one invocation** via `Promise.allSettled`.

**What shared resource do they contend for?** The pending rows in Postgres — and, behind them, real money: Apollo credits, Firecrawl credits, LLM tokens. Two invocations picking the same row is not just a data race, it is a double charge.

**How does the database coordinate them?**

- **`FOR UPDATE SKIP LOCKED` inside claim RPCs.** `claim_queued_orgs` and `claim_unenriched_leads` both do select-and-update in a single statement with `SKIP LOCKED`, so concurrent callers get **disjoint** batches — the loser silently gets a smaller set rather than a duplicate. The `claim_queued_orgs` migration states the exact bug this replaced: "a prior select-then-update let two concurrent invocations both pick up the same org before either marked it `scraping`, causing duplicate Firecrawl/LLM spend."
- **`FOR UPDATE` on a cursor row.** `assignment_pick_round_robin` locks the `assignment_cursors` row for its `(company_id, lane)` so two imports can't both hand the next lead to the same employee.
- **Unique partial indexes.** `uq_draft_regen_active_job` makes "at most one live regeneration job per campaign+step" a database guarantee; the route catches the `23505` and returns a 409 instead of a 500.
- **A self-expiring lock column.** `leads.enrich_locked_at` — anything older than 10 minutes is considered abandoned and re-claimable.
- **Idempotency keys.** The Instantly webhook computes a SHA-256 `event_uid` and upserts with `ignoreDuplicates`, then keys the activity-log write on whether a row was *actually* inserted — so a redelivered webhook does not add a second "Reply received" line.
- **Deliberate single-flight at the application level.** The daily Apollo resume job kicks **one import per pass, not five in parallel**, because concurrent `bulk_match` streams rate-limit each other and Apollo bills a 429-rejected request the same as a served one.

We will look at the exact ordering and race windows when we study each pipeline.

---

## 10. CRON / WATCHDOG / RECOVERY

Verified against the live database (`select * from cron.job`) and the repo. There are **three separate schedulers**, which is itself an important fact about this system.

### 10.1 Supabase pg_cron — 5 jobs, all `active = true` (the real schedule)

| JOB | HOW TRIGGERED | HOW OFTEN | WHAT IT GENERALLY DOES |
|---|---|---|---|
| `enrichment-watchdog` | pg_cron → `ping_internal_route('/api/internal/enrichment-watchdog')` → pg_net HTTPS POST | `*/10 * * * *` (every 10 min) | Nudges scraping; revives stalled bulk-regeneration jobs; revives stalled initial draft generation. **Free by design** — nothing behind it can spend an Apollo credit. |
| `unibox-sync` | pg_cron → `ping_internal_route('/api/v1/unibox/sync', 60000)` | `*/15 * * * *` | Reconciliation sweep over the shared Instantly mailbox. The webhook is the real delivery path; this catches what it drops. |
| `resume-apollo-reveal` | pg_cron → `ping_internal_route('/api/internal/resume-apollo-reveal', 60000)` | `10 4 * * *` (04:10 UTC daily) | Resumes email-reveal for **one** import whose self-chain died. **The only scheduled job in the app that can spend money.** |
| `write-followups` | pg_cron → `ping_internal_route('/api/internal/write-followups', 60000)` | `0 2 * * *` (02:00 UTC = 07:30 IST daily) | Writes the personalised follow-ups falling due within a day and pushes each to Instantly. Idempotent, self-healing, and also nudged every 10 min by `enrichment-watchdog`. Costs **no LLM tokens and no Apollo credits** on a pass with nothing due. See §14. |
| `purge-cron-history` | pg_cron, pure SQL | `20 3 * * *` | `delete from cron.job_run_details where end_time < now() - interval '7 days'` |

`ping_internal_route(path, timeout_ms)` is `SECURITY DEFINER`, reads `internal_secret` and `app_base_url` out of Supabase Vault at call time (so the secret is never in `cron.job`'s plaintext command), and has `EXECUTE` **revoked** from `public`, `anon`, `authenticated` and `service_role` — only the cron owner can run it.

### 10.2 Vercel Cron — 1 job

| JOB | HOW TRIGGERED | HOW OFTEN | WHAT IT GENERALLY DOES |
|---|---|---|---|
| `reconcile-counters` | `vercel.json` → GET with `Authorization: Bearer $CRON_SECRET` | `30 2 * * *` (daily) | Recomputes every campaign's denormalised counters from `campaign_leads` ground truth, then **also** runs `runEnrichmentWatchdog` |

### 10.3 GitHub Actions — 1 scheduled, 2 manual-only

| JOB | HOW TRIGGERED | HOW OFTEN | WHAT IT GENERALLY DOES |
|---|---|---|---|
| `retry-failed-orgs` | `schedule` + manual | `0 */3 * * *` (every 3h) | Requeues orgs that failed 3h+ ago, excluding `NO_DOMAIN`/`NO_EMAILED_LEADS`, respecting a 3-attempt lifetime cap, and only if the org still has a lead worth contacting |
| `watchdog.yml` | `workflow_dispatch` **only** | manual | Same endpoint as pg_cron's `enrichment-watchdog`. Schedule removed 2026-07-23. |
| `unibox-sync.yml` | `workflow_dispatch` **only** | manual | Same endpoint as pg_cron's `unibox-sync`. Schedule removed 2026-07-23. |

The migration records exactly why the schedules moved: measured on 2026-07-23, GitHub delivered the `*/15` watchdog as 10 runs with 67–212 minute gaps (~14% of the intended rate), and had run the `*/5`→`*/15` unibox sync **exactly zero times**. For jobs whose entire value is a bounded worst case, an unbounded scheduler makes them pointless.

### 10.4 In-worker recovery (not scheduled, runs at the top of a batch)

| MECHANISM | WHERE | WHAT IT DOES |
|---|---|---|
| Stuck-`scraping` reset | `scrape-orgs/route.ts:626` | Orgs in `scraping` with `enrichment_started_at` older than 10 min → back to `queued` (counts as an attempt) or `failed` at the cap |
| Never-ran sweep | `scrape-orgs/route.ts:646` | Orgs sitting in `queued` for 24h+ → `ENRICHMENT_NEVER_RAN`, so their leads leave "New" and become Input Required |
| Draft self-heal | `generate-drafts/route.ts:49` and the watchdog | `reset_stuck_draft_generation(5)` — stale `generating` drafts → `failed`; campaigns stuck in `processing` with nothing in flight → `draft` |
| Reveal lock expiry | `claim_unenriched_leads` | `enrich_locked_at` older than 10 min is re-claimable — no separate watchdog needed |
| Job expiry | `enrichment-watchdog.ts` `REGEN_EXPIRE_HOURS = 24` | A regeneration job stalling 24h is failed outright so it stops burning kicks and releases the unique active-job index |

### 10.5 Local development

`npm run watchdog` (`scripts/watchdog.js`) is a local stand-in for cron, hard-coded to `http://localhost:3000`, reading `INTERNAL_SECRET` from `.env.local`.

---

## 11. FAILURE AT ARCHITECTURE LEVEL

| WHAT FAILS | WHAT GENERALLY HAPPENS |
|---|---|
| **A user-facing API call fails** | `fail(status, code, message, details)` returns the standard envelope. `lib/api-client.ts`'s `describeApiError` folds zod field errors into the message so the UI shows something actionable. Nothing is left half-done that a background job cares about. |
| **An external API fails** | Depends on the provider, and the difference is about **billing**. `lib/http.ts` sets per-service retry schedules: Firecrawl and LLM get `[1s, 3s, 9s]`; **Apollo gets `[]` — exactly one attempt, ever.** The comment records why: on 2026-07-14, 1,403 people were asked for and Apollo charged 3,222 credits (2.30×) because the helper retried every rate-limited attempt and Apollo bills on *receipt*, not delivery. Timeouts are 30s/60s/90s (apollo/firecrawl/llm). |
| **An LLM provider fails** | `lib/services/llm.ts:complete()` walks the configured tier order; within a provider it rotates through every configured key (`getActiveKey` with an exclude set), marking each failure on `provider_keys`. Only when every tier is exhausted does it throw. |
| **All LLM providers are out of credit** | Workers **pre-flight** and refuse to start: `hasUsableLlmKey()` before `fetchDraftTargets()`, so no lead is claimed and nothing needs forgiving. A `DRAFT_LLM_UNAVAILABLE` row is written, which lights the red service-health banner. The route deliberately **does not self-chain** in this case — it would spin. The 10-minute watchdog owns resuming once a key works. |
| **Apollo is out of credits** | `/api/v1/leads/enrich` pre-flights `checkApolloCredits` **before claiming**, trims the candidate list to `credits.remaining`, logs `CREDITS_EXHAUSTED` attributed to the right company, and returns without spending. It does **not** chain. |
| **The database fails** | Supabase errors surface as `{ error }` on the query result. Most routes return `fail(500, "INTERNAL", …)`. Log/telemetry writes are frequently wrapped so a logging failure cannot take down real work (`.catch(() => {})`, `try { … } catch { /* non-fatal */ }`). Rows simply stay in their current state and the watchdog re-derives from them later. |
| **A worker crashes mid-batch** | Rows sit in an in-progress state (`scraping`, `generating`, `running`, or with `enrich_locked_at` set). A staleness threshold makes them reclaimable: 10 min for orgs and reveal locks, 5 min for drafts and regeneration heartbeats. |
| **The Vercel execution limit is hit** | This is treated as **normal**, not exceptional. Batch sizes are chosen so a batch finishes well inside the limit (50 reveal leads targeting 20–35s inside a nominal 300s; a 40s draft budget inside 55s; 5 regeneration items inside 55s). If time runs out anyway, the row states left behind are exactly what the watchdog looks for. |
| **A background trigger fails** | Silent — every self-chain fetch ends in `.catch(() => {})`. This is precisely the gap the pg_cron watchdogs exist to close: bounded worst case of ~10 minutes for the free pipelines, ~24 hours for the paid Apollo reveal. |
| **A redeploy happens mid-chain** | Same as a crash. The chain is lost; the rows survive; the watchdog restarts it. |
| **Instantly re-delivers a webhook** | `event_uid` SHA-256 idempotency key + `ignoreDuplicates`; counters only move when the underlying value actually changes. |

### 11.1 The recurring principle behind all of it

> **Never let an automatic retry loop touch a paid endpoint.**

Every one of the following exists because of a real, measured overspend:
- Apollo has zero HTTP retries.
- Apollo reveal is capped at 2 lifetime attempts per person, enforced in the SELECT.
- The paid resume job was split out of the 10-minute watchdog onto its own daily schedule — riding along gave any defect 96 chances a day to become a charge, which is how one unresolvable lead cost ~420 credits between 15 and 26 July 2026.
- The reveal route does **not** chain after *any* failure (not just credits/429), because Apollo bills on receipt, so a 5xx or a timeout is still a paid attempt.
- The scrape worker caches `scraped_markdown` for 7 days so an LLM-only retry doesn't re-pay Firecrawl for the identical page.
- `auto-retry-failed-orgs` stopped resetting `enrichment_attempts`, because doing so resurrected permanently-failed orgs every 3h forever (35 orgs were in that loop on 2026-07-23).

---

## 12. ONE COMPLETE EXAMPLE

**A manager imports leads from an Excel file.** Real components, real route names, no pipeline internals.

```
1. USER ACTION
   Manager on /leads/add uploads an .xlsx. The BROWSER parses it (the `xlsx`
   package is a client dependency), maps columns, clicks Import.

2. API ROUTE
   POST /api/v1/leads/import-excel        (maxDuration = 300)
      requireManager(req)                 ← JWT verified, role read from `profiles`
      ExcelImportSchema.safeParse(body)   ← zod
      db = dbForUser(user)                ← company-scoped proxy client

3. DB — WORK IS CREATED
      INSERT into `imports`   → one batch row, carrying the deferred
                                assignment choice (assignment_strategy / target)
      INSERT into `organizations` → new companies land with
                                    enrichment_stage = 'queued'      ← QUEUE ROW
      INSERT into `leads`     (chunked) → the BEFORE trigger
                                trg_lead_status_self computes each lead's
                                status from compute_lead_status(...)
      INSERT into `lead_events` → "Imported from Excel/CSV"
      Leads land UNASSIGNED on purpose — assignment happens later, once a lead
      is actually workable.

4. RESPONSE + HANDOFF
      after(() => POST /api/enrich/scrape-orgs, x-internal-secret)   ← triggerScrape()
      return ok({ inserted, skipped_… })      ← the user's request ENDS here

5. WORKER — BATCH 1
   POST /api/enrich/scrape-orgs             (maxDuration = 300, secret-only)
      a. CREDIT GATE   checkFirecrawlCredits + every configured LLM tier.
                       Firecrawl down → skip the whole batch untouched,
                       claim nothing, mark nothing failed.
      b. SELF-HEAL     reset orgs stuck 'scraping' > 10 min;
                       conclude orgs stuck 'queued' > 24h.
      c. PRE-CLAIM     resolveDomainlessQueuedOrgs(40) — give websiteless
                       companies a domain from their own leads' email domains
                       (DB-only, costs nothing).
      d. CLAIM         rpc claim_queued_orgs(batchSize)
                       → UPDATE … WHERE stage='queued' AND domain IS NOT NULL
                         … FOR UPDATE SKIP LOCKED
                       → rows flip 'queued' → 'scraping'      ← THE CLAIM
                       batchSize = min(15, firecrawl.remaining)
      e. PROCESS       Promise.allSettled over the claimed orgs, each through
                       createScopedClient(org.company_id):
                         Firecrawl scrape (or reuse cache < 7 days old)
                         → LLM extraction → company_description + sells_to

6. DB — STATE UPDATE
      UPDATE organizations SET enrichment_stage='done',
             enrichment_status='ENRICHMENT_COMPLETE', has_scraped=true
      → the AFTER trigger trg_org_sync_leads fires and recomputes
        `status` for EVERY lead under that org, in the same transaction
      UPDATE leads SET status='enriched'
      INSERT lead_events  ("Company profile ready")
      autoAssignEnrichedLeads(org)  → assignment_pick_round_robin (FOR UPDATE)
                                      now the leads get an owner
      INSERT enrichment_logs (SCRAPE_SUCCESS, LLM_EXTRACTION_SUCCESS, …)

7. NEXT BATCH TRIGGER
      SELECT count(*) FROM organizations WHERE enrichment_stage='queued'
      count > 0 → after(() => POST /api/enrich/scrape-orgs)   ← SELF-CHAIN
      count = 0 → log BATCH_COMPLETE, return

8. COMPLETION, AS SEEN BY A HUMAN
      The Leads page polls every 30 seconds (leads/page.tsx:777) and rows move
      from Enriching → New → Enriched on their own. The manager did nothing
      after step 1.

9. IF THE CHAIN DIED ANYWHERE IN 5-7
      Nothing is lost: the orgs are still 'queued' (or 'scraping' with an old
      enrichment_started_at). Within 10 minutes pg_cron POSTs
      /api/internal/enrichment-watchdog → triggerScrapeWatchdog → the same
      worker route → step 5 again, self-healing the stuck rows on the way in.
```

---

---

## 13. NOT COVERED HERE (deliberately)

Apollo search, Apollo email reveal, Firecrawl scraping + LLM extraction, initial draft generation, bulk regeneration, Company Lookup, campaign fan-out to Instantly, reply drafting, and Unibox sync all have their own internal rules. Those are the one-by-one studies.

---

## 14. PERSONALISED FOLLOW-UPS (steps 2 and 3)

Built 25 August 2026. This section is deliberately complete: the feature spans a
prompt, a scheduler, a worker, a cron job, a watchdog hook and a UI surface, and
none of those pieces makes sense read alone.

### 14.1 The problem it replaces

Before this, every prospect on earth received the same follow-up:

> "Just following up on my previous note, would love your thoughts."

Two places in the code produced that, and neither was a bug in the ordinary sense:

| Where | What it did |
|---|---|
| `lib/services/followup-regenerate.ts` | Its own header states the intent: *"no lead/org data, no Kuber context, no product library, no shared base system prompt."* It rewrites existing text and is told nothing about the customer. |
| `lib/services/campaign-fanout.ts` | When a follow-up was never written, it seeds `customBody2` with a fixed sentence so Instantly does not render an empty email. That fallback is what most prospects actually received. |

**Instantly was never the constraint.** Verified in the live workspace, our sequence
steps are:

```
step 1  →  subject "{{customSubject}}"  body "{{customBody}}"
step 2  →  subject ""                   body "{{customBody2}}"
step 3  →  subject ""                   body "{{customBody3}}"
```

The **entire body is one per-lead variable**. Nothing about the follow-up is a
shared template — Instantly was faithfully delivering exactly what we handed it.

### 14.2 BACKEND — how a follow-up is written

#### The prompt

`lib/services/settings.ts` → `FOLLOWUP_CONTRACT`, selected by
`resolveDraftSystemPrompt(db, ownerId, stepNumber)` whenever `stepNumber > 1`.

**A follow-up never uses the user's `draft_template`.** This is the single most
important rule in the feature. A template is a full opening pitch; reproducing it
as step 2 produces a second cold email. Measured before the fix existed: a step-2
draft came back at **1,430 characters** carrying the whole offerings block, the
18,000 MT figure, the client counts, the awards and the partner list. After the
fix, the same leads produced **233–370 characters**.

The contract enforces two requirements that pull against each other, and both are
mandatory:

| Requirement | Why it is in the prompt explicitly |
|---|---|
| **Two to four sentences** | Client instruction, 21 Aug 2026: *"Follow-up message should be very small. Follow to the point."* |
| **Names THEIR business concretely** | Otherwise the model writes about *our* products and the email fits any company on earth. The prompt names the failure mode and bans the filler phrasings ("your sourcing needs", "your requirements") that the first version produced. |

It also bans, by name: re-introducing Kuber, the product range, the capacity
figures, client counts, awards, partner names, bullet points, and any subject
line. `NON_NEGOTIABLE_RULES` still applies on top, so a follow-up cannot invent a
price or a certification either.

#### The signature

`generate-drafts.ts` sets `signatureForStep = stepNumber > 1 ? "" : signatureBlock`.

A follow-up threads as a reply, so the signature is already visible in the message
directly above it. Repeating it read as a bot and padded a deliberately short
nudge — measured, a 235-character follow-up carried a 90-character signature.
Step 1 keeps its signature.

#### The generator

`generateOneDraft()` needed no new branch. It already accepted `stepNumber`,
already cleared the subject for `stepNumber > 1` (so Instantly threads it), and
`fetchDraftTargets()` already filtered by `step_number`. The feature was mostly
absent rather than impossible.

### 14.3 SCHEDULING — when a follow-up is written

`lib/services/followup-schedule.ts`

**The whole design turns on one fact: the due date comes from when that lead's
opening email actually left, not from when the campaign was created.** Instantly
drips a campaign out over days, so 100 leads sent across a week have 100 different
follow-up dates. Keying off `campaign_leads.first_sent_at` — written by the
`email_sent` webhook — makes that sort itself out with no special cases.

| Export | Purpose |
|---|---|
| `delayInDays(step)` | Normalises a step's `delay` + `delay_unit` (minutes/hours/days) to days |
| `followupDueAt(firstSentAt, steps, stepOrder)` | Due date. Delays are **cumulative**: step 3 = sent + step2.delay + step3.delay, which is what makes step 3 land after step 2 rather than beside it. Returns `null` when never sent. |
| `isDueForWriting(dueAt, now)` | True when due within `FOLLOWUP_LEAD_TIME_DAYS`. **Already-overdue counts as due**, so a missed run catches up rather than skipping. |
| `findFollowupsToWrite(db, opts)` | The sweep. Returns targets ordered by due date. |

`FOLLOWUP_LEAD_TIME_DAYS = 1`. Writing at campaign start would spend tokens on the
roughly quarter of leads who reply or bounce first; writing on the due day itself
races Instantly, which may fire the step before the text lands.

**What the sweep excludes, and why each matters:**

| Excluded | Reason |
|---|---|
| Campaigns not `active`/`processing` | A draft campaign has sent nothing; a paused one must not quietly prepare work |
| Leads with no `first_sent_at` | No opening email means nothing to follow up on |
| `crm_status` in `replied`, `failed` | Conversation is over. A bounce is recorded as `failed`; Instantly also stops the sequence itself on reply |
| `(campaign, lead, step)` that already has a draft | This is what makes the job **idempotent** |
| Later steps when an earlier one is unwritten | Only the earliest unwritten step per lead — writing step 3 first would reference a message never sent |

> **Trap worth remembering.** `crm_status` is a Postgres **enum**. Passing a value
> that is not in it (`bounced`, `unsubscribed`) does not filter loosely — Postgres
> rejects the entire query with `22P02 invalid input value for enum`, the sweep
> returns nothing, and **no follow-up is ever written**, silently. The live enum
> accepts: `new`, `enriched`, `draft`, `approved`, `sent`, `replied`, `failed`.

### 14.4 THE WORKER

`lib/services/write-followups.ts` → `writeDueFollowups(db, opts)`

```
findFollowupsToWrite()          → what is due
  for each target, within a 40s time budget:
    read the campaign_lead in the shape generateOneDraft expects
    generateOneDraft(..., stepNumber)   → writes email_drafts row
    syncApprovedDraftToInstantly()      → pushes to that lead's customBody2
```

**Two halves, and the second is the one that is easy to forget.** Writing the
draft only updates our database. Instantly holds its own copy of the text in the
lead's `customBody2`, seeded at fan-out with the generic fallback. Without the
push, the database would show a personalised follow-up while Instantly cheerfully
sent boilerplate.

`syncApprovedDraftToInstantly` rebuilds the **whole** custom-variable set from
every approved/sent draft for that lead, so pushing after writing step 2 carries
step 1 along unchanged rather than clobbering it.

**Follow-ups are auto-approved.** `human_in_loop` is deliberately passed as
`false` — agreed with the client 21 Aug 2026, *"no need to certify the
follow-ups"*. Leaving them awaiting a human who will never come would mean
Instantly sends the fallback instead.

**Writes are company-scoped.** The sweep is cross-company by necessity; every
write goes through `createScopedClient(campaign.company_id)` so rows are stamped
correctly, exactly as `sendCampaign` does.

### 14.5 TRIGGERS AND WATCHDOG

`app/api/internal/write-followups/route.ts` — `POST` (internal secret) and `GET`
(Vercel Cron bearer), same shape as `enrichment-watchdog` and
`reconcile-counters`.

| Trigger | Cadence | Notes |
|---|---|---|
| Scheduled run | daily | A follow-up's due date moves in days; a tighter cadence only re-asks the same question |
| `runEnrichmentWatchdog` → `triggerFollowupWriter` | every 10 min | The safety net. Fire-and-forget with `limit: 25`, so the watchdog is never held open by a 40-second job |

**Why the watchdog hook exists.** A single missed daily run would leave that day's
follow-ups unwritten and Instantly would send the generic fallback — a silent
quality regression nobody would notice until a prospect received boilerplate.
Because the sweep skips anything already written, all but one of the ~144 daily
watchdog calls find nothing and return immediately.

**Self-healing.** The job asks *"due within a day and not yet written"*, never
*"due today"*. A missed day is picked up by the next run, including anything
already overdue. A failed schedule therefore delays follow-ups rather than losing
them, and the worst case is still the fallback sentence, never a blank email.

### 14.6 THE MULTI-TENANT GUARD (read this before testing locally)

`guardUnscoped()` in the route **refuses a company-wide sweep from anywhere that
is not production**.

Local development points at the **same Supabase and the same Instantly workspace**
as production. An unscoped sweep on a developer machine therefore writes into the
client's live campaigns and pushes text to their real Instantly leads.

**This is not hypothetical.** On 25 Aug 2026 a local test of this very route wrote
6 follow-ups into the client's `APOLLO CAMPAIGN 2` and pushed all 6 to Instantly.
The content was an improvement on the fallback and was kept, but it was an
unapproved production write from a dev machine.

| Caller | Behaviour |
|---|---|
| Production (`NODE_ENV=production`) | Unscoped sweep allowed — the daily cron serves every company |
| Anywhere else, no `company_id` | **HTTP 400 `COMPANY_ID_REQUIRED`**, nothing runs |
| Anywhere else, with `company_id` | Runs, scoped to that tenant only |

Deliberately a hard refusal rather than a log warning: a warning nobody reads is
what allowed the first incident.

**Testing locally:**

```bash
curl -X POST http://localhost:3000/api/internal/write-followups \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_SECRET" \
  -d '{"company_id":"00000000-0000-0000-0000-00000000000a"}'
```

Dev company is `...000a`. The client is `...000b` — never pass it by hand.

### 14.7 UI — where a follow-up is read and regenerated

**Status: designed and agreed, not yet built.** Design: Option A, revision 2.

The Sequences tab becomes three columns, left to right in the order the work is
actually done:

```
Step              Leads in that step        That lead's follow-up
Follow-up 1  →    Jose Castillo        →    Hi Jose, following up on my note
Follow-up 2       Guillermo Luna            about your blown film line...
                  Sarahi Sanchez            [Regenerate] [Edit]
```

| Column | Contents |
|---|---|
| Left, `w-72` | Follow-up steps. **Already built** and already excludes the opening email — `sequenceFollowUpSteps()` filters `step_order > 1`. The opening email is handled in Outbox, where it is certified. |
| Middle, new | Every lead in that step. `SearchInput`; a `Select` filter for *To be sent / Already sent / Not written / All* with counts in brackets, matching the Leads tab; `SegmentedTabs` sort defaulting to **soonest first**, so what sends next is at the top. |
| Right | Either that lead's own follow-up, or the shared template. A `SegmentedTabs` switch flips between them. The template editor is **already built** and must not be lost — a step still needs its delay and instructions edited. |

Status pills are one or two words through the existing `Pill` component with
`shape="sm"`: `Today`, `Tomorrow`, `Thu`, `Draft`, `22 Aug`. Longer explanation
belongs in the email panel header, where there is room.

**Components are all existing** — `Select`, `SegmentedTabs`, `SearchInput`,
`Pill`, `Button`, `ScrollArea`, `EmptyState`, `Skeleton`, `ConfirmDialog`. Lead
rows follow the row-card rule in `CLAUDE.md`: each row its own `bg-field` card
with a gap, like the Outbox lead rail.

**Regenerate all** lives in template mode and touches only leads not yet sent, with
the count in the button and a `ConfirmDialog` first.

**Cost behaviour, which the client asked about explicitly:**

| Action | Costs an AI call? |
|---|---|
| Open a lead and read the follow-up | No — read from `email_drafts` |
| Switch lead, switch tab, close the drawer | No — nothing is held in component state |
| Return the next day | No — same saved row |
| Edit by hand and save | No |
| Press Regenerate | Yes. One lead, only on request |
| Press Regenerate all | Yes. One per unsent lead, after confirmation |

**Version history comes free.** `regenerateOneDraft` demotes the current row to
`rejected` and inserts `version + 1` with `parent_draft_id` pointing back, so an
earlier follow-up can always be recovered — the same mechanism opening emails
already use.

### 14.8 FILES

| File | Role |
|---|---|
| `lib/services/settings.ts` | `FOLLOWUP_CONTRACT`; `resolveDraftSystemPrompt(db, ownerId, stepNumber)` picks it for `stepNumber > 1` |
| `lib/services/generate-drafts.ts` | Passes `stepNumber` into prompt resolution; suppresses the signature for follow-ups |
| `lib/services/followup-schedule.ts` | **New.** Due-date maths and the sweep |
| `lib/services/write-followups.ts` | **New.** The worker: generate, then push to Instantly |
| `app/api/internal/write-followups/route.ts` | **New.** POST + GET, plus `guardUnscoped()` |
| `lib/services/enrichment-watchdog.ts` | `triggerFollowupWriter()` added to `runEnrichmentWatchdog` |
| `components/app/campaign-drawer.tsx` | Sequences tab — the UI in 14.7, incl. per-lead version history and Regenerate all |
| `supabase/migrations/2026_08_25_cron_write_followups.sql` | **New.** The daily schedule |
| `lib/services/regeneration-jobs.ts` | `draftsForStep()` + `bulkRegeneratableStatuses()` — made bulk regeneration step-aware |
| `app/api/enrich/regenerate-drafts/route.ts` | `resolveDraftId()` — a step-2 job no longer resolves via `campaign_leads.draft_id` |
| `lib/services/regenerate-draft.ts` | Pushes an approved regenerated draft to Instantly |
| `scripts/check-regen-step-targeting.mjs` | **New.** Runnable assertions for the two targeting rules |

**No schema change.** `email_drafts.step_number` already existed; a follow-up is
simply a draft with `step_number = 2`. There were zero such rows before this, so
nothing had to be migrated.

### 14.9 VERIFIED BEHAVIOUR

Measured on the dev tenant, 25 Aug 2026.

| Check | Result |
|---|---|
| Due-date maths | 8 unit assertions pass: cumulative step 3, hours/minutes conversion, never-sent → null, overdue still writes |
| Sweep picks the right leads | 3 due leads written; 2 sent today, 1 replied and 2 never-sent all correctly skipped |
| Idempotent | Second run immediately after: `found: 0` |
| Guard | Unscoped local run refused `400 COMPANY_ID_REQUIRED`; scoped run succeeded |
| Length | 233–370 characters, 2–4 sentences (was 1,430) |
| Banned content | 0 of 7 contained the stats block, awards, product list, bullets or a re-introduction |
| Names their business | 7 of 7 |
| Signature | 0 of 7 |
| Auto-approved | All written as `approved`, no human step |
| Daily schedule | `cron.job` jobid 7, `write-followups`, `0 2 * * *`, `active = true` |
| Follow-up bulk regeneration | Dev campaign step 2: 3 eligible under the fix, **0** before it |
| Step targeting | `node scripts/check-regen-step-targeting.mjs` passes |

### 14.10 THREE BUGS FOUND WHILE BUILDING THE UI

All three were in code that already looked finished.

**1. A regenerated draft never reached Instantly.** `regenerateOneDraft` rewrote
our row and stopped there. Instantly keeps its own copy of the body in the
lead's `customBodyN` variable and reads it only once, at add time — so the UI
showed the new follow-up while Instantly kept sending the old one. Fixed in
`regenerateOneDraft` itself rather than in each caller, so the single-draft
route and the bulk worker are both covered. Gated on the new draft being
`approved`, which is a no-op for human-in-the-loop opening emails.

**2. A step-2 bulk job would have rewritten everyone's opening email.** The
worker resolved its target through `campaign_leads.draft_id`, a column that
tracks step 1 only. `resolveDraftId()` now looks a follow-up up by
`(campaign, lead, step)`.

**3. Follow-up "Regenerate all" could never find anything.** Bulk eligibility
excluded `approved` to protect certified emails — but follow-ups are
auto-approved by design, so every one of them was "protected" from the button
meant to rewrite them. `bulkRegeneratableStatuses(step)` widens the list for
step 2+ only. `sent` stays excluded everywhere.

---

# THE 10 THINGS I MUST UNDERSTAND

### 1. There is no backend, no worker tier, and no queue product — only Next.js route handlers and Postgres

**Simple explanation:** One Next.js app on Vercel. The "backend" is `app/api/**`. The "workers" are also `app/api/**`, just protected by a shared secret instead of a login. There is nothing else running.

**Example:** `/api/enrich/scrape-orgs` is a normal route file. What makes it a worker is line 555: `if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) return 401`.

---

### 2. The database IS the queue, and a row's state column is the queue entry

**Simple explanation:** No Redis, no BullMQ. "Pending work" means "rows that match this WHERE clause". The work item and the business record are the same row.

**Example:** `organizations.enrichment_stage = 'queued'` means "this company still needs scraping". For Apollo reveal there isn't even a status column — the queue is the predicate `has_email = true AND email IS NULL AND enrich_attempts < 2`.

---

### 3. Claiming work is atomic in SQL, because a double-claim costs real money

**Simple explanation:** Two invocations must never grab the same row. A single UPDATE…WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) makes concurrent callers get non-overlapping batches; the loser gets fewer rows instead of duplicates.

**Example:** `claim_queued_orgs(p_batch_size)` and `claim_unenriched_leads(p_ids)`. The org one replaced a select-then-update that was causing duplicate Firecrawl and LLM spend.

---

### 4. Work is done in batches sized by TIME, not by count, because the platform kills long functions

**Simple explanation:** Every route declares `maxDuration`. A batch is deliberately sized to finish well inside it, with room left to fire the next one.

**Example:** `generate-drafts` fetches 10 targets but stops starting new drafts after **40 seconds** of a 55-second ceiling. The old fixed count of 10 meant the lambda was killed during the ninth draft, **before reaching the self-chain code**, so every campaign over ~8 leads silently stopped at 8.

---

### 5. The next batch starts because the route calls ITSELF over HTTP, inside `after()`

**Simple explanation:** At the end of a batch the worker counts what is left; if more remains it makes an HTTPS POST to its own URL. `after()` is what guarantees that request escapes before the function freezes. The next batch is a brand-new invocation with a brand-new time budget.

**Example:** `scrape-orgs/route.ts:781`, `generate-drafts/route.ts:173`, `regenerate-drafts/route.ts:141`, `leads/enrich/route.ts:283`.

---

### 6. Completion is a COUNT query, not a memory of how many were done

**Simple explanation:** Nothing is remembered between invocations. Every batch re-asks the database "how many are still pending?". Zero means finished.

**Example:** `countPendingDrafts(campaign)` → 0 → `UPDATE campaigns SET status='draft'`. `countPendingItems(job)` → 0 → `finishJob()`. This is exactly why the system survives crashes: there is no cursor in memory to lose.

---

### 7. The self-chain WILL die, so watchdogs on pg_cron are a first-class part of the design

**Simple explanation:** Every internal fetch ends in `.catch(() => {})`, so a dropped handoff is silent. A separate scheduler living **in the database** re-kicks anything that has gone quiet.

**Example:** `enrichment-watchdog` every 10 minutes revives scraping, draft generation and regeneration. Staleness is measured by *evidence of output* — the newest `email_drafts.created_at`, or `heartbeat_at` — never by a status column, so a healthy run is never kicked twice and handed duplicate targets.

---

### 8. Database triggers do real work — `leads.status` is derived, not written

**Simple explanation:** Two triggers keep lead status honest without any application loop. One recomputes a lead's status whenever the lead changes; the other fans an organisation's change out to all its leads.

**Example:** `trg_lead_status_self` (BEFORE INSERT/UPDATE on `leads`) calls `compute_lead_status(...)`. `trg_org_sync_leads` (AFTER UPDATE on `organizations`) updates every non-deleted, non-terminal lead under that org in the same transaction. This also explains a design constraint: `status` could not be reused as the reveal lock column, because the trigger would immediately overwrite the marker — hence the dedicated `enrich_locked_at`.

---

### 9. Every retry/backoff decision is a billing decision

**Simple explanation:** Whether we retry depends on whether the provider charges on *receipt* or on *delivery*.

**Example:** `lib/http.ts` — Firecrawl and the LLMs get `[1s, 3s, 9s]`; **Apollo gets `[]`**. Apollo bills the moment it receives a request, including ones it rejects with 429 and ones we abandon on timeout: 1,403 people cost 3,222 credits on 2026-07-14 because of retries. The same reasoning put the paid reveal-resume job on a once-a-day schedule instead of inside the 10-minute watchdog.

---

### 10. Every query is tenant-scoped by a proxy, and "unscoped" is the deliberate signal for cross-company work

**Simple explanation:** There are two tenants sharing one database. Rather than trusting ~500 call sites to remember `.eq("company_id", …)`, `createScopedClient()` wraps the Supabase client in a Proxy that adds the filter to every read and stamps it on every write. Crossing a tenant boundary requires deliberately using the raw admin client.

**Example:** `dbForUser(user)` returns the scoped client — **except** when `user.companyId` is `null`, which happens only for the service-role bearer used by cron and relays. Those callers are cross-company by design and carry `company_id` explicitly from the rows they process (e.g. `claim_queued_orgs` returns `company_id` so each org is processed through its own tenant's client). `companies` and `system_state` are the only two tables the proxy passes through untouched.

---

# YOUR TEN QUESTIONS, ANSWERED IN ONE LINE EACH

1. **What triggers work?** User clicks → `/api/v1/*`; `after()` self-calls; pg_cron (4 jobs); Vercel Cron (1); GitHub Actions (1 scheduled); the Instantly webhook; DB triggers; browser polling timers.
2. **Where does the work run?** In Next.js route handlers as Vercel serverless invocations — the same process type that serves the UI. Nowhere else.
3. **Do we have a queue?** No queue product. Postgres rows + state columns + predicate queries are the queue.
4. **What acts as the worker?** `/api/enrich/scrape-orgs`, `/api/enrich/generate-drafts`, `/api/enrich/regenerate-drafts`, `/api/v1/leads/enrich`, `/api/v1/unibox/sync` — plain routes behind `x-internal-secret` or a service-role bearer.
5. **Where is pending work stored?** `organizations.enrichment_stage='queued'`; `leads` matching the reveal predicate; `campaign_leads` without a usable draft; `draft_regeneration_job_items.status='pending'`.
6. **How does a batch start?** Something POSTs a worker route with the internal secret; the route pre-flights credits, then atomically claims rows with `FOR UPDATE SKIP LOCKED`.
7. **How does the next batch start?** The same route counts what's left and, inside `after()`, POSTs itself again — a new invocation with a fresh time budget.
8. **How does the system know work is completed?** A COUNT of pending rows returns 0, at which point the job/campaign row is flipped to its finished status.
9. **What happens if something fails?** Rows stay in an in-progress state; attempt counters cap retries (orgs 3, Apollo reveal 2, drafts 3); a staleness threshold (5–10 min) makes rows reclaimable; a watchdog re-kicks within 10 minutes for free pipelines and within 24 hours for the paid one.
10. **How do scheduled/watchdog processes fit in?** They are the **only** guaranteed trigger. Self-chains are best-effort and fail silently by construction; pg_cron lives in the always-awake database, calls back into the app through `pg_net` with a Vault-held secret, and converts "the chain died" from an outage into a bounded delay.

---

## Appendix — things that could NOT be confirmed from the code

- The exact Vercel project, plan and region. `vercel.json`, `.env.vercel` and many comments imply Vercel + Hobby, but there is no `.vercel/project.json` in the repo. **NOT CONFIRMED FROM CURRENT CODE.**
- Whether the GitHub Actions secrets (`APP_URL`, `INTERNAL_SECRET`) are actually populated, i.e. whether `retry-failed-orgs` is really succeeding every 3 hours. **NOT CONFIRMED FROM CURRENT CODE** (the workflow fails loudly if they are unset, but that is a runtime fact).
- Whether Vercel Cron is actually firing `reconcile-counters` (requires `CRON_SECRET` set in the Vercel project). **NOT CONFIRMED FROM CURRENT CODE.**
- Any RLS *policies*. RLS is enabled on all 34 tables; the migrations describe the posture as "RLS on, zero policies, service-role only", but the policy list itself was not enumerated during this pass. **NOT CONFIRMED FROM CURRENT CODE.**
- Real-time push to the browser: none found. No Supabase Realtime channels, no websockets, no SSE anywhere in `app/`, `components/` or `lib/`. Progress is seen only via polling.
