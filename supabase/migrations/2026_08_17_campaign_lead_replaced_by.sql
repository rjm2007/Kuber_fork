-- A bounce is the one outcome a human can still act on: the address was wrong,
-- but the company is still reachable. Once someone has added another contact
-- there, the bounced row must SAY so — otherwise every employee who opens the
-- campaign sees the same red BOUNCED badge and has no way to tell a handled
-- bounce from one nobody has touched, and re-does the work.
--
-- Nullable and additive: NULL means "still needs attention", which is the
-- correct reading for every row that existed before this column.
--
-- ON DELETE SET NULL, not CASCADE: deleting the replacement lead must never
-- delete the bounced campaign_leads row it points at — that row is the record
-- of the bounce itself and feeds bounced_count.
alter table public.campaign_leads
  add column if not exists replaced_by_lead_id uuid
    references public.leads(id) on delete set null;

comment on column public.campaign_leads.replaced_by_lead_id is
  'Set when a bounced contact was replaced by another address at the same company (POST /api/v1/campaign-leads/{id}/replace). NULL = the bounce is unhandled.';

-- Partial: only handled bounces are ever looked up by this, and they are a
-- small minority of the table.
create index if not exists campaign_leads_replaced_by_lead_id_idx
  on public.campaign_leads(replaced_by_lead_id)
  where replaced_by_lead_id is not null;
