# 2 · High level design

*What does the product actually do?*

---

## 2.1 The business in one sentence

Kuber Polyplast makes plastic masterbatch. This app finds companies who might buy
it, learns enough about each one to write a genuinely specific email, sends that
email, chases it twice, and puts any reply in front of a salesperson with a
suggested response already written.

---

## 2.2 The six stages

Every lead moves left to right. Nothing skips a stage.

```
  ①            ②             ③           ④          ⑤            ⑥
IMPORT  →  ENRICHMENT  →  CAMPAIGN  →  DRAFTING  →  SENDING  →  REPLIES
  │            │             │           │            │            │
Apollo      Firecrawl     grouping     the LLM    Instantly    Unibox +
or Excel    + the LLM     + steps      writes it   delivers     AI reply
```

| Stage | Input | Output | Costs money? |
|---|---|---|---|
| ① Import | A search, or a spreadsheet | `leads` + `organizations` rows | **Apollo credits** |
| ② Enrichment | A company website | A description we can write from | **Firecrawl + LLM** |
| ③ Campaign | A set of leads | A campaign with steps and a schedule | No |
| ④ Drafting | Lead + company + prompt | An email per lead per step | **LLM** |
| ⑤ Sending | Approved drafts | Real email in a real inbox | Instantly seat |
| ⑥ Replies | An inbound email | A thread, plus an AI-drafted response | **LLM**, on request |

---

## 2.3 Stage ① — Import

Two ways in:

- **Apollo search** (`/api/v1/leads/apollo-search`, `/company-search`,
  `/company-people`, `/company-import`) — search is free; **revealing a contact
  costs one credit each**, and an organisation search costs one credit per page.
  No individual filter field has its own cost. Because credits are real money,
  every Apollo-backed flow shows the `ApolloCostNote` component twice: once where
  you choose the count that drives the cost, and once immediately before the
  button that spends it.
- **Excel upload** (`/api/v1/leads/import-excel`) — free.

A lead lands as `leads.status = 'new'` and is attached to an `organizations` row.
Many leads share one organisation; the expensive research in stage ② is done
**once per organisation**, not once per lead. With 5,269 leads across 4,412
organisations today, that is a meaningful saving.

---

## 2.4 Stage ② — Enrichment

The purpose is one field: `organizations.company_description`. Without it, the
LLM has nothing specific to say and the email falls back to a generic template.

```
organization has a domain?
   │no                              │yes
   ▼                                ▼
unenrichable_leads          Firecrawl scrapes the site
(never retried — there is        │
 nothing to retry)               ▼
                          LLM reads the page and extracts
                          a description, industry, products
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
              got a description          got nothing usable
              status → 'enriched'        status → 'input_required'
```

`leads.status` runs `new → enriching → enriched | input_required`.
**`input_required` is not a failure.** It means "we could not learn anything, so
this lead gets the generic template instead of a personalised email." Those leads
still join campaigns and still get sent to.

Three details that took real incidents to get right:

- **A model that returns the literal string `"null"` is returning nothing.**
  `!!"null"` is `true` in JavaScript, so the word was being stored as a company
  description. `cleanExtracted()` in `app/api/enrich/scrape-orgs/route.ts` now maps
  `"null"`, `"N/A"` and `"unknown"` to a real `null`.
- **Retry only what a retry could fix.** A dead domain is free at Firecrawl (DNS
  never resolves) but a reachable 404 costs a credit. `RETRYABLE_STATUSES` lists
  the four failures worth another attempt; everything else is terminal.
- **Retry budgets differ by failure.** A scrape failure gets 3 attempts, an LLM
  extraction failure gets 2. Different causes, different odds of success.

---

## 2.5 Stage ③ — Campaign

A campaign is a set of leads, a **sequence of steps**, and a schedule.

- **Step 1** is the opening email: it has a subject.
- **Steps 2+** are follow-ups: their subject is **empty on purpose**, which is what
  makes Instantly thread them as replies under the original.
- Each step has a delay and a `delay_unit` (`days` normally; `minutes` works and is
  used for testing).
- Each step from 2 onward can carry its own `fallback_body` — the text to send when
  personalisation is impossible.

Leads may be added from either `enriched` **or** `input_required`. That is
deliberate: a lead we know nothing about still deserves the generic email.

**Fan-out.** On send, one campaign becomes **one Instantly sub-campaign per
country**, each with that country's timezone, so a lead in Peru is emailed at a
sensible local hour. `campaigns` (77 rows) → `instantly_campaigns` (221 rows).

