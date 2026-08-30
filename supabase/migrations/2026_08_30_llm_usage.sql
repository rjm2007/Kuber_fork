-- Every LLM call, with what it cost.
--
-- Nothing recorded this. complete() discarded the `usage` block each provider
-- already returns, so the only way to answer "what did last month cost?" was to
-- re-run a sample and extrapolate — which is how every cost figure in
-- docs/followups.md was produced. That is fine for a decision and useless for a
-- client invoice.
--
-- Two jobs, and the second matters more than the first:
--   1. answer "what did this cost" for a company, a campaign, or one draft
--   2. make WASTE visible — a retry loop, a lead regenerated forty times, a
--      prompt that doubled in size — none of which shows up anywhere today
--      except as a bill.

create table if not exists llm_usage (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,

  -- Who served it and with what. Both are needed: the same model costs
  -- different amounts through OpenRouter than through Anthropic direct.
  provider          text not null,
  model             text not null,
  -- 1-indexed position in the tier order. >1 means the primary provider failed
  -- and a fallback served this — worth being able to count.
  tier              int,

  -- What the call was FOR. Without this a bill is one number and cannot be
  -- argued with; with it, "drafting cost X, follow-ups Y, enrichment Z".
  purpose           text not null,

  input_tokens      int  not null default 0,
  output_tokens     int  not null default 0,
  -- Anthropic bills cache writes and reads differently from fresh input, and
  -- reports them separately. Stored so the cost maths can stay honest later.
  cache_write_tokens int not null default 0,
  cache_read_tokens  int not null default 0,

  -- USD, computed from the price table at call time. Null when the model is not
  -- in that table — an unknown price must read as unknown, never as zero, or
  -- the totals quietly understate the bill.
  cost_usd          numeric(12, 6),

  duration_ms       int,

  -- Optional links, so spend can be traced to the thing that caused it.
  campaign_id       uuid,
  lead_id           uuid,
  draft_id          uuid,

  -- Set when the call FAILED. A failed call still burns tokens on most
  -- providers, and a retry loop is exactly the waste this table exists to show.
  error             text,

  created_at        timestamptz not null default now()
);

comment on table llm_usage is
  'One row per LLM call, with tokens and computed cost. Written by complete(). Exists to answer "what did this cost" and to make repeated/wasted calls visible.';

-- The three questions actually asked of this table: what did this company spend
-- (over a period), what did this campaign spend, and what is being retried.
create index if not exists idx_llm_usage_company_time
  on llm_usage (company_id, created_at desc);

create index if not exists idx_llm_usage_campaign
  on llm_usage (campaign_id, created_at desc)
  where campaign_id is not null;

create index if not exists idx_llm_usage_lead
  on llm_usage (lead_id, created_at desc)
  where lead_id is not null;

-- Same posture as provider_keys and settings: RLS on, zero policies, so only
-- the service-role client can read it. Every reader goes through a route that
-- has already authorised the caller and scopes by company_id.
alter table llm_usage enable row level security;
