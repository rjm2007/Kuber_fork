# 4 · Database schema

*Which table holds what, and how do they join?*

42 tables in `public`. Row counts are live estimates from **31 August 2026** —
they tell you which tables are hot, which is usually what you actually need to
know.

---

## 4.1 The shape of the whole thing

```
                    companies (2)
                        │  company_id is on almost every table below
        ┌───────────────┼───────────────────────────────┐
        ▼               ▼                               ▼
 organizations    profiles (10)                    settings (65)
    (4,412)       user_settings (7)                provider_keys (13)
        │         user_signatures                  assignment_settings
        │ organization_id
        ▼
     leads (5,269)
        │
        │ lead_id
        ▼
 campaign_leads (1,740) ──────► campaigns (77) ──────► campaign_steps (285)
        │      │                     │
        │      │                     └──► instantly_campaigns (221)
        │      │                            one per country per campaign
        │      ▼
        │  email_drafts (8,708)
        │      one per lead per step, versioned
        ▼
  reply_events (2,688) ◄─────── unibox_emails (2,427)
        │
        ▼
  reply_drafts (30)
```

---

## 4.2 The tables you will actually touch

### `leads` — 5,269 rows, 34 columns

One person at one company.

| Column | Notes |
|---|---|
| `email` | **Unique per company** where `is_deleted = false` — see the index below |
| `organization_id` | → `organizations`. Many leads share one. |
| `status` | `new → enriching → enriched \| input_required`, plus `open`, `closed` |
| `assigned_to` | A bare `uuid`, **no foreign key**. Users live in `auth.users`, which nothing in `public` references. |
| `is_deleted` | Soft delete. Every query must filter on it. |

```sql
CREATE UNIQUE INDEX leads_company_lower_email_active_uidx
  ON leads (company_id, lower(email))
  WHERE is_deleted = false AND email IS NOT NULL;
```

That partial index is why you cannot insert a second live row for the same address
in one company — and why re-importing a deleted lead works.

### `organizations` — 4,412 rows, 26 columns

The company, and where enrichment output lands.

| Column | Notes |
|---|---|
| `company_description` | **The single most important field in the system.** Empty → the lead takes the template path in drafting. |
| `domain` | No domain → `unenrichable_leads`, never retried |
| `scraped_at` | Use **this**, not `updated_at`, to count real scrapes. Using `updated_at` once produced a 5× overcount (1,536 claimed vs 282 actual). |

### `campaigns` — 77 rows, 44 columns

| Column | Notes |
|---|---|
| `status` | `draft` / `processing` / `active` / `paused` |
| `sending_held_at`, `sending_held_by` | Hold sending. `status` stays `paused`; these two distinguish "held for review" from "paused last week and forgotten". |
| `human_in_loop` | Whether drafts need approval before send |
| `ai_prompt_context` | Standing instruction for every draft in this campaign |
| `followup_instruction` | Standing instruction for follow-ups only |
| `schedule_timezone`, `window_from/to`, `send_days` | The sending schedule |

### `campaign_steps` — 285 rows

| Column | Notes |
|---|---|
| `step_order` | 1 = opening (has a subject), 2+ = follow-ups (**subject empty on purpose**, so they thread) |
| `delay`, `delay_unit` | `days` normally; `minutes` works and is used for testing |
| `fallback_body` | Tier 1 of the fallback ladder. NULL means inherit from Settings. |

### `campaign_leads` — 1,740 rows

The join between a lead and a campaign, and the **state machine of the send**.

| Column | Notes |
|---|---|
| `crm_status` | `new → enriching → enriched → draft → draft_ready → approved → sent → replied → won \| closed \| skipped \| failed` |
| `first_sent_at` | Set by the **Instantly webhook**, not by us. All follow-up due dates are computed from it. |
| `instantly_campaign_id` | ⚠️ **Our `instantly_campaigns.id`, NOT Instantly's id.** Instantly's own id is `instantly_campaigns.instantly_campaign_id`. This has cost debugging time — a lookup with the wrong one returns a confident 404. |
| `instantly_lead_id` | Instantly's id for the lead |

Only `crm_status = 'approved'` leads are eligible for fan-out. Approving a *draft*
does not move the *lead* — they are separate transitions.

### `email_drafts` — 8,708 rows

| Column | Notes |
|---|---|
| `step_number` | Which step this draft is for |
| `version` | Versioned; the highest version per (lead, step) is the active one |
| `status` | `draft` / `approved` / `rejected` / `failed` |
| `source` | `'ai'` or `'template'` — drives the honest "N personalised / N template" counter |
| `attempts` | Retry counter, capped by `MAX_TOTAL_ATTEMPTS` |

