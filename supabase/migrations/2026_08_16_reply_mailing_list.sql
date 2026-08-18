-- Per-user CC/BCC address book for reply composers.
--
-- When a manager/employee CCs or BCCs someone on a Unibox / Outbox reply, we
-- remember that address so the next compose can suggest it while they type.
-- Scoped to (company, user) — not shared across the whole tenant, since these
-- are personal shortcuts from that sender's own history.

create table public.reply_mailing_list (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  last_used_at timestamptz not null default now(),
  use_count integer not null default 1 check (use_count >= 1),
  unique (company_id, user_id, email)
);

create index reply_mailing_list_user_recent_idx
  on public.reply_mailing_list (company_id, user_id, last_used_at desc);

alter table public.reply_mailing_list enable row level security;

comment on table public.reply_mailing_list is
  'CC/BCC addresses previously used by a user when sending replies, for autocomplete suggestions.';
