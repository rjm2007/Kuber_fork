# 1 · System architecture

*What are the pieces, and where does each one run?*

---

## 1.1 The one-paragraph version

Kuber is a **Next.js 15 application deployed on Vercel**, talking to a **Supabase
Postgres database**, orchestrating **four outside providers** (Apollo, Firecrawl,
an LLM, and Instantly). There is no separate backend service and no worker fleet.
Every piece of server code is a Next.js route handler that runs as a short-lived
serverless function. Long jobs are not done by keeping a process alive — they are
done by **chopping the work into batches and having each batch call the next one**.
The database is not just storage; it is also the job queue, the lock table, and
the scheduler.

That last sentence is the single most important idea in this system. Everything
in document 6 follows from it.

---

## 1.2 The boxes

```
┌─────────────────────────────────────────────────────────────────────┐
│ BROWSER — React 19, Tailwind 4, Next.js App Router                  │
│ app/(app)/leads · /campaigns · /dashboard · /unibox · /settings     │
│ All calls go through lib/api-client.ts                              │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  Authorization: Bearer <Supabase JWT>
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ API — 108 Next.js route handlers, each a serverless function        │
│                                                                     │
│   app/api/v1/**        user-facing        JWT required              │
│   app/api/enrich/**    batch workers      x-internal-secret only    │
│   app/api/internal/**  cron entry points  x-internal-secret only    │
│                                                                     │
│   requireAuth() → rate limit → dbForUser(user) → company-scoped db  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  supabase-js with the SERVICE ROLE key
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ DATABASE — Supabase Postgres · 42 public tables                     │
│                                                                     │
│   application data  +  the work queue  +  job state  +  the clock   │
│   RLS is ON everywhere, with effectively no policies: server only.  │
│   Extensions: pg_cron (the clock), pg_net (outbound HTTP),          │
│               supabase_vault (provider secrets, encrypted)          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  pg_cron fires ping_internal_route(...)
                           ▼  which uses pg_net to POST back into the API
┌─────────────────────────────────────────────────────────────────────┐
│ PROVIDERS                                                           │
│   Apollo      — buys lead records (costs credits)                   │
│   Firecrawl   — scrapes a company website (costs credits)           │
│   LLM         — writes the email (Anthropic / OpenAI / OpenRouter)  │
│   Instantly   — actually sends the mail, and reports replies back   │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           │  Instantly → webhook → /api/v1/webhooks/instantly
                           └──────────────────────────────────────────►
```

Note the arrow at the bottom. **The database calls the API, and Instantly calls the
API.** Traffic is not only inbound from the browser. That is unusual and it is
worth holding on to.

---

## 1.3 The three doors into the API

Every route handler is behind exactly one of three doors. Knowing which door a
route uses tells you almost everything about how it behaves.

| Door | Path prefix | Who may knock | Rate limited? |
|---|---|---|---|
| **User** | `app/api/v1/**` | A logged-in person, with a Supabase JWT | **Yes** |
| **Worker** | `app/api/enrich/**` | Our own code, with `INTERNAL_SECRET` | No |
| **Cron** | `app/api/internal/**` | pg_cron, with `INTERNAL_SECRET` | No |

The rate limiter (`lib/auth/rate-limit.ts`) lives *inside* `requireAuth`. Worker
and cron traffic never calls `requireAuth` — it checks the shared secret directly
— so **the exemption is structural, not a maintained allow-list**. That matters:
drafting a 100-lead campaign is a long chain of internal calls, and throttling
those would stop a campaign half-written with no visible error.

There is one seam worth knowing: `requireAuth` also accepts the **service-role
key** as a bearer token, returning an identity with `companyId: null`. That
identity gets an *unscoped* database client. It is for server-to-server use, and
it is why a service-role call to a route that writes a company-scoped table can
fail on a NOT NULL constraint — seen live on 31 Aug 2026 against
`/api/v1/reply-drafts/generate`.

---

## 1.4 Multi-tenancy: how two customers share one database

Two companies exist today, with fixed UUIDs:

| Company | UUID | What it is |
|---|---|---|
| Dev | `00000000-…-00000000000a` | Our testing tenant |
| Kuber Polyplast | `00000000-…-00000000000b` | The paying client |

