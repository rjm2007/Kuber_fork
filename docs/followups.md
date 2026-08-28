# Follow-ups

Everything about how follow-up emails work, why they work that way, what is
still open, and what to be careful of. Written so this does not have to be
re-explained from scratch.

Last updated: 29 August 2026.

---

## 1. What a follow-up is here

A follow-up is a **short email sent to a lead who received our opening email and
did not reply**. It threads as a reply in the same conversation, so the original
message sits above it.

Two things make it different from the opening email:

- **It is written per lead, not per campaign.** 100 leads means 100 different
  follow-up 1 emails, each naming that company's own business.
- **It is never certified by a human.** Agreed with the client on 21 Aug 2026.
  Opening emails can wait for approval; follow-ups are auto-approved the moment
  they are written.

The client's requirement, in their words: follow-ups must be **short** and
**different for every company**.

---

## 2. The thing that causes the most confusion: step delays

**Instantly's `delay` on a step is the wait AFTER that step, before the next
one.** It is not "days from the first email".

So a ladder of `7 / 14 / 21` means:

```
step 1 sent          day 0
step 2 (follow-up 1) day 7      <- step 1's delay
step 3 (follow-up 2) day 21     <- + step 2's delay
step 4 (follow-up 3) day 42     <- + step 3's delay
```

This was verified against 814 real sends across 10 campaigns: the gap between
step 1 and step 2 always equalled **step 1's** delay, never step 2's (delay 11 →
10.8 days measured, delay 7 → 6.9, delay 30 → 29.7).

**What went wrong because of this.** The client entered `7 / 14 / 21 / 27 / 35`
meaning "days from the first email". Instantly stacked them, so an intended
35-day sequence ran **104 days**, and follow-up 2 was scheduled for day 21
instead of day 14. Nobody received a follow-up 2 for weeks.

**Fixed** by converting every campaign's numbers from cumulative to gaps, which
preserves the intended landing days exactly. And the composer now shows the
landing day (`day 7`, `day 14`, `day 21`) beside each row as you type, so the
two readings can no longer be confused.

---

## 3. When things happen

For a lead whose opening email went out on 12 August, on a seven-day ladder:

```
12 Aug          opening email sent   (this lead's clock starts here)
13-29 Aug       WINDOW 1 - instructions still change the outcome
30 Aug 07:30    the AI writes the follow-up
30-31 Aug       WINDOW 2 - read, edit or regenerate it
31 Aug          Instantly sends it; frozen from here
```

**Every lead has their own clock**, keyed off `campaign_leads.first_sent_at`.
Instantly drips a campaign out over days, so 100 leads sent across four days
produce four separate waves of writing — roughly 25 emails a day, never 100 at
once.

**Why one day ahead** (`FOLLOWUP_LEAD_TIME_DAYS = 1`): writing at campaign start
would spend credits on leads who reply or bounce first (about a quarter of
them). Writing on the due day itself races Instantly, which may fire the step
before the text lands.

---

## 4. How the pieces fit

### Scheduling

| Trigger | Cadence | Role |
|---|---|---|
| `write-followups` pg_cron | `0 2 * * *` (07:30 IST) | The one officially responsible |
| Self-chain | Immediately after each batch | Does the actual bulk of the work |
| `enrichment-watchdog` | Every 10 min | Safety net if the other two stop |

All three call `POST /api/internal/write-followups`. It is **safe to run
twice**: the sweep skips any `(campaign, lead, step)` that already has a draft,
so a double fire writes nothing again and cannot double-spend credits.

A pass with nothing due costs a handful of database reads — **no LLM tokens, no
Apollo credits**.

### The main files

| File | Role |
|---|---|
| `lib/services/followup-schedule.ts` | Due-date maths and the sweep that finds work |
| `lib/services/write-followups.ts` | The worker: generate, push to Instantly, upgrade templates |
| `lib/services/followup-instruction.ts` | Resolves campaign + step guidance |
| `lib/services/sequence-publish.ts` | Prepare-then-publish (see §7) |
| `lib/services/sequence-drift.ts` | Nightly check that Instantly still agrees with us |
| `app/api/internal/write-followups/route.ts` | Entry point, self-chain, tenant guard |
| `components/app/campaign-drawer.tsx` | The Sequences tab |

### Database

