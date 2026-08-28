-- Why a draft says what it says, and how hard we tried.
--
-- Until now a follow-up that could not be written left NOTHING behind: the
-- sweep skipped the lead, Instantly quietly sent its own generic fallback, and
-- no record existed that the customer got boilerplate instead of the
-- personalised email the client is paying for. On 27 Aug 2026 that was 376
-- leads and the only way to find out was to read the database.
--
-- source        'ai' = written by the model. 'template' = the safety net, put
--               there deliberately after the retries failed so SOMETHING
--               sensible sends, and upgraded to 'ai' later if it can be.
-- attempts      Hard stop for the retry loop. A lead with unusable data used to
--               be retried every ten minutes forever.
-- fallback_reason  Plain English, for the client — "AI credits ran out", not
--               "429". The client decides whether it is their problem (top up)
--               or nobody's (thin company data), and cannot do that from an
--               HTTP status code.
alter table email_drafts
  add column if not exists source          text    not null default 'ai',
  add column if not exists attempts        integer not null default 0,
  add column if not exists fallback_reason text;

alter table email_drafts drop constraint if exists email_drafts_source_check;
alter table email_drafts add constraint email_drafts_source_check
  check (source in ('ai', 'template'));

comment on column email_drafts.source is
  'ai = model-written. template = safety-net fallback, upgradeable until sent.';
comment on column email_drafts.attempts is
  'Generation attempts so far. Capped so a permanently-failing lead stops retrying.';
comment on column email_drafts.fallback_reason is
  'Client-facing reason this fell back to the template. Null for ai drafts.';

create index if not exists idx_email_drafts_template_upgradeable
  on email_drafts (campaign_id, lead_id, step_number)
  where source = 'template';
