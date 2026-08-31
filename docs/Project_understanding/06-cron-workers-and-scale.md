# 6 · Cron, workers, and scale

*Why is it scheduled this way, and what breaks at 1000 users?*

---

## 6.1 The constraint everything follows from

Vercel runs **serverless functions**. A function starts when a request arrives,
runs for at most `maxDuration` seconds, and is then frozen or destroyed. There is
**no process that stays alive between requests**.

This app sets `maxDuration = 55` on 26 routes. So:

- You cannot run a background loop.
- You cannot hold an in-memory queue.
- You cannot keep a connection pool warm.
- You cannot run `setInterval`.

Every scheduling decision below is a way to get periodic, long-running work done
**without any of those**.

---

## 6.2 What we actually use

### The clock: pg_cron inside Supabase

Seven jobs live in the database, one in `vercel.json`. Live as of 31 Aug 2026:

| Schedule | Job | What it does |
|---|---|---|
| `*/10 * * * *` | `enrichment-watchdog` | Re-drives six kinds of stalled work |
| `*/15 * * * *` | `unibox-sync` | Pulls replies Instantly's webhook may have missed |
| `0 2 * * *` | `write-followups` | Writes tomorrow's follow-ups |
| `30 2 * * *` | `reconcile-counters` | *(this one is in `vercel.json`)* |
| `40 2 * * *` | `check-sequence-drift` | Detects our steps drifting from Instantly's |
| `20 3 * * *` | `purge-cron-history` | Deletes `cron.job_run_details` older than 7 days |
| `10 4 * * *` | `resume-apollo-reveal` | Continues a paused Apollo reveal |
| `15 */6 * * *` | `auto-retry-failed-orgs` | Requeues retryable enrichment failures |

The mechanism:

```sql
select public.ping_internal_route('/api/internal/write-followups', 60000);
```

`ping_internal_route` uses **pg_net** to make an HTTP POST from Postgres back into
the Vercel app, carrying `INTERNAL_SECRET`. **The database calls the API.**

> **This is the single most surprising fact in the system, and the one people
> forget.** Editing the `.github/workflows/*.yml` files does nothing — they are
> manual-dispatch only. The real schedule is in `cron.job`. To change a cadence,
> change the database.

### The worker: self-chaining batches

For work longer than 55 seconds, a route does ~10 items and calls itself again.
Covered in detail in §3.1 of document 3.

```
user clicks "Generate drafts"
        ↓
POST /api/v1/campaigns/{id}/generate-drafts       (55s wall)
        ↓ kicks off
POST /api/enrich/generate-drafts  → 10 drafts → after() → calls itself
        ↓                                                      │
        └──────────────────────────────────────────────────────┘
                        …until remaining = 0
```

### The safety net: watchdogs

A chain can break — a cold start, a timeout, a provider blip. The ten-minute
watchdog finds work that has been "in progress" too long and re-drives it. That is
what makes a broken chain a **delay** instead of a **loss**.

---

## 6.3 Why cron-plus-self-chaining, and not a worker?

A "worker" means a process that stays alive, pulls from a queue, and processes
continuously — BullMQ on a VM, Celery, a container on Railway.

**We are not using one, and that is the right call today. Here is the honest
comparison.**

| | Cron + self-chaining (ours) | A real worker |
|---|---|---|
| Extra infrastructure | **None** | A VM/container, plus Redis or similar |
| Extra monthly cost | **₹0** | Roughly ₹1,500–4,000 for a small always-on box |
| Deploy story | One `git push` | Two deploy targets that must stay in version-sync |
| Retries, backoff, DLQ | **Hand-rolled** (watchdog + `attempts` columns) | Built in, mature |
| Concurrency control | Hand-rolled (DB locks, `BatchBudget`) | Built in |
| Observability | Our own `enrichment_logs` + `llm_usage` | A dashboard out of the box |
| Latency to start a job | Seconds | Milliseconds |
| Max single unit of work | **55 seconds. Hard.** | Unlimited |
| Idle cost | **Zero** | You pay 24/7 for a box that is idle most of the night |

**The four reasons it is right for Kuber right now:**

1. **The workload is bursty and small.** Ten campaigns a week, not ten thousand
   jobs an hour. An always-on worker would idle ~95% of the time and we would pay
   for all of it.
2. **Every unit of work already fits in 55 seconds.** One draft averages 6.2s,
   worst measured 10.5s. One scrape is a few seconds. Nothing individual comes
   close to the wall — only the *batch* does, and batching solves that.
3. **The database is already the source of truth.** Job state lives in columns we
   need anyway (`campaign_leads.crm_status`, `email_drafts.attempts`,
   `enrichment_logs`). A separate queue would be a *second* place where truth
   lives, and the two would drift.
4. **One deploy target.** Frontend, API and jobs ship together. There is no
   version skew between a worker and the app, which is a whole class of
   3am-incident that simply does not exist here.

**Be honest about what it costs us:**

- Retry logic is hand-written and has been wrong. `LLM_EXTRACTION_PARTIAL_NO_DATA`
  said "Will retry" and did not, for weeks. A real queue would have retried it for
  free.
- A broken chain is invisible until the watchdog notices — up to ten minutes.
- The rate limiter cannot be exact, because there is no shared memory.
- There is no dead-letter queue. Failures land in status columns and someone has
  to go looking.

---

## 6.4 The other options, and when each becomes right

