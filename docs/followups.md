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
13-28 Aug       WINDOW 1 - instructions still change the outcome
29 Aug          the AI writes the follow-up (Friday - the last working day)
29-31 Aug       WINDOW 2 - read, edit or regenerate it
31 Aug          Instantly sends it (Monday), ~3 min after the hour
```

**Every lead has their own clock**, keyed off `campaign_leads.first_sent_at`.
Instantly drips a campaign out over days, so 100 leads sent across four days
produce four separate waves of writing — roughly 25 emails a day, never 100 at
once.

**Why not sooner** (`FOLLOWUP_LEAD_TIME_DAYS = 1`, a floor): writing at campaign
start would spend credits on leads who reply or bounce first (about a quarter of
them). Writing on the due day itself races Instantly, which may fire the step
before the text lands.

**Why not exactly one day** — changed 29 Aug 2026. A flat day of lead time
quietly assumed somebody is at a desk every day. A follow-up due Monday was
written **Sunday**, so the only chance to read it before the customer did fell on
a closed office, and by Monday morning Instantly is already sending.

`writeByAt()` now walks back to the last **working** day in IST (Mon-Fri, the
client's week):

```
due Tuesday    -> written from Monday    (one day, unchanged)
due Saturday   -> written from Friday
due Sunday     -> written from Friday
due Monday     -> written from Friday    (three days ahead, deliberately)
```

Three-day-old text is fine: company research does not change in three days.
Covered by `scripts/check-followup-write-day.mjs`, including the IST boundary a
UTC implementation gets wrong (04:00 IST Monday is 22:30 UTC Sunday).

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
(`customBody2`, `customBody3`, …). It never reads our database — it renders
whatever is stored on the lead at the time it sends.

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

### The review window problem, and what was decided

Emails are written one day before they send. For a Monday send that means they
are written **Sunday** — when the office is closed. The team arrives Monday at
10:15 and the 10:00 sending window has already started. **This happens every
week**, and worse over holidays.

Three levers were considered. **Kuber Polyplast works IST, Mon-Fri**, which is
what makes the weekend case the normal case rather than an edge one.

| | Lever | Decision |
|---|---|---|
| 1 | **Move the sending window start** from 10:00 to 11:00 or 12:00 IST | **Agreed.** Zero code — a campaign setting. Buys a review hour every morning, not just Mondays. Costs a couple of sending hours a day, which only matters near the daily cap, and we are not near it. Note it can be changed back by anyone, so it is a convention rather than a guarantee |
| 2 | **Write on the last WORKING day**, not simply one day before | **Agreed — the important one.** A Monday send is written Friday, giving Friday afternoon plus Monday morning. Emails are then up to 3 days old at send, which does not matter: company research does not change in three days. Must respect IST working days |
| 3 | **A "hold this step" stop button** | **Built, 29 Aug 2026.** Campaign-level, not per step — Instantly has no per-step pause. See §14 |

Levers 2 and 3 are now built. Lever 1 is still a per-campaign setting nobody has
changed, and see §14.4 for why a single review hour is harder than it looks on a
multi-country campaign.

### What Instantly can and cannot do about stopping

Verified against a dev campaign on 29 Aug 2026:

```
POST /api/v2/campaigns/{id}/pause      -> 200, status becomes 2 (paused)
POST /api/v2/campaigns/{id}/activate   -> 200, status becomes 1 (active)
```

**Pause works, but only for a WHOLE campaign.** There is no per-step pause, so
pausing to stop follow-up 2 also stops opening emails to brand-new leads in that
campaign.

Two things soften that:

- Campaigns are already fanned out into one Instantly sub-campaign per country
  per sender, so a pause can be aimed at a slice rather than everything.
- To delay one step without stopping anything, its `delay` can be pushed out —
  every unsent instance of that step moves later, and nothing else changes.

A per-step hold in our own UI would be built on one of those two.

### Knowing whether an email has actually gone out

The question this answers: **how do we avoid spending an AI call regenerating a
follow-up that Instantly has already sent?**

Two sources, and they are not equal:

| Source | Speed | Measured |
|---|---|---|
| `email_sent` webhook | Real time | **86.7%** of sends known within 60 seconds |
| `unibox-sync` cron | Every 15 min | Catches the rest |

Across 820 step-2 sends: 711 known within a minute, 85 within fifteen, 24 later
than that. So the synced copy is **usually** right and **occasionally** stale by
up to fifteen minutes — which is exactly the window in which someone regenerates
an email that has already left.

**The fix is not more syncing.** Instantly will answer the question directly:

```
GET /api/v2/leads/{id}
  -> status                              1 active, 2 paused, 3 completed
  -> status_summary.lastStep.stepID      "0_0_0" = opening email only