### `llm_usage` — 188 rows

Every LLM call. This is how the client's AI spend is answered.

| Column | Notes |
|---|---|
| `purpose` | `draft` / `followup` / `reply` / `enrichment` / `classify` / `other` |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | |
| `cost_usd` | **NULL for an unknown model, never 0** |
| `campaign_id`, `lead_id`, `draft_id` | So waste is attributable, not just visible |

Template-path drafts make no LLM call and therefore write no row. That is correct,
not a gap.

### `unibox_emails` (2,427) · `reply_events` (2,688) · `reply_drafts` (30)

- `unibox_emails` — every message, both directions. `direction` is
  `sent_campaign` / `received`. `step` looks like `"0_2_0"`; the middle number is
  the zero-based step index.
- `reply_events` — the campaign-attributed view of a reply. `reply_drafts.reply_event_id`
  is **NOT NULL**, so an AI reply cannot exist until the reply is attributed.
- `reply_drafts` — the AI's suggested response, versioned like `email_drafts`.
  It is the **only table with an RLS policy** (1). Everything else relies on
  application-level scoping.

### `provider_keys` — 13 rows

| Column | Notes |
|---|---|
| `secret_vault_id` | → `supabase_vault`. The secret is **never** in this table. |
| `status` | `healthy` / `cooling_off` / `dead` |
| `priority` | Lower wins. Then `created_at` ascending. |
| `company_id` | LLM keys are per company; Instantly and Apollo are resolved with scope `"any"` |

RLS on, **zero policies** — only the service role can read it. That is deliberate.

### `settings` — 65 rows

Key/value per company. `(key, company_id)` is unique.

| Key | What it holds |
|---|---|
| `system_prompt` | The house voice. 15,434 chars. |
| `followup_fallback_body` | Tier 2 of the fallback ladder |
| `company_context`, `product_offerings` | Facts the LLM may use |
| `reply_drafter_prompt`, `reply_classifier_prompt` | The reply side |
| `*_backup_YYYY_MM_DD` | **Manual backups. There is no audit trail on this table** — if you overwrite a setting, the old value is gone. Always write a backup key first. |

---

## 4.3 Five schema facts that are not obvious

**1. Actor columns have no foreign keys.** `leads.assigned_to`,
`campaigns.sending_held_by`, `unibox_emails.sent_by` are bare `uuid`s. Users live
in `auth.users`, which nothing in `public` references. Join manually; expect
orphans.

**2. RLS is on everywhere and does almost nothing.** 41 of 42 tables have zero
policies, and the server uses the service-role key which bypasses RLS regardless.
**Tenant isolation is application code** (`lib/supabase/scoped.ts`), not the
database. If you bypass the scoped client, you bypass isolation.

**3. PostgREST caps every response at 1000 rows.** Silently. See §3.6 of document 3.

**4. A batch insert must have identical keys on every row.** PostgREST returns
`PGRST102 All object keys must match` otherwise. Pass `fallback_body: null`
explicitly on step 1 rather than omitting it.

**5. `tmp_*` and `backup_*` tables are scratch.** `tmp_f`, `tmp_q`, `tmp_q2`,
`tmp_rounds`, `tmp_regen_baseline` and the `backup_20260817_*` set are leftovers
from analysis work. They have RLS off. Nothing reads them.

---

## 4.4 Queries worth keeping

```sql
-- What has the AI cost, by purpose, this month?
select purpose, count(*) as calls,
       sum(input_tokens) as in_tok, sum(output_tokens) as out_tok,
       round(sum(cost_usd)::numeric, 4) as usd,
       count(*) filter (where cost_usd is null) as unpriced
from llm_usage
where created_at >= date_trunc('month', now())
group by purpose order by usd desc nulls last;

-- How much of our drafting is personalised vs template?
select source, count(*),
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from email_drafts where status <> 'rejected' group by source;

-- Which leads are stuck, and where?
select status, count(*) from leads where is_deleted = false group by status;

-- A campaign's real Instantly ids (the mapping that catches people out)
select c.name, ic.country, ic.instantly_campaign_id, ic.status, ic.sender_email
from campaigns c join instantly_campaigns ic on ic.campaign_id = c.id
where c.id = '<campaign uuid>';

-- Recover a setting you overwrote, from the other company's untouched row
select company_id, length(value) from settings where key = 'system_prompt';
```

---

Next: [05-data-flows.md](05-data-flows.md) — one lead, end to end.
