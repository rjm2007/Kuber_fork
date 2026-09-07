-- One lead per company: which companies a new Apollo search must skip.
--
-- THE PROBLEM, MEASURED 2026-09-07 on the live Kuber Polyplast workspace:
--   4,076 leads sitting on only 3,421 distinct companies.
--   420 companies hold more than one lead; the worst holds 22.
--   => 655 Apollo credits already spent on extra people at companies we
--      already had a contact at. Reveal is 1 credit per person, always.
-- The client's complaint ("I asked for 50 and ten are the same company") is
-- this, and every duplicate is money.
--
-- WHY A FUNCTION AND NOT A FILTER IN THE ROUTE
-- "Do we already have a usable contact here?" spans leads, campaign_leads and
-- reply_events. Doing it in the route means pulling thousands of rows per
-- import and re-joining them in JS on every page of every keyword. One stable
-- function, called once per import, is both smaller and correct.
--
-- THE BOUNCE RULE (option b, chosen deliberately over the simpler option a)
-- A company is blocked only while we hold a contact there that still WORKS.
-- If the single lead we have at Acme bounced, we have no way into Acme, and
-- blacklisting it forever would throw away a real prospect to protect a dead
-- email. 302 of the 3,421 companies are in exactly that state today, so this
-- is not a hypothetical. Leads archived to unenrichable_leads need no clause
-- here: they were never written to `leads`, so their company is already free.
--
-- THE DOMAIN EXPANSION
-- Apollo lists the same firm under more than one name ("Acme Plastics Ltd" and
-- "Acme Plastics Pvt Ltd"). The FREE people-search returns no organization id
-- and no domain (measured: docs/apollo-research/search-person-fields.json), so
-- the incoming person can only ever be matched by company NAME. The expansion
-- therefore has to happen on our side: if any org row sharing a domain with a
-- blocked one exists, its name is blocked too, so either spelling is caught at
-- intake. Names are returned already lowercased and trimmed; the route applies
-- the same legal-suffix normalisation (orgKey in lib/services/lead-ranking.ts)
-- to both sides.
-- RETURNS ONE text[], NOT A ROW SET. A set-returning version is silently
-- truncated by PostgREST at 1,000 rows: the live workspace has 3,116 covered
-- companies, so 2,116 of them would have sailed through the filter and been
-- paid for a second time. Caught by scripts/dryrun-one-lead-per-org.ts, which
-- printed 1,000 where the same SQL run directly returned 3,116.
create or replace function public.blocked_org_names(p_company uuid)
returns text[]
language sql
stable
as $$
  with bounced as (
    select distinct cl.lead_id
    from public.campaign_leads cl
    join public.reply_events re on re.campaign_lead_id = cl.id
    where re.event_type = 'email_bounced'
      and cl.company_id = p_company
  ),
  live_orgs as (
    select distinct l.organization_id as id
    from public.leads l
    where l.company_id = p_company
      and l.is_deleted = false
      and l.organization_id is not null
      and not exists (select 1 from bounced b where b.lead_id = l.id)
  ),
  expanded as (
    select id from live_orgs
    union
    select o2.id
    from public.organizations o1
    join public.organizations o2 on o2.domain = o1.domain
    where o1.id in (select id from live_orgs)
      and o1.domain is not null
      and o1.domain <> ''
  )
  select coalesce(array_agg(distinct lower(btrim(o.name))), '{}')
  from public.organizations o
  where o.id in (select id from expanded)
    and o.name is not null
    and btrim(o.name) <> '';
$$;

comment on function public.blocked_org_names(uuid) is
  'Company names a new Apollo import must skip because a working contact already exists there. Returns a single array, NOT a row set - a row set is silently capped at 1,000 by PostgREST. Excludes companies whose only contacts bounced, so a dead email does not blacklist a live prospect.';
