-- Who answered this bounce, and when. The link alone (replaced_by_lead_id) says
-- a bounce was handled but not by whom, and "handled by someone, at some point"
-- is not accountability — the Outbox handoff panel names the person, so the
-- next employee knows who to ask instead of re-doing the research.
--
-- Both nullable: bounces replaced before this column existed simply have no
-- attribution, and the panel omits the line rather than inventing one.
alter table public.campaign_leads
  add column if not exists replaced_at timestamptz,
  add column if not exists replaced_by_user_id uuid references public.profiles(id) on delete set null;

comment on column public.campaign_leads.replaced_at is
  'When this bounced contact was replaced. Pairs with replaced_by_lead_id / replaced_by_user_id.';
comment on column public.campaign_leads.replaced_by_user_id is
  'The employee or manager who added the replacement contact. ON DELETE SET NULL — losing a profile must never delete the bounce record.';

-- Backfill for replacements made before these columns existed. Nothing is
-- invented: the replace route already logged the actor and the exact moment to
-- lead_events, so the panel shows the same name the timeline does. Idempotent
-- via the `replaced_at is null` guard; DISTINCT ON keeps the most recent event
-- for a bounce that was replaced more than once.
with latest as (
  select distinct on (cl.id)
         cl.id as cl_id,
         le.created_at,
         le.actor_id
    from public.campaign_leads cl
    join public.lead_events le
      on le.lead_id = cl.lead_id
     and le.metadata->>'replacement_lead_id' = cl.replaced_by_lead_id::text
     and le.metadata->>'campaign_id' = cl.campaign_id::text
   where cl.replaced_by_lead_id is not null
     and cl.replaced_at is null
   order by cl.id, le.created_at desc
)
update public.campaign_leads cl
   set replaced_at = latest.created_at,
       replaced_by_user_id = latest.actor_id
  from latest
 where latest.cl_id = cl.id;
