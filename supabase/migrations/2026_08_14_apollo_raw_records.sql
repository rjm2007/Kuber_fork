-- Full Apollo payloads, kept separately from the columns we actually use.
--
-- Organization Search and People Search return far more than we map onto
-- `organizations` / `leads`. Dropping the rest meant we could not later show
-- a LinkedIn/Twitter/Crunchbase URL (or anything else Apollo already sent)
-- without spending another credit. One row per tenant + Apollo id, overwritten
-- on every fresh fetch so we keep the latest snapshot rather than a history.
--
-- Access is server-only (service-role + scoped client). RLS is on with no
-- anon/authenticated policies — same lockdown as the rest of public.

create table public.apollo_raw_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('organization', 'person')),
  apollo_id text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (company_id, kind, apollo_id)
);

create index apollo_raw_records_company_fetched_idx
  on public.apollo_raw_records (company_id, fetched_at desc);

alter table public.apollo_raw_records enable row level security;

comment on table public.apollo_raw_records is
  'Latest raw Apollo organization/person JSON per tenant, so fields we did not map onto leads/orgs are still retrievable without a second paid call.';