**Hold sending.** A reversible, campaign-wide stop. Instantly has no per-step
pause, so a hold is an ordinary pause plus two facts a pause cannot carry: *who*
held it and *when*. Verified live on 29 Aug 2026 — a paused campaign held a queued
follow-up 14 minutes past its due time and sent nothing; re-activating released it
57 seconds later. **A hold delays mail; it never destroys it.** What is *not*
known is whether a hold can recall mail already handed to SMTP — do not promise
that it can.

---

## 2.6 Stage ④ — Drafting

For each lead and each step, the LLM writes an email. The prompt is assembled from
four sources, in this order of authority:

```
  system prompt   ← the house voice, structure, rules      (Settings)
+ company block   ← facts about Kuber Polyplast            (Settings)
+ product block   ← the product library                    (Settings)
+ NON_NEGOTIABLE  ← truthfulness rules that outrank all of the above  (CODE)
+ user prompt     ← this lead, this company, this step
```

Two things about that stack are worth memorising.

**A personal prompt REPLACES the system prompt.** If a rep has their own
`user_settings.draft_prompt`, `resolveDraftPrompt` returns it and the company
prompt is never read. That is why `NON_NEGOTIABLE_RULES` exists in code and is
appended to *every* tier — company, personal, and template alike. A rule that only
lives in the company system prompt does not reach the reps who wrote their own.
This is not theoretical: on 31 Aug 2026 a draft to a female prospect said "sir"
twice, because one rep's personal prompt contains that word. The fix went into
`NON_NEGOTIABLE_RULES` for exactly this reason.

**No org data means the template path**, not a failed draft:

```
hasOrgData ?  the LLM writes a personalised email  (source = 'ai')
           :  fill a template with the name        (source = 'template')
```

The `source` column is how the UI honestly reports "N personalised / N template".
It was wrong once — template drafts were labelled `'ai'` — which made the counter
flatter the system.

**Guards that stop bad output reaching a customer:**

| Guard | Catches |
|---|---|
| `MIN_BODY_CHARS` (120 opening / 60 follow-up) | An empty body saved as sendable — "Dear X," plus a signature |
| `looksLikeRefusal()` | The model refusing, e.g. inventing `NO_EMAIL_GENERATED:` |
| `stripLeadingGreeting()` | "Dear Steve, Hi Steve," when a template brings its own greeting |
| `stepNumber > 1 ? "" : signature` | A signature on a follow-up that threads under one already |

---

## 2.7 Stage ⑤ — Sending

Approved drafts are pushed into Instantly as **custom variables** on the lead
(`customBody`, `customBody2`, `customBody3`), and the sequence steps reference
those variables. Instantly renders and sends.

Two measured facts:

- **Instantly renders at SEND time.** An edit made while a follow-up is queued
  still reaches the recipient.
- **Throughput on this account is roughly one email every nine minutes**, and
  Instantly finishes one lead's whole sequence before starting the next.
  Measured 31 Aug 2026: 12 emails across 4 leads took 1 hour 44 minutes. This is
  not a published limit and it may change — but plan around "slow", not "instant".

Follow-up text is written by a nightly sweep (`write-followups`) on the **last
working day before it is due**, so a human has a full working day to change it.

---

## 2.8 Stage ⑥ — Replies

Instantly posts a webhook to `/api/v1/webhooks/instantly` on every send and every
reply. A 15-minute cron also syncs the Unibox, so a missed webhook self-heals.

An inbound reply becomes a `unibox_emails` row and a `reply_events` row. A
salesperson can then press **AI draft** — and *only* then. Drafting used to fire
automatically on webhook arrival and again whenever the composer opened; both were
removed. **Nothing spends LLM money until a human asks for it.**

---

## 2.9 What every stage has in common

Four patterns repeat. Recognise them once and the codebase gets much smaller:

1. **Everything expensive is logged.** `llm_usage` records tokens and cost for
   every LLM call, tagged with a `purpose` (`draft` / `followup` / `reply` /
   `enrichment` / `classify`). Unknown model pricing records **NULL, never 0** —
   a zero would silently understate the bill.
2. **Everything long is batched, and each batch calls the next.**
3. **Everything that can get stuck has a watchdog.** A ten-minute cron re-drives
   six different kinds of stalled work.
4. **Every degraded path has a named fallback**, and the fallback is recorded, not
   hidden — so "we sent boilerplate" is always visible and always upgradeable.

---

Next: [03-low-level-design.md](03-low-level-design.md) — how it is built.