| Column | Purpose |
|---|---|
| `email_drafts.step_number` | 1 = opening email, 2+ = follow-ups |
| `email_drafts.source` | `ai` or `template` |
| `email_drafts.attempts` | Retry counter, caps a hopeless lead |
| `email_drafts.fallback_reason` | Why it fell back, in the client's words |
| `campaigns.followup_instruction` | Extra guidance for every follow-up |
| `campaign_steps.ai_instruction` | Extra guidance for one step |
| `campaigns.sequence_publish_pending` | A timing change is waiting for its text |

---

## 5. Instantly keeps its own copy — remember this one

Instantly stores each lead's follow-up text in a **custom variable**
(`customBody2`, `customBody3`, …) and **reads it only once, when the lead is
added to the campaign.**

So writing or editing a draft in our database changes nothing about what the
customer receives unless we **push** it. Every path that touches a follow-up
body must call `syncApprovedDraftToInstantly`.

This has caused three separate bugs. If a follow-up looks correct in the UI but
the customer got something else, this is almost always why.

A related trap: the sync rebuilds Instantly's variables from **approved** drafts
only. Anything that demotes a follow-up to `draft` silently removes it from that
set, and Instantly falls back to its own generic string.

---

## 6. The template safety net

When the AI cannot write a follow-up, something still has to send.

```
attempt 1 fails -> attempt 2 fails -> write the company's fallback text
                                      as a REAL draft, labelled `template`,
                                      with a plain-English reason
                                      |
                   credits return ->  upgraded to a personalised email,
                                      but ONLY if Instantly has not sent it
```

**Two attempts, not one.** The common failure is a momentary blip; giving up on
the first would send boilerplate over something that clears in a second.

**Why it is a real draft row** rather than leaning on Instantly's own fallback:
that fallback is invisible. Nothing in our database would record that a customer
got boilerplate, so nobody could answer "how many of my leads actually got a
personalised email?" — which is the product.

**Why the upgrade only touches unsent emails.** Rewriting after delivery reaches
nobody and destroys the evidence that a customer received boilerplate.

**The upgrade waits on a signal, not a timer.** It only runs when a healthy LLM
key exists, so a dead wallet costs zero calls however often the sweep runs.

The fallback text itself is editable at **Settings → AI & Outreach → Follow-up
fallback**.

---

## 7. Prepare, then publish

Changing a follow-up delay used to patch Instantly in the same request.
Instantly acts within seconds; writing a few hundred follow-ups takes about an
hour. So moving a date forward made every affected lead newly overdue, and
Instantly sent its generic fallback to all of them before one real email existed.

Now:

1. The change saves to our database.
2. **Instantly is left on the OLD schedule** and keeps doing what it was doing.
3. The text is written.
4. Only then is Instantly patched.

A campaign waiting in that state is the safe place to be: **late is
recoverable, boilerplate to three hundred customers is not.**

If nothing is unwritten, it publishes immediately — no artificial delay for the
common case of editing wording or adding a step.

---

## 8. The Sequences tab

Laid out like Outbox: leads on the left, the selected lead's follow-ups on the
right.

- **All leads are listed**, including replied and bounced, labelled and greyed.
  They are excluded from every count, because counts describe work and a
  finished lead is not work.
- **Badges are per follow-up, not per lead.** One lead can have follow-up 1
  written by the model and follow-up 3 fall back to the template.
- The rail shows what is genuinely lead-level: `2 of 5 sent`, plus an amber dot
  when a template actually reached that person.
- Each card shows the day it lands, whether it is sent, and — before it is
  written — the date it will be written and that an instruction added before
  then will be used.
- **Editing** an unsent follow-up is allowed and pushes to Instantly.
  **Regenerate** asks for an instruction first rather than firing blindly.

---

## 9. Decisions already made (do not re-litigate)

| Question | Decision |
|---|---|
| Retries before the template | **2** |
| Auto-upgrade a template later? | **Yes if unsent, never if sent** — no setting, decided by the situation |
| Hand-edited emails — mark them? | **No.** They still count as personalised |
| Replied / bounced leads in the list | **Dimmed in place**, not moved or hidden |
| "Write it now" (generate ahead of schedule) | **Not built.** Spends a credit early on a lead who may reply first |
| Bold section headings in the opening email | **Keep.** The client's own template asks for them |
| Instruction editable until when? | **Until the last lead's follow-up is written**, not when the first one is |

---

## 10. Open questions and pending work

### Pending, agreed, not yet built