```

One call, real-time truth, no guessing. Verified live.

**Proposed rule:** a single-lead regenerate or edit checks Instantly first — one
cheap call to avoid wasting an AI call and to tell the user the truth. A bulk
regenerate keeps using the synced copy plus the existing already-sent guard,
because 25 live calls would hit Instantly's rate limit, which bites within a few
dozen requests.

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

**3. Write on the last working day (IST).** See the table above. Currently the
lead time is a flat one day, which lands the review window on a Sunday every
time a Monday send comes round.

**4. Live send-status check before a single-lead regenerate.** See above.

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

## 12. Answered live on 29 Aug 2026

Two questions that had blocked everything else were settled with a real send
against the client's own Instantly workspace, using the four test mailboxes.
Two campaigns, 15-minute step delays, `pushkar.garg@` as the sender. Both test
campaigns were deleted afterwards.

### 12.1 Instantly renders the text at SEND time, not queue time

| | |
|---|---|
| 01:54:37 | opening sent, follow-up now queued for 02:09:37 |
| 01:57:54 | `customBody2` changed while the follow-up sat queued |
| 02:12:39 | Instantly sent **the new text** |

Read straight from Instantly's own sent record:
`FOLLOW-UP TEXT = VERSION TWO (edited AFTER the opening went out).`

**A follow-up can be edited right up until it actually goes out.** There is no
earlier hidden deadline. This is what makes a review window before the sending
hour worth anything at all.

### 12.2 Pausing HOLDS a queued follow-up, and resuming releases it

| | Follow-ups due | Delivered | Late by |
|---|---:|---:|---|
| Running campaign (control) | 2 | 2 | ~3 min |
| Paused campaign | 1 | **0** | 12+ min and counting |

Then, on the paused one:

| | |
|---|---|
| 01:57:55 | paused |
| 02:10:44 | due — **nothing sent** |
| 02:24:11 | resumed, 14 minutes past due |
| 02:25:08 | **mail goes out, 57 seconds later** |

**A hold delays mail; it never destroys it.** That is what makes Hold safe to
offer to every user with no confirmation ceremony beyond the counts.

### 12.3 Two facts learned along the way

**Sends run about 3 minutes late.** Due 02:09:37, sent 02:12:39; due 02:18:38,
sent 02:21:39; the same on the third. A send *hour* is a window, not an instant,
so any cut-off promised to the client needs margin before it.

**Instantly never returns a lead's stored email text.** Neither `GET /leads/{id}`
nor `POST /leads/list` includes `custom_variables` — they come back empty even
for a lead whose opening email demonstrably rendered from them. We can see what
Instantly *sent*, never what it is *holding*. So our database can drift out of
sync with Instantly and no audit could ever detect it; the only defence is that
every path touching a follow-up calls `syncApprovedDraftToInstantly`.

**Instantly accepts `delay_unit: "minutes"`** and honours it. That is what made
this testable in 30 minutes instead of over two days.

### 12.4 Still not measured

Whether a hold applied *during* Instantly's own send pass stops a mail already
handed to the SMTP server. The pause here was applied ~13 minutes before the due
time. A mail in the final seconds of sending would presumably still go — treat
Hold as "stops everything not yet sent", not "recalls".

## 13. How to test this safely

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
node scripts/check-followup-write-day.mjs         writing on the last working day
node scripts/check-regen-step-targeting.mjs      which draft a bulk run rewrites
node scripts/check-fallback-reason.mjs           failure -> client-facing reason
node scripts/check-batch-budget.mjs              stopping before the lambda dies
node scripts/check-revision-intent.mjs           local vs whole-email edits
node scripts/check-product-emphasis.mjs          the product ends up in bold
node scripts/check-model-html.mjs                stray HTML from the model
```

