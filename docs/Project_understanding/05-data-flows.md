# 5 · Data flows

*What happens, in order, for one real lead?*

The main example below is a **real run from 31 August 2026** — real leads, real
emails, real reply. Every timestamp and every row is measured, not illustrative.

---

## 5.1 The worked example: Heena, end to end

**Setup.** Campaign `ZZ-E2E`, dev company, four leads, three steps.
Heena Mehta, `heenam561@gmail.com`, at organisation "Kailos" — which *has* a
`company_description`, so she takes the **AI path**.

---

### 01:51:14 IST — the draft is written

Trigger: `POST /api/enrich/generate-drafts { campaign_id }` with
`x-internal-secret`.

```
fetchDraftTargets(cdb, campaignId, 10, stepNumber=1)
  → returns Heena among 4 targets

generateOneDraft():
  org = unwrapOrg(lead.organizations)
  hasOrgData = !!org?.company_description?.trim()      → TRUE, so the AI path

  systemPrompt = resolveDraftSystemPrompt(db, ownerId, 1)
               + buildCompanyBlock(companyContext)
               + buildProductReferenceBlock(products)
               + NON_NEGOTIABLE_RULES
  userPrompt   = buildUserPrompt(lead, campaignName, …)

  complete(opts, companyId, { purpose: "draft", campaignId, leadId })
```

**Rows written:**

```
email_drafts   step_number=1  status='draft'  source='ai'  version=1
llm_usage      purpose='draft'  model=claude-sonnet-4-6
               in=2333  out=363  cost_usd=0.012444  duration_ms=11292
```

The other two no-data leads produced `source='template'` drafts and **no
`llm_usage` row at all** — the template path spends nothing, so it logs nothing.

---

### 01:52:42 IST — the send

`POST /api/v1/campaigns/{id}/send` → `sendCampaign()`.

The eligibility filter is the thing people trip over:

```ts
.eq("campaign_id", campaignId)
.eq("crm_status", "approved")        // ← the LEAD, not the draft
.is("instantly_campaign_id", null)   // ← not already pushed
```

Approving the *drafts* is not enough. On the first attempt this returned
`{ buckets: 0, sent: 0 }` because `campaign_leads.crm_status` was still
`'enriched'`. Two different state machines, two different transitions.

Then fan-out: leads are bucketed by country, and each bucket becomes an Instantly
sub-campaign with that country's timezone.

```
instantly_campaigns
  id                    = 3f189177-…      ← OURS
  instantly_campaign_id = b33c58fd-…      ← INSTANTLY'S
  country = India   timezone = Asia/Kolkata
  sender_email = pushkar.garg@kuberpolyplast.com
  status = active   activated_at = 20:22:41Z

campaign_leads (×4)
  instantly_campaign_id = 3f189177-…      ← our row id, NOT Instantly's
  instantly_lead_id     = 01a05456-…
```

> Look at those two ids again. `campaign_leads.instantly_campaign_id` points at
> **our** row. Querying Instantly with it returns a confident
> `404 Campaign not found`.

The draft bodies go to Instantly as custom variables on the lead:

```json
{ "customBody":  "<p>Dear Heena,…",     // step 1
  "customBody2": "<p>Hi Heena,…",       // step 2
  "customBody3": "<p>Hi Heena,…" }      // step 3
```

and the sequence steps just reference `{{customBody}}`, `{{customBody2}}`, …

---

### 01:54–01:56 IST — the follow-ups are written

`POST /api/internal/write-followups` → `writeDueFollowups()`.

```
findFollowupsToWrite(db, { limit, now, companyId })
  dueAt      = first_sent_at + cumulative step delays
  writeByAt  = dueAt − 1 lead day, walked back to a working day
  isDueForWriting = now >= writeByAt
```

That "walk back to a working day" is a product decision: follow-ups are written on
the **last working day before they are due**, so a human has a full working day to
change them before anything sends.

Heena has org data, so both follow-ups took the AI path:

```
llm_usage  purpose='followup'  in=2017 out=121  $0.007866
llm_usage  purpose='followup'  in=2017 out=108  $0.007671
```

The two no-data leads took the **fallback ladder** instead, and this is the part
worth reading closely:

```
step 2 → campaign_steps.fallback_body       (tier 1: this campaign's own text)
step 3 → settings.followup_fallback_body    (tier 2: the install-wide default)
```

Output for `chaudharydivyansh04@gmail.com`:

```
step2 [approved/template] subj=""  196ch
  Dear Devyansh,
  Circling back on my note. We are running a 10% introductory rate on first
  orders this quarter, and I did not want you to miss it.
  Happy to send grades and samples if it is useful.

step3 [approved/template] subj=""  277ch
  Dear Devyansh,
  Just following up on my earlier note about Kuber Polyplast's masterbatch…
```

Three things to notice:

1. **`subj=""`** — empty on purpose, so Instantly threads it as a reply.
2. **The greeting is replaced, not doubled.** The stored fallback text starts
   `Hi {{first_name}},`; `stripLeadingGreeting()` removed it and
   `generate-drafts` prepended `Dear Devyansh,`.