Almost every table carries a `company_id`. Isolation is **not** enforced by
Postgres RLS — RLS is on but has no policies, and the server uses the service-role
key which bypasses it anyway. Isolation is enforced in application code by
`lib/supabase/scoped.ts`:

```ts
dbForUser(user)  // → createScopedClient(user.companyId), or admin if null
```

`createScopedClient` returns a **proxy** around the Supabase client. It
automatically appends `.eq("company_id", …)` to reads and **stamps `company_id`
onto every row you insert**. You do not write the filter yourself; forgetting it
is the exact bug the proxy exists to prevent.

> **The rule:** in a route handler, use `dbForUser(user)`. Use
> `createAdminClient()` only when you genuinely need to work across tenants — a
> cron sweep, for instance — and then scope down to `createScopedClient(companyId)`
> before you write anything.

**Two things are deliberately cross-tenant**, and they surprise people:

1. **Instantly and Apollo are ONE shared account.** `lib/services/instantly.ts`
   resolves its key with scope `"any"` on purpose — both companies send from the
   same three `@kuberpolyplast.com` mailboxes and draw on the same Apollo credit
   pool. The database side is isolated; the mailbox is not, and cannot be.
2. **LLM keys are per-company.** These used to leak: `getActiveKey` had no company
   filter, so every tenant's LLM call could pick up another tenant's key. Fixed by
   making `scope` a required parameter of `getActiveKey` — passing `"any"` is now
   a deliberate, visible choice rather than an omission.

---

## 1.5 Where secrets live

Provider API keys are **not** in environment variables. They are rows in
`provider_keys`, with the secret itself in `supabase_vault` (encrypted at rest)
and only a `secret_vault_id` on the row.

Resolution order, in `lib/services/provider-keys.ts`:

```
provider_keys  (active, healthy, right company, lowest priority first)
      ↓ if none usable
process.env.<PROVIDER>_API_KEY        ← fallback tier only
```

This is why "I changed the key in `.env.local` and nothing happened" is a normal
experience: the database wins. Change keys in **Settings → Keys**.

A key carries a `status` (`healthy` / `cooling_off` / `dead`). A cooling-off key
is skipped until `cooling_off_until` passes, then tried again. `provider_keys` has
RLS enabled with **zero policies**, so only the service role can read it — which
is exactly what you want for a secret store.

---

## 1.6 What the deployment actually looks like

- **One Vercel project.** Frontend and API are the same Next.js app. There is no
  separate API server to deploy or scale.
- **Serverless functions, not containers.** Each request gets a fresh function
  invocation. There is no shared memory between requests, and no process that
  stays alive between them. (The rate limiter's counters live in one instance's
  memory — a known, documented limitation, not a security control.)
- **`maxDuration = 55` on 26 routes.** That is the wall. Any job longer than ~55
  seconds must be broken into batches. See §3.1 of document 3 for how.
- **The scheduler is pg_cron inside Supabase**, not Vercel Cron. `vercel.json`
  declares exactly one cron (`reconcile-counters`); the other seven live in the
  database. Document 6 explains why.

---

## 1.7 The five things that most often confuse newcomers

1. **The database schedules the work.** pg_cron calls `ping_internal_route()`,
   which uses pg_net to make an HTTP POST back into the Vercel app. The clock
   lives in Postgres, not in the app.
2. **Long jobs self-chain.** A batch worker processes ~10 items, then calls its own
   URL again for the next 10. There is no queue service.
3. **Instantly renders the email at SEND time, not queue time.** Proven live on
   29 Aug 2026: an edit made while a follow-up sat queued reached the recipient.
   That is what makes "hold sending" work at all.
4. **We can write text into Instantly but never read it back.** Both
   `GET /leads/{id}` and `POST /leads/list` return empty `custom_variables`. Our
   database is the only copy of what we intend to send.
5. **A campaign fans out into one Instantly sub-campaign per country**, each with
   its own timezone. One row in our `campaigns` maps to many rows in
   `instantly_campaigns`. This is by design — see `docs/campaign-timezone-rca.md`.

---

Next: [02-high-level-design.md](02-high-level-design.md) — what the product does.