## 14. Hold sending (built 29 Aug 2026)

### 14.1 What it is

One button that stops Instantly sending anything further on a campaign —
including follow-ups already queued — until a person resumes it. Proven in §12.2.

Mechanically it IS a campaign pause, because that is the only lever Instantly
offers. The hold adds the two facts a bare pause cannot carry: **who** stopped it
and **when**. Those drive the banner, and without them a held campaign is
indistinguishable from one somebody paused last week and forgot.

### 14.2 Where it lives, and why not on the step

**Top bar, next to the campaign name.** Visible on every tab.

It was originally drawn on the step rows inside the Sequences tab. That is
wrong: those rows sit to the right of the lead rail, so the button reads as
"hold this one lead" — which Instantly can never do. A control that stops the
whole campaign has to sit where nothing lead-shaped is next to it.

Once held, the button disappears and an **amber banner above the tab strip** owns
Resume. The banner is deliberately outside every tab body: a held campaign is
otherwise invisible, and silence looks exactly like working normally.

### 14.3 The rules it enforces

| Action | Rule |
|---|---|
| Regenerate **one** follow-up | Allowed any time. Asks Instantly directly first — see below |
| Regenerate **every** follow-up | **Refused unless sending is held.** `HOLD_REQUIRED` |
| Resume | Anyone. Clears the hold from either the banner or the campaign list |
| Auto-resume | **Never.** A hold that releases itself would send the very mail someone stopped, when nobody is watching |

**Why single-lead is different.** Our "already sent" knowledge arrives by
webhook, and measured across 820 real step-2 sends only 86.7% landed within a
minute — the rest took up to 15. Inside that gap the screen says "not sent" for
an email the customer is already reading; the user regenerates, gets a green
tick, and the change reaches nobody.

So a single-lead regenerate asks Instantly directly first
(`getInstantlyLeadSentStepIndex`, one HTTP call) and refuses with `ALREADY_SENT`
if it has gone. A hundred leads would be a hundred calls, so the bulk path
removes the race by holding sending instead of polling it.

### 14.4 What is NOT solved

**There is no single review hour on a multi-country campaign.** Campaigns fan
out into one Instantly sub-campaign per country, each on its own timezone — that
is deliberate and correct (see `docs/campaign-timezone-rca.md`). A follow-up step
set to 11:00 therefore fires at 11:00 *local to each recipient*: 11:00 IST for
Indian leads, 05:30 IST for Australian ones, 20:30 IST for American ones.

A reviewer in India reviewing 10:00-10:45 IST is ahead of the Indian sends and
behind the Australian ones. **Lever 1 protects the India bucket and nothing
else.** What actually protects every bucket is lever 2 (writing on the last
working day, so the text exists well before any timezone fires) plus Hold for
the "stop it now" case.

Do not promise the client "review between 10 and 11" as though it covered the
whole campaign. It covers their Indian leads.

### 14.5 Files

```
supabase/migrations/2026_08_29_campaign_sending_hold.sql   sending_held_at / _by
lib/services/campaign-lifecycle.ts                         holdSending(); resume clears the stamp
app/api/v1/campaigns/[id]/hold/route.ts                    POST hold  (resume reuses /resume)
lib/services/instantly.ts                                  getInstantlyLeadSentStepIndex()
lib/services/regenerate-draft.ts                           verifyNotSent -> ALREADY_SENT
app/api/v1/campaigns/[id]/regenerate-drafts/route.ts       HOLD_REQUIRED gate
components/app/hold-sending-modal.tsx                      the counts + confirm
components/app/campaign-drawer.tsx                         button, banner, bulk gate
```