3. **No signature.** A follow-up threads under a message whose signature is already
   visible. This was a real bug — the template path appended one while the AI path
   correctly did not, so the *same lead* got a signature only if it fell back.

---

### 01:56 → 03:36 IST — Instantly delivers

```
01:56:30  heena     step 1
02:05:31  heena     step 2      ← 9 minutes later
02:14:32  heena     step 3      ← 9 minutes later
02:23:33  lakshit   step 1      ← 9 minutes after heena finished
…
03:36     all 12 sent
```

**Measured: about one email every nine minutes**, and Instantly finishes one
lead's whole sequence before starting the next (it prioritises follow-ups over new
leads). 12 emails took 1 hour 44 minutes. Plan around "slow".

Each send fires a webhook → `POST /api/v1/webhooks/instantly` → a
`unibox_emails` row with `direction='sent_campaign'` and `step='0_0_0'`,
`'0_1_0'`, `'0_2_0'`.

---

### 02:37:45 IST — the reply

Heena replies: *"yes can you please share the price of masterbatch"*.

```
unibox_emails   direction='received'  from=heenam561@gmail.com  step='0_2_0'
reply_events    event_type='reply_received'   → then 'lead_interested'
```

A 15-minute Unibox sync cron covers a webhook that never arrives, so this
self-heals.

---

### 03:02:54 IST — the AI reply, on request only

A human presses **AI draft**. Nothing before that moment spends money — automatic
drafting on webhook arrival was deliberately removed.

```
POST /api/v1/reply-drafts/generate { thread_id }
  → newest inbound message for the thread
  → assertThreadAccess()
  → replyEventId must exist (reply_drafts.reply_event_id is NOT NULL)
  → generateReplyDraft()

reply_drafts  version=1  status='draft'  company_id=…000a
llm_usage     purpose='reply'  in=2768 out=211  $0.011469
```

The output asked the three qualifying questions a real rep would ask (type, polymer
carrier, quantity) rather than inventing a price — which is `NON_NEGOTIABLE_RULES`
doing its job.

---

### The bill for the whole run

```
purpose    calls   cost
draft        2     $0.031128
followup     4     $0.031203
reply        1     $0.011469
             ─────────────────
             7     $0.073800   ≈ ₹6.50
```

Six template generations cost nothing and logged nothing.

---

## 5.2 Flow: enrichment, for one organisation

```
lead imported, organizations.company_description IS NULL
        │
        ▼
  has a domain?
   no │        │ yes
      ▼        ▼
unenrichable   Firecrawl scrape
_leads             │
(terminal,    ┌────┴─────┐
 no retry)    ▼          ▼
          reachable   DNS fails
          1 credit    free
              │
              ▼
      LLM extraction → cleanExtracted() maps "null"/"N/A"/"unknown" → null
              │
      ┌───────┴────────┐
      ▼                ▼
 description       nothing usable
 status=enriched   status=input_required
                        │
                   still joins campaigns,
                   gets the template path
```

**Firecrawl bills for reaching a site, not for useful content.** A dead domain is
free; a reachable 404 costs a credit. That is why the no-domain check comes first.

---

## 5.3 Flow: what happens when a key runs dry

```
generate-drafts route
   │
   ├─ hasUsableLlmKey(db, companyId)?
   │      no → return BEFORE fetchDraftTargets
   │           (bailing out later would touch leads and leave them half-done)
   │           logLlmUnavailable() → the service-health banner turns on
   │
   └─ yes → draft
             │ a call fails hard
             ▼
        key → status='cooling_off', cooling_off_until = now + backoff
        getActiveKey(exclude: {thatKey}) → next key by priority
             │ none left
             ▼
        follow-ups fall to the template ladder, marked source='template'
             │
             ▼
        credits come back
             │
        upgradeTemplateFollowups() rewrites the placeholders — but ONLY
        those Instantly has not yet sent. Once the customer has the
        boilerplate, rewriting our copy reaches nobody and only destroys
        the evidence that they got boilerplate.
```

`logLlmRecovered()` clears the banner as soon as a draft succeeds again.

**A known cosmetic wrinkle:** the upgrade pass reports `failed: N` for leads that
have no org data. Those genuinely cannot be upgraded — they re-take the template
path every sweep. It costs nothing (no LLM call) but the counter reads as an
error when it is not.

---

## 5.4 How to trace any problem

| Symptom | Look at, in this order |
|---|---|
| No email arrived | `campaign_leads.crm_status` → `instantly_campaigns.status` → `unibox_emails` for that campaign → Instantly's own send rate |
| Draft is generic when it should be personal | `organizations.company_description` → `email_drafts.source` |
| Follow-up says the wrong thing | `campaign_steps.fallback_body` → `settings.followup_fallback_body` → the built-in |
| Cost looks wrong | `llm_usage` grouped by `purpose`; check `count(*) filter (where cost_usd is null)` |
| A reply did not appear | `unibox_emails` → `reply_events` → was the webhook registered? (a new ngrok URL must be re-registered with Instantly) |
| Something is stuck | `enrichment_logs`, then wait ten minutes for the watchdog |

---

Next: [06-cron-workers-and-scale.md](06-cron-workers-and-scale.md) — why it is
scheduled this way, and what breaks at 1000 users.
