# Project Understanding — start here

Six documents that explain how Kuber works, written to be read **in order**. Each
one assumes you have read the one before it and nothing else.

Everything here was read out of the repository and the live Supabase database on
**31 August 2026**. Where a number appears (row counts, cron schedules, token
costs), it was measured, not estimated. Where something is genuinely uncertain,
it says so rather than guessing.

---

## The reading order

| # | Document | What question it answers | Read it when |
|---|---|---|---|
| 1 | [01-system-architecture.md](01-system-architecture.md) | What are the pieces and where does each one run? | First. Nothing else makes sense without it. |
| 2 | [02-high-level-design.md](02-high-level-design.md) | What does the product actually do, stage by stage? | After 1. This is the product, not the code. |
| 3 | [03-low-level-design.md](03-low-level-design.md) | How is each stage built, and why that way? | When you need to change code. |
| 4 | [04-database-schema.md](04-database-schema.md) | Which table holds what, and how do they join? | When you need to write a query or add a column. |
| 5 | [05-data-flows.md](05-data-flows.md) | What happens, in order, for one real lead? | When something broke and you need to trace it. |
| 6 | [06-cron-workers-and-scale.md](06-cron-workers-and-scale.md) | Why cron and not a worker? What breaks at 1000 users? | When you are planning capacity or a rewrite. |

**If you only have ten minutes:** open
[system-maps/kuber-system-maps.html](system-maps/kuber-system-maps.html) and
click through its four tabs. It covers the same ground as documents 1 to 3,
visually, and needs no server — just open the file.

**Reading instead?** Read §1 and §2 of document 1, then the single worked
example in document 5. That is enough to hold a conversation about the system.

---

## The interactive version

[system-maps/](system-maps/) holds the same material as four explorable
diagrams in one tabbed page — the system, the lead pipeline, the lead
lifecycle, and how a single email gets written. Its
[README](system-maps/README.md) covers how to share it, how to rebuild a map
after a change, and the two layout constraints that bite.

---

## How these six relate to each other

```
        01 ARCHITECTURE ──── the boxes: browser, API, database, providers
               │
               ├──► 02 HIGH LEVEL ──── the six stages a lead passes through
               │           │
               │           └──► 03 LOW LEVEL ──── how each stage is coded
               │                       │
               │                       └──► 05 DATA FLOWS ──── one lead, end to end
               │
               ├──► 04 DB SCHEMA ──── the tables all of the above read and write
               │
               └──► 06 CRON & SCALE ──── why the moving parts are scheduled this way
```

Documents 1, 2 and 4 are **reference** — come back to them. Documents 3, 5 and 6
are **explanation** — read once, properly, then skim later.

---

## What is deliberately NOT here

- **The UI.** Component rules live in `CLAUDE.md` at the repo root, and they are
  strict. Read that before touching anything in `components/`.
- **Incident write-ups.** Individual bugs and their root causes are in
  `docs/*-rca.md`. Those are history; these six are the current state.
- **The deep architecture reference.** `docs/system-architecture.md` (1,109 lines,
  inspected 13 Aug 2026) goes further than document 1 does on triggers, RPCs and
  locking. Document 1 is the map; that file is the survey.
- **API request/response shapes.** Read the route handlers. There are 108 of them
  and they change; a copy here would be wrong within a week.

---

## Two conventions used throughout

**Measured vs. assumed.** Anything stated as a fact was checked. "Instantly sends
about one email every nine minutes on this account" is a measurement from 31 Aug
2026, not a published limit — and it is labelled that way where it appears.

**Named files, not paraphrases.** Every claim points at the file that proves it,
as `lib/services/generate-drafts.ts`. If the doc and the file disagree, the file
is right and the doc is stale — fix the doc.
