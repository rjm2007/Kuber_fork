# 3 · Low level design

*How is each stage built, and why that way?*

This document is about **mechanisms**. Each section names the problem first, then
the solution, then the file. Read the problem statements even if you skip the rest
— they are why the code looks the way it does.

---

## 3.1 The self-chaining batch worker

**The problem.** A serverless function is killed at 55 seconds. Drafting 100 emails
takes about ten minutes. There is no process that can stay alive that long.

**The solution.** Do about ten, then call yourself again.

```ts
// app/api/enrich/generate-drafts/route.ts
export const maxDuration = 55;

const targets = await fetchDraftTargets(cdb, campaignId, 10, stepNumber);
for (const t of targets) {
  if (!budget.hasRoomForAnother()) break;
  await budget.run(() => generateOneDraft(...));
}

if (remaining > 0) {
  // after() keeps the lambda alive until the next kickoff actually leaves the
  // machine, so generation does not silently stop mid-campaign.
  after(async () => {
    await fetch(`${baseUrl}/api/enrich/generate-drafts`, {
      method: "POST",
      headers: { "x-internal-secret": secret },
      body: JSON.stringify({ campaign_id: campaignId, step_number: stepNumber }),
    }).catch(() => {});
  });
}
```

Three details that are load-bearing:

**`after()`, not a bare `fetch`.** Without it the function can return and be frozen
before the outbound request leaves the machine — and the chain dies silently,
mid-campaign, with no error anywhere.

**`BatchBudget`, not a flat timeout.** Every worker used to stop starting new work
at a hard 40 seconds. That is a guess about the *average* call and it fails on the
slow ones. Measured across 41 real drafts on 28 Aug 2026: 6.2s average, 2.1s
fastest, **10.5s slowest**. A draft starting at 39.9s and running 10.5s finishes at
50.4s — under five seconds left for the chain kickoff and the response, and on a
cold start that tips over. It did: a `FUNCTION_INVOCATION_TIMEOUT` stranded three
drafts. So `lib/services/batch-budget.ts` measures the calls instead:

```
LAMBDA_CEILING_MS  55_000   the platform's wall
TAIL_RESERVE_MS     6_000   for writing results + the chain kickoff + the response
COLD_ESTIMATE_MS   11_000   assumed cost of call #1, deliberately above average
```

Guessing high wastes at most one slot. Guessing low strands a call mid-flight.

**A self-heal RPC at the top.** `reset_stuck_draft_generation(stale_minutes => 5)`
runs before anything else, so a batch killed mid-flight last time does not leave
rows locked forever.

---

## 3.2 Key resolution — one choke point

**The problem.** Provider keys were read in several places, each with slightly
different logic. One of them had no company filter, so **every tenant's LLM call
could pick up another tenant's key**. Proven empirically, not suspected.

**The solution.** One function, and `scope` is a required parameter:

```ts
// lib/services/provider-keys.ts
export type KeyScope = string | "any";

export async function getActiveKey(
  db: Db, provider: ProviderId, scope: KeyScope,
  opts?: { exclude?: Set<string> },
): Promise<ResolvedKey | null> {
  let query = db.from("provider_keys")
    .select("id, secret_vault_id")
    .eq("provider", provider)
    .eq("is_active", true)
    .or(`status.eq.healthy,and(status.eq.cooling_off,cooling_off_until.lte.${nowIso})`);

  if (scope !== "any") query = query.eq("company_id", scope);

  const { data: rows } = await query
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  // … read the secret from vault, else fall back to process.env
}
```

Making `scope` required is the whole fix. `"any"` is still allowed — Instantly and
Apollo genuinely are one shared account — but it is now a **visible decision at
the call site** rather than a filter someone forgot.

`exclude` supports failover: when a key returns a hard error, it is added to the
exclude set and the next key by priority is tried.

---

## 3.3 The LLM wrapper and cost accounting

**The problem.** The client needs to be able to ask "what did this cost?" and get a
true answer, including the waste.

**The solution.** One `complete()` that no caller can bypass:

```ts
// lib/services/llm.ts
export interface LlmCallMeta {
  purpose: "draft" | "followup" | "reply" | "enrichment" | "classify" | "other";
  campaignId?: string | null; leadId?: string | null; draftId?: string | null;
}

export async function complete<T = object>(
  opts: CompletionOpts,
  companyId: string,          // required — no unscoped LLM calls
  meta?: LlmCallMeta,
): Promise<LlmResult<T>> { … }
```

