-- Hold sending: a reversible stop on a live campaign.
--
-- Instantly has no per-step pause — pausing is campaign-wide — so a "hold" is
-- an ordinary campaign pause plus the two facts a pause alone cannot carry:
-- WHO held it and WHEN. Those drive the banner. Without them a held campaign
-- looks identical to one someone paused last week and forgot, which is exactly
-- the failure mode the banner exists to prevent.
--
-- Verified live on 2026-08-29 (see docs/followups.md): a paused campaign held a
-- queued follow-up 14 minutes past its due time and sent nothing; re-activating
-- released it 57 seconds later. A hold delays mail, it never destroys it.
--
-- status stays the existing 'paused' value rather than gaining a new enum
-- member, so every other reader (the follow-up sweep, the campaign list, the
-- fan-out) keeps behaving correctly with no changes. sending_held_at is what
-- distinguishes "held for review" from "paused indefinitely".

-- sending_held_by is a bare uuid with no foreign key, matching every other
-- actor column in this schema (unibox_emails.sent_by, leads.assigned_to).
-- Users live in auth.users, which nothing in public references.
alter table campaigns
  add column if not exists sending_held_at timestamptz,
  add column if not exists sending_held_by uuid;

comment on column campaigns.sending_held_at is
  'Set when sending was held from the Sequences tab. NULL means not held. A campaign can be status=paused without being held (paused from the campaign list); only a held one shows the resume banner.';

comment on column campaigns.sending_held_by is
  'User who held sending. Shown in the banner so an open hold always has a name against it.';

-- Partial: only held campaigns are ever looked up this way, and there are very
-- few of them at any moment.
create index if not exists idx_campaigns_sending_held
  on campaigns (sending_held_at)
  where sending_held_at is not null;
