# Root Cause Analysis: Campaigns Sending in the Wrong Timezone

| | |
|---|---|
| **Issue** | Emails sent outside the recipient's working hours; some days no emails at all |
| **Reported by** | Client |
| **Date prepared** | 2026-08-13 |
| **Status** | Diagnosed — fix pending approval |
| **System** | Campaign fan-out & Instantly schedule sync |
| **Scope** | 141 of 148 Instantly sub-campaigns; 880 of 1,271 leads |

## 1. Summary

The client reported two problems a day apart:

1. Campaign 2 still had unsent leads while campaign 3 had already sent.
2. On 13 August, no emails had gone out at all.

Both are symptoms of one root cause: **every Instantly campaign is sending on New York office hours, regardless of where the lead actually lives.**

The campaign Options screen shows a sending window of 10:00 AM to 6:00 PM and labels it *"Local time of recipient."* It offers no timezone control, because the system is designed to resolve the timezone per country automatically. That resolution works correctly at send time — but it is silently overwritten every time anyone saves the Options screen.

As a result, 141 of the 148 sub-campaigns in Instantly are running on `America/Detroit` (US Eastern). Only about 11 of them should be. The remaining ~130 belong to leads in India, the UK, Germany, Australia, the UAE, South Africa and 30 other countries, all of whom are now receiving emails in their evening, overnight, or early hours.

No emails were lost or duplicated. Delivery is working. Only the *timing* is wrong.

## 2. Background: how campaign scheduling is supposed to work

A campaign in this system is a **master record** that fans out into multiple **Instantly sub-campaigns**, one per (country, sending mailbox) pair. This split exists for exactly one reason: **Instantly applies a sending window in a single timezone per campaign.** To give an Indian lead 10:00–18:00 IST and an American lead 10:00–18:00 ET, they must live in two different Instantly campaigns.

At send time, `lib/services/campaign-fanout.ts` does the following for each country bucket:

1. Groups the leads by country and sending mailbox.
2. Calls `pickTimezone()`, which resolves the bucket's timezone from:
   - the most common `time_zone` value on the leads themselves (supplied by Apollo), else
   - the country default from `COUNTRY_TO_TIMEZONE` in `lib/constants.ts`, else
   - the master campaign's `schedule_timezone` as a last-resort fallback (the variable is literally named `fallbackTz`).
3. Creates the Instantly sub-campaign with that timezone and the master's window and send days.

This produces sub-campaigns like `APOLLO CAMPAIGN 6_India_ankit.singh` on `Asia/Kolkata`, `..._Germany_...` on Central European Time, and `..._Australia_...` on Melbourne time.

**This part of the system has never been broken.** Our database still holds the correct timezone for all 141 sub-campaigns today.

## 3. Root Cause

Four steps, each individually reasonable, which together destroy the per-country schedule.

### 3.1 The Create Campaign screen auto-picks a timezone from the lead list

When a campaign is created, the modal inspects the leads, finds the most common country, and sets the campaign timezone from it.

```js
// components/app/create-campaign-modal.tsx:206-212
const country = getMostCommonCountry(leads);
const autoTz  = country ? (COUNTRY_TO_TIMEZONE[country] ?? "UTC") : "Asia/Kolkata";
setPrimaryCountry(country);
setTimezone(autoTz);
```

For the Apollo campaigns, the largest country group is the United States (391 leads), and `lib/constants.ts:386` maps:

```js
"United States": "America/New_York",
```

So every one of these campaigns was stamped `schedule_timezone = America/New_York` at creation. **Nobody chose this value.** It appears on the create screen only as small grey text ("Auto-detected: America/New_York") next to an optional "Override" link that nobody needed to click.

### 3.2 That value was only ever meant to be a fallback

`campaign-fanout.ts:110` reads it as `fallbackTz` and uses it only for leads whose country cannot be resolved (the `XX` bucket). Every lead with a known country receives its own timezone instead. The master value was never intended to reach Instantly for a known-country bucket.

### 3.3 The Options screen submits a timezone field it does not display

`EditCampaignForm` renders two layouts, `variant="page"` and `variant="modal"`. The page variant — the one in use, shown in the client's screenshot — deliberately has **no timezone control**; it just says "Local time of recipient." The modal variant still has one.

Both share a single save handler:

```js
// components/app/edit-campaign-modal.tsx:145-161
const result = await patchCampaignConfig(session.access_token, campaign.id, {
  daily_limit: dailyLimit,
  window_from: windowFrom,
  window_to: windowTo,
  schedule_timezone: timezone,      // ← always sent, never shown on this screen
  send_days: sendDays,
  sender_name: senderName || undefined,
  ai_prompt_context: aiPromptContext || undefined,
});
```

`timezone` is initialised on line 110 from `campaign.timezone` — i.e. `America/New_York`. So editing *only* the daily limit, or *only* a follow-up delay, re-submits New York. The user has no way to see this field, let alone prevent it.

### 3.4 The config sync copies that one timezone onto every country sub-campaign

`PATCH /api/v1/campaigns/[id]/config` persists the change, then pushes it to every Instantly sub-campaign:

```js
// app/api/v1/campaigns/[id]/config/route.ts:53-63
for (const sub of subs ?? []) {
  if (!sub.instantly_campaign_id) continue;
  await patchInstantlyCampaignConfig(sub.instantly_campaign_id, {
    name:       parsed.data.name,
    dailyLimit: parsed.data.daily_limit,
    windowFrom: parsed.data.window_from,
    windowTo:   parsed.data.window_to,
    timezone:   parsed.data.schedule_timezone,   // ← same value for India, Germany, Australia…
    sendDays:   parsed.data.send_days,
  });
}
```

Daily limit, window and send days *are* campaign-wide settings and correctly belong in this loop. **Timezone is the one setting that must not be shared**, because holding a distinct timezone is the sole reason these sub-campaigns exist.

One save, one loop, and 141 per-country timezones collapse into one.

### 3.5 Why Instantly shows "Detroit" rather than "New York"

Instantly's API only accepts timezones from a fixed enum, which excludes `America/New_York`. `lib/instantly-timezones.ts:41` maps it to the equivalent zone:

```js
"America/New_York": "America/Detroit",
```

Same UTC offset, same DST rules. The name difference is cosmetic and is *not* itself a bug — it is just why the symptom appears as "Detroit" when tracing it in the Instantly UI.

## 4. Evidence

### 4.1 Our database and Instantly disagree about the same campaign

```
Campaign:       APOLLO CAMPAIGN 6_India_ankit.singh

Our database:   timezone = Asia/Kolkata        ← correct, computed at send time
Instantly:      timezone = America/Detroit     ← overwritten by an Options save
Instantly UI:   "Sending window — local time of recipient"
```

### 4.2 Workspace-wide timezone distribution (Instantly v2 API, all pages)

| Timezone live in Instantly | Campaigns | Should be |
|---|---:|---|
| `America/Detroit` | 141 | ~11 (US & Canada buckets only) |
| `Asia/Kolkata` | 4 | correct — never edited |
| `America/Chicago` | 1 | correct — never edited |
| `Africa/Addis_Ababa` | 1 | correct — never edited |
| `Etc/GMT+12` | 1 | correct — never edited |
| **Total** | **148** | |

The seven survivors are campaigns whose Options screen was never saved after creation. This confirms the trigger is the Options save, not the send.

### 4.3 What the 10:00–18:00 window actually means per country

US Eastern 10:00–18:00 is 14:00–22:00 UTC.

| Recipient country | Leads | Arrives local time | Assessment |
|---|---:|---|---|
| United States | 391 | 10:00 – 18:00 | Correct |
| Canada | 23 | 10:00 – 18:00 | Correct |
| India | 161 | 19:30 – 03:30 | Evening and overnight |
| United Kingdom | 132 | 15:00 – 23:00 | Half after hours |
| Australia | 55 | 00:00 – 08:00 | Overnight |
| Germany | 49 | 16:00 – 00:00 | Evening |
| Netherlands | 35 | 16:00 – 00:00 | Evening |
| South Africa | 28 | 16:00 – 00:00 | Evening |
| Turkey | 28 | 17:00 – 01:00 | Evening and night |
| United Arab Emirates | 18 | 18:00 – 02:00 | Evening and night |
| ~30 other countries | ~350 | varies | Mistimed |

**414 leads (31%) are correctly timed. 880 leads (69%) are not.**

### 4.4 Daily send pattern

From Instantly's own analytics API:

| Date | Emails sent | When they landed (IST) |
|---|---:|---|
| 10 Aug | 92 | afternoon and late evening |
| 11 Aug | 50 | afternoon |
| 12 Aug | 101 | 50 of them between 19:00 and 20:00 |
| 13 Aug | 0 → 21 | nothing until 19:30, then ~1/min |

Sending only ever occurs while the New York window is open, which in IST is 19:30–03:30. The client checked at 15:00 IST on 13 August and correctly saw zero. Sending began at 19:30 IST as scheduled — on New York's schedule.

## 5. What was ruled out

### 5.1 Follow-ups consuming the daily limit

The initial theory was that follow-up emails were exhausting capacity before new leads could be reached. This is not the case here, though the underlying mechanic is real and worth understanding.

**How Instantly's limits actually work:**

- **Account daily limit** — the maximum a single mailbox may send per day, *across all campaigns*.
- **Campaign daily limit** — the maximum a single campaign may send per day, across all its mailboxes.
- Follow-ups count against **both** limits. There is no separate follow-up allowance.
- By default Instantly sends **all due follow-ups first**, then contacts new leads with whatever capacity remains.

So a day can legitimately produce zero new-lead emails if enough follow-ups are due. **But not this day.** Follow-up delays on these campaigns are 7 / 14 / 21 / 28 / 35 days, and first sends went out 7–12 August. The earliest follow-up is due 14 August. Zero were due on 13 August.

### 5.2 A failed mailbox or dead webhook

`ankit.singh@kuberpolyplast.com` is healthy: status active, warmup reputation 100, daily limit 100, no pending setup, no errors. The zero-send figure was confirmed directly against Instantly's analytics API rather than our dashboard, so a webhook or reporting gap is also excluded.

## 6. Contributing factors

These did not cause the incident but materially worsened its effect.

### 6.1 A single mailbox is carrying almost all sending

Three mailboxes exist, each rated 100 emails/day, for 300/day of capacity:

| Mailbox | Used by | Daily limit | Status |
|---|---|---:|---|
| `ankit.singh@kuberpolyplast.com` | Campaigns 2, 3, 4, 5, 6 | 100 | Saturated |
| `pushkar.garg@kuberpolyplast.com` | Campaign 1 (company default) | 100 | Light use |
| `ashish.sharma@kuberpolyplast.com` | — | 100 | **Unused** |

`pushkar.garg` is the company default in Settings; `ankit.singh` is Ankit's personal sending address, so every lead assigned to him routes there. Actual daily volume sits at ~92–101 regardless of campaign daily limits, because one mailbox's 100/day cap is the real ceiling. Roughly 200 emails/day of paid capacity is idle.

**Note on campaign limits:** setting five campaigns to 100/day each does not yield 500 emails/day. The mailbox limits are the true ceiling, shared across every campaign. Total daily throughput = number of mailboxes × per-mailbox limit, further divided by the number of steps in the sequence, since follow-ups consume the same budget.

### 6.2 Two campaigns have very narrow windows

| Campaign | Window | Duration |
|---|---|---|
| APOLLO CAMPAIGN 4 (200) | 10:00–12:00 | 2 hours |
| APOLLO CAMPAIGN 5 | 10:00–13:00 | 3 hours |
| APOLLO CAMPAIGN 3 | 10:00–16:00 | 6 hours |
| APOLLO CAMPAIGN 2, 6 | 10:00–18:00 | 8 hours |

Once every campaign is flattened to a single timezone, all of them open at the same instant and compete for the same mailbox, which has a 1-minute gap between sends. Campaigns with short windows lose that race and carry leads over to the next day. **This is the direct explanation for the client's first complaint** — campaign 2 holding leads while campaign 3 sent.

### 6.3 Minor inaccuracies in country → timezone mapping

Because Instantly accepts only a fixed timezone list, ours are mapped to the nearest permitted equivalent. Most are exact matches, but a few drift:

| Country | Mapped to | Offset | Correct offset |
|---|---|---|---|
| Thailand | `Asia/Rangoon` | UTC+6:30 | UTC+7 |
| Saudi Arabia, Kuwait | `Asia/Nicosia` | UTC+2/+3 (observes DST) | UTC+3 fixed |

Impact is under one hour and affects few leads, but worth correcting in the same pass.

## 7. Remediation plan

The core fix is a deletion. The timezone must not travel from the master campaign to its country sub-campaigns.