**1. Show all three groups when saving an instruction.**
At any moment there are three, and the message names only two:

```
already sent        untouchable
written, not sent   INVISIBLE today - needs Regenerate to pick up the change
not written yet     will use the new instruction
```

Someone changing an instruction is never told about the middle group, so they
never learn Regenerate is needed for it.

**2. Per-run instruction snapshot.**
The instruction is currently read **before every email**, so a change mid-batch
splits it: 5 emails with the old wording, 20 with the new, and no way to see
where the line fell.

Read it **once when a run starts** instead. One batch, one wording — explainable
and predictable. It is also *cheaper* than today: about 4 database reads per
batch instead of 25.

Residual case: a "run" is one server invocation writing about 6 emails, so a
change made during a run lands at a run boundary. Worst case a day's batch
splits roughly in half rather than anywhere.

### Open — needs a decision

**A hard "whole day is always identical" guarantee.** Possible, but needs a
stored snapshot per batch and logic for when a batch begins and ends. Only worth
building if the residual case above actually matters.

### Blocked on the client / senior

- Whether follow-ups should ever carry an attachment.
- Whether the opening email's bold section headings stay long-term (§9 says keep
  for now, but the client's own prompt contradicts itself: it says "never bold
  whole sentences" and then supplies a template full of bold headings).

---

## 11. Traps that have already bitten

Each of these cost real time or real emails. They are fixed, but the shape of
the mistake is worth remembering.

**Supabase caps every query at 1000 rows.** A bigger `.limit()` is silently
clamped, not honoured. The "already sent?" guard read 1000 of 1788 rows and
rewrote 202 follow-ups Instantly had already delivered — about 680 wasted AI
calls over three days. Both lookups now page with `.range()`. **There is no
limit value that works; the ceiling belongs to the server.**

**`campaign_leads.draft_id` is one-to-one and points at the opening email.**
Embedding `email_drafts(...)` through it returns exactly one draft per lead, so
every follow-up arrived as "not written" — no body, no badge, no buttons — even
when it existed. Follow-ups must be fetched by `(campaign, lead)`. This bit
twice, in two different files.

**A follow-up is always `approved`.** Regeneration passed the campaign's
`human_in_loop` setting, so regenerating a follow-up on a human-in-the-loop
campaign quietly demoted it to `draft`, dropped it out of the Instantly sync,
and the customer received boilerplate while the UI showed the personalised text.

**Failed drafts blocked their own retry.** The sweep treated a `failed` row as
"written", so one bad LLM call stranded that lead permanently.

**Two workers racing is normal, not an error.** The self-chain overlapping the
10-minute watchdog means two invocations reach the same lead. The unique
constraint stops the duplicate — but the loser used to record a *failure* for
work that had just succeeded.

**A lost reason is a lost afternoon.** `recordUnattemptedFailure` accepted a
`reason` argument and wrote it only to the activity log, never to the draft row,
so every failure showed blank in the UI and needed a join against `lead_events`
to diagnose.

---

## 12. How to test this safely

**Never run an unscoped sweep from a developer machine.** Local dev points at
the same Supabase *and* the same Instantly workspace as production. On 25 Aug
2026 a local test wrote 6 follow-ups into the client's live APOLLO CAMPAIGN 2
and pushed all 6 to Instantly. The route now refuses an unscoped run outside
production — pass `company_id` to name the tenant you mean.

```
dev company     00000000-0000-0000-0000-00000000000a
client company  00000000-0000-0000-0000-00000000000b
```

**API keys are per company** in Settings → Keys, and every generation path uses
a company-scoped client. **But there is an environment-variable fallback tier
that is shared**, and when a company's own keys are dead, its work silently runs
on that shared key. Check `provider_keys.last_used_at` — if it stays null while
generation succeeds, the env key is doing the work.

**Runnable checks** (no framework, plain node):

```
node scripts/check-followup-due-dates.mjs        due-date arithmetic
node scripts/check-followup-schedule-preview.mjs the day each step lands on
node scripts/check-regen-step-targeting.mjs      which draft a bulk run rewrites
node scripts/check-fallback-reason.mjs           failure -> client-facing reason
node scripts/check-batch-budget.mjs              stopping before the lambda dies
node scripts/check-revision-intent.mjs           local vs whole-email edits
node scripts/check-product-emphasis.mjs          the product ends up in bold
node scripts/check-model-html.mjs                stray HTML from the model
```