Then `recordUsage()` writes one `llm_usage` row per call. Two rules:

- **`recordUsage` is best-effort and swallows its own errors.** Accounting must
  never be able to break generation. A failed insert loses one row; a thrown error
  would lose the email.
- **Unknown model pricing returns NULL, never 0** (`lib/services/llm-pricing.ts`).
  A zero silently understates the bill and nobody notices; a NULL is a visible gap.

Verified live on 31 Aug 2026: a run producing 6 AI generations and 6 template ones
wrote exactly 6 rows. The template path spends nothing and correctly logs nothing.

**Provider quirks the wrapper has to absorb** (`lib/services/providers/registry.ts`):

| Quirk | Handling |
|---|---|
| `temperature` is **removed** on the Claude 5 family — sending it is a hard 400 | `anthropicRejectsTemperature(model)` |
| Thinking models return an empty body at `effort: "low"` | `output_config = { effort: "medium" }`, `max_tokens` ≥ 8192 |
| Identity-linked (multi-workspace) Anthropic keys 400 without a workspace header | `anthropic-workspace-id` sent when configured |
| Claude wraps JSON in markdown fences ~100% of the time despite instructions | `parseJsonResponse` strips them |

---

## 3.4 The follow-up fallback ladder

**The problem.** Two different situations reach "we cannot personalise this
follow-up" — the lead has no company data, and the AI failed outright — and they
used **two different texts**. One read a global setting; the other was a constant
hardcoded in `generate-drafts.ts` that named "Kuber Polyplast" in the source, so a
second client on this system would have sent emails naming the wrong company.

**The solution.** One resolver, three tiers, most specific first:

```ts
// lib/services/followup-template.ts
export async function resolveFollowupTemplate(
  db: SupabaseClient, campaignId: string, stepOrder: number,
): Promise<string> {
  //  1. campaign_steps.fallback_body        this campaign, this step
  //  2. settings.followup_fallback_body     the install-wide default
  //  3. BUILT_IN_FOLLOWUP_FALLBACK          last resort, names no company
}
```

Per **step**, not per campaign, because a second nudge and a fourth nudge can
reasonably say different things. Every tier is optional, an empty box means
"inherit" rather than "send nothing", and the resolver **never throws** — a
follow-up that cannot be personalised is already the degraded path, and failing to
read a setting must not turn it into no email at all.

Both callers now use it: `write-followups.ts` (the AI-failed path) and
`generate-drafts.ts` (the no-data path). They handle greetings differently, which
is why a good fallback text carries its own `Hi {{first_name}},`:

- `write-followups` inserts the text **as-is**.
- `generate-drafts` **strips** the leading greeting and prepends its own
  `Dear {name},` — hence `stripLeadingGreeting()`, which must remove
  `"Hi Steve,"` but must **not** remove `"Highlighting our new grade..."`.

Verified live 31 Aug 2026 across both tiers.

---

## 3.5 Retry semantics in enrichment

**The problem.** A status said "Will retry" and never did — `LLM_EXTRACTION_PARTIAL_NO_DATA`
was missing from the retry set. Separately, leads with no domain were being retried
forever, at cost, with nothing that could possibly change.

**The solution.** Make the sets explicit and the budgets per-cause:

```ts
// app/api/enrich/scrape-orgs/route.ts
const RETRYABLE_STATUSES = new Set([
  "SCRAPE_FAILED",
  "LLM_EXTRACTION_FAILED",
  "LLM_EXTRACTION_PARTIAL_NO_DATA",   // was missing — said "Will retry", never did
  "SCRAPE_PROVIDER_UNAVAILABLE",
]);
const PROVIDER_FAULT_STATUSES = new Set(["SCRAPE_PROVIDER_UNAVAILABLE"]);
const MAX_ATTEMPTS_BY_STATUS = { SCRAPE_FAILED: 3, LLM_EXTRACTION_FAILED: 2 };
```

A lead with **no domain at all** goes to `unenrichable_leads` and is never retried.
There is nothing to retry — that is the whole point of the table.