| # | Change | File | Type |
|---|---|---|---|
| 1 | Remove `schedule_timezone` from the Options save payload | `components/app/edit-campaign-modal.tsx:157` | Code |
| 2 | Remove `timezone` from the sub-campaign sync loop | `app/api/v1/campaigns/[id]/config/route.ts:61` | Code |
| 3 | Replay each sub-campaign's stored timezone back to Instantly | 141 live campaigns | Data repair |
| 4 | Widen campaign 4 and 5 sending windows | Campaign settings | Config |
| 5 | Assign leads to `ashish.sharma` mailbox | Lead assignment | Config |
| 6 | Correct Thailand / Saudi / Kuwait mappings | `lib/instantly-timezones.ts` | Code |

Items 1 and 2 stop the regression. Item 3 repairs the existing damage — because the correct timezones were never lost from our database, this is a straight replay with no recalculation and no risk to leads already mid-sequence.

Daily limit, window and send days should continue to sync to sub-campaigns as they do today; those genuinely are campaign-wide settings.

### 7.1 Verification after the fix

1. Confirm each sub-campaign's timezone in Instantly matches `instantly_campaigns.timezone` in our database.
2. Save the Options screen on one campaign and re-check the timezones are unchanged.
3. Confirm sending begins at the correct local hour per country over the following day.

## 8. Related defect in `patchInstantlyCampaignConfig()` — fixed

`patchInstantlyCampaignConfig()` in `lib/services/instantly.ts` rebuilt the entire `campaign_schedule` object whenever *any* of window-from, window-to, timezone or send-days was supplied. Fields not supplied serialised as `undefined`, were dropped from the JSON, and Instantly — which replaces `campaign_schedule` wholesale rather than deep-merging it — wiped them.

This was the mechanism that made §3.4 destructive rather than merely redundant, and it would have silently blanked send days or the window for any future partial-update caller.

**Fixed:** the function now patches top-level scalars (`name`, `daily_limit`) independently, and for schedule fields reads the current schedule back from Instantly and overlays only the named fields. A caller passing no schedule field never fetches and never sends `campaign_schedule` at all. The merge itself is a pure exported function, `mergeInstantlySchedule()`, covered by `lib/services/instantly-schedule.test.ts`.

## 9. Answers to the client's standing questions

**Do five campaigns at 100/day each send 500 emails per day?**
No. The campaign limit is a ceiling, not a target. The real constraint is the per-mailbox daily limit, shared across all campaigns. With the current setup — effectively one active mailbox at 100/day — total output is ~100/day no matter how the campaign limits are set. Reaching 500/day would require roughly 5 additional mailboxes.

**Are follow-ups counted inside the daily limit or separately?**
Inside. A follow-up consumes one slot exactly like a first email. There is no separate allowance, and Instantly sends due follow-ups *before* new leads by default. Practical consequence: with a 2-step sequence, new-lead reach is half of daily capacity; with 6 steps, roughly one sixth.

**Are campaigns processed one after another, or randomly?**
Neither. All active campaigns run concurrently and draw from the same mailbox pool. Instantly enforces a minimum gap between two sends from the same mailbox (currently 1 minute) and awards each free slot to whichever campaign is ready — meaning whichever campaign has due follow-ups and an open sending window. A campaign with a narrow window, or one whose window is closed in its timezone, sends nothing while its siblings send.

## 10. References

- `lib/services/campaign-fanout.ts` — country bucketing and `pickTimezone()`
- `lib/services/instantly.ts` — Instantly API client
- `lib/instantly-timezones.ts` — IANA → Instantly enum mapping
- `app/api/v1/campaigns/[id]/config/route.ts` — config sync to sub-campaigns
- `components/app/edit-campaign-modal.tsx` — Options screen
- `components/app/create-campaign-modal.tsx` — timezone auto-detection
- [Instantly: Account and Campaign Limits](https://help.instantly.ai/en/articles/6248612-account-and-campaign-limits)
- [Instantly: Prioritise new leads over follow-ups](https://help.instantly.ai/en/articles/6759494-prioritize-sending-emails-to-new-leads-over-follow-ups)

---

*Verified against the Instantly v2 API and the live Supabase database on 2026-08-13. Workspace: 148 campaigns, 1,271 campaign leads, 3 sending mailboxes.*