| Option | What it gives | Switch when |
|---|---|---|
| **Vercel Cron** | Schedules in `vercel.json`, versioned with the code | You want the schedule in git. **But:** Hobby allows 2 crons at day-granularity only; Pro allows 40. Our 10-minute watchdog is impossible on Hobby, which is exactly why pg_cron won. |
| **Supabase Edge Functions** | Deno, runs next to the database, no 55s Vercel wall | A job needs to be close to the data and long-running. Costs a second runtime and language. |
| **QStash (Upstash)** | Managed HTTP queue: real retries, backoff, DLQ, delays — and it calls your existing serverless routes | **This is the natural next step.** It keeps the serverless model and removes the hand-rolled retry logic. Low migration cost: the routes do not change, only what calls them. |
| **Inngest / Trigger.dev** | Durable multi-step workflows with state between steps, replay, a real UI | Chains grow past two or three hops, or you need to see and replay a failed run. This is what "we need a workflow engine" actually looks like. |
| **A real worker (BullMQ + Redis on a VM)** | Full control, no time wall, high throughput | Sustained load makes an always-on box cheaper than per-invocation billing, or a single unit of work genuinely exceeds 55 seconds. |
| **Postgres as a queue** (`SELECT … FOR UPDATE SKIP LOCKED`) | Real queue semantics with **zero new infrastructure** | You want atomic claim-one-job semantics but do not want another service. Fits this codebase's existing philosophy better than anything else on this list. |

**The recommendation, in order:** stay as-is → add **QStash** when retries start
hurting → add **Inngest** when chains get complex → a real worker only if
throughput genuinely demands it. Do not skip steps.

---

## 6.5 What breaks at 1000 users

Today: 2 companies, 10 users, 5,269 leads, 8,708 drafts. Multiply by 100. Here is
what actually breaks, hardest first.

### ① The 1000-row PostgREST cap — **breaks first, breaks silently**

**This is the one that will hurt.** PostgREST caps every response at 1000 rows and
**silently clamps a larger `.limit()`**. No error. A short read in the send path
means leads that never get emailed, and nobody finds out.

It has already bitten four times at *current* scale. At 100× it is everywhere.

*Fix:* `.range()` pagination with a stable `.order()` on every query that could
exceed 1000 rows. Audit them all before growth, not after. See §3.6 of document 3.

### ② Instantly throughput — **the actual ceiling on the business**

Measured 31 Aug 2026: **~1 email per 9 minutes** on this account, ~160/day from
three mailboxes. 1000 users wanting 100 emails a day each needs 100,000/day.

*Fix:* this is not an engineering problem. It is mailbox capacity — hundreds of
warmed sending accounts, with dedicated Instantly workspaces per tenant. Buy it or
build a different sending path. **No amount of code makes this go away**, and it
would cap the product long before the database does.

### ③ Rate limiting has no shared memory

Counters live in one instance's memory. At 1000 users across many warm instances,
the effective limit is a multiple of the configured one.

*Fix:* Upstash Redis. Small, well-understood change to `lib/auth/rate-limit.ts`.

### ④ Provider rate limits and credit pools

Apollo, Firecrawl and the LLM providers all have per-account limits, and today
**Apollo and Instantly are one shared account across all tenants**. One noisy
tenant starves everyone.

*Fix:* per-tenant keys (the schema already supports it — `provider_keys.company_id`
exists), plus a token-bucket in front of each provider client.

### ⑤ Self-chaining does not fan out

A campaign's chain is **sequential**: 10 drafts, then 10 more. 1000 leads at 6.2s
each is roughly 100 minutes for **one** campaign. Fifty concurrent campaigns each
run their own chain, so the total is fine — but any single large campaign is slow,
and users will notice.

*Fix:* fan out to N parallel chains keyed by `lead_id % N`, with a per-company
concurrency cap so one tenant cannot monopolise the provider quota.

### ⑥ Database connections

Serverless plus Postgres is the classic connection-exhaustion pairing.

*Fix:* Supabase's pooler (Supavisor) in transaction mode. Mostly configuration.

### ⑦ Table growth

`enrichment_logs` is already 49,267 rows and `lead_events` 23,486 — at 2 companies.
At 100× that is millions, and every dashboard query gets slower.

*Fix:* partition by month, or archive beyond 90 days. `purge-cron-history` already
does this for cron history; extend the pattern.

### ⑧ Tenant isolation is application-code only

41 of 42 tables have zero RLS policies. Today, one missed `dbForUser()` is a
cross-tenant data leak. At 2 tenants that is embarrassing; at 1000 it is a
reportable breach.

*Fix:* real RLS policies keyed on a JWT company claim, so the database enforces
what the proxy currently enforces by convention. Do this **before** onboarding
tenant number three, not after.

---

## 6.6 The order to fix them in

```
BEFORE tenant #3          ⑧ real RLS policies
                          ④ per-tenant provider keys

BEFORE 10× growth         ① audit every query for the 1000-row cap
                          ③ shared-memory rate limiting
                          ⑥ connection pooling

BEFORE 100× growth        ② mailbox capacity  ← the real business ceiling
                          ⑤ parallel chains
                          ⑦ table partitioning
```

Note that ① and ⑧ are **cheap now and expensive later**, and neither is visible
in normal use until it fails. Those are the ones to do early.

---

## 6.7 The short answer, if someone asks

> *"Why cron and not a worker?"*
>
> Because the workload is bursty and small, every individual unit of work already
> fits inside the 55-second serverless limit, the database is already the source
> of truth for job state, and one deploy target means no version skew. A worker
> would add a box, a queue service, and a second deploy pipeline to solve a
> problem we do not have yet. When retry logic starts hurting, the next step is
> QStash — not a worker — because it keeps the serverless model and only replaces
> the part that is actually painful.

---

Back to [README.md](README.md).