`lib/services/enrichment-status.ts` holds `TERMINAL_ENRICHMENT_STATUSES`, shared by
both retry paths so they cannot drift apart.

---

## 3.6 Pagination — the bug that bit four times

**The problem.** Supabase/PostgREST caps a response at **1000 rows server-side**.
A larger `.limit()` is **silently clamped** — no error, no warning, just a short
read. In a send path, a short read means leads that never get emailed.

**The solution.** `.range()` pagination everywhere it matters:

```ts
// lib/services/campaign-fanout.ts
const FANOUT_PAGE_SIZE = 1000;
const buildEligible = (from: number, to: number) =>
  q.order("id", { ascending: true }).range(from, to);
  // ↑ a stable order is REQUIRED: without one, Postgres may return rows in a
  //   different order per page and a lead can be seen twice or missed entirely.

for (let from = 0; ; from += FANOUT_PAGE_SIZE) {
  const { data } = await buildEligible(from, from + FANOUT_PAGE_SIZE - 1);
  if (!data?.length) break;
  cls.push(...data);
  if (data.length < FANOUT_PAGE_SIZE) break;
}
```

A related trap: the drafts read deliberately **dropped** `.in("lead_id", leadIds)`.
A thousand UUIDs is roughly 37 KB of URL, which is its own failure.

> If you write a query that could ever return more than 1000 rows, page it. There
> is no safe `.limit(5000)`.

---

## 3.7 Rate limiting that cannot break the crons

**The problem.** Every route is behind a login, so the realistic threat is **a bug,
not a person** — a stuck poll or a retry loop calling a money-spending route
thousands of times overnight, looking exactly like the app working. At roughly
₹1.50 per drafted email, an unbounded loop is an unbounded bill.

**The solution.** Three tiers, sized against measured behaviour:

```ts
// lib/auth/rate-limit.ts
const LIMITS = { read: 300, write: 120, spend: 20 };   // per minute, per user
```

- **read: 300** — the UI polls draft progress every 3 seconds, so one poller is
  20/min. This clears ten concurrent pollers.
- **write: 120** — ordinary edits. Bulk actions are **one request carrying many
  ids**, so certifying 200 leads costs 1 unit, not 200.
- **spend: 20** — routes that cost money on every call, listed in `SPEND_PATHS`.
  Per *click*, not per lead.

It is a **sliding window**, so 20 calls at 00:30 do not also allow 20 more at 01:00
just because a clock minute rolled over. It **fails open** by construction: there
is no I/O in it that can throw, and refusing real work because the limiter itself
broke would be worse than the loop it guards against.

Known limitation, stated plainly: counters live in **one serverless instance's
memory**. Vercel runs several, so a user spread across instances gets a higher
effective limit. It still catches a runaway loop hammering one warm instance, but
it is not a security control. Upstash/Redis is the upgrade when it needs to be
exact.

---

## 3.8 Watchdogs

`lib/services/enrichment-watchdog.ts`, driven by a **ten-minute** cron, re-drives
six kinds of stalled work — stuck enrichment, stuck drafting, scrape recovery,
Instantly health, and more. It is the reason a transient failure does not need a
human.

This is also the answer to "what if rate limiting blocks something?" — the
watchdog picks it up on the next pass. But note the limiter never fires on
internal traffic in the first place (§3.7, §1.3), so the two systems do not
actually interact.

---

## 3.9 The check scripts

`scripts/check-*.mjs` — seventeen small `assert`-based files, no test framework.
Each one mirrors a piece of non-trivial logic and encodes **why** it is that way:

```
check-anthropic-sampling     which Claude models reject `temperature`
check-batch-budget           the lambda time arithmetic
check-empty-body-guard       follow-ups may be short; openings may not
check-extracted-null         the word "null" is not a description
check-fanout-paging          the send path reads past the 1000-row cap
check-followup-template      the fallback ladder + no signature on follow-ups
check-followup-write-day     follow-ups are written on the last working day (IST)
check-honorifics             no gendered honorific survives any prompt tier
check-rate-limit             limits clear real usage and exempt internal traffic
…and seven more
```

Run them all with `for f in scripts/check-*.mjs; do node "$f"; done`. They take
about two seconds and they encode reasoning that would otherwise be lost. When you
fix something subtle, add one.

---

Next: [04-database-schema.md](04-database-schema.md) — the tables.
