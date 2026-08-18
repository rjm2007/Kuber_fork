-- The other half of the replacement link. campaign_leads.replaced_by_lead_id
-- says "this bounce was handled"; this says, on the NEW lead, who it stands in
-- for — so a contact that appeared out of nowhere in a running campaign can be
-- explained without digging through the activity log.
--
-- Lives on `leads`, not `campaign_leads`, because it is a fact about the person
-- ("this address replaced that one"), not about one campaign membership.
alter table public.leads
  add column if not exists replaces_lead_id uuid
    references public.leads(id) on delete set null;

comment on column public.leads.replaces_lead_id is
  'Set when this lead was added to replace a bounced contact at the same company (POST /api/v1/campaign-leads/{id}/replace).';

create index if not exists leads_replaces_lead_id_idx
  on public.leads(replaces_lead_id)
  where replaces_lead_id is not null;

-- One-time repair. Deleting a lead did not clear the pointers aimed at it, so a
-- bounce whose replacement was later deleted kept showing the green "Replaced"
-- marker with nothing behind it — the worst possible reading, since it tells
-- the next person the bounce is handled when it is not. removeLeadFromOutreach
-- now clears these at delete time; this fixes the rows that already drifted.
update public.campaign_leads cl
   set replaced_by_lead_id = null,
       updated_at = now()
  from public.leads l
 where l.id = cl.replaced_by_lead_id
   and l.is_deleted = true;
