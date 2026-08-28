-- Instantly is told about a schedule change only once the emails exist.
--
-- Changing a follow-up delay used to patch Instantly in the same request.
-- Instantly reacts in seconds; writing the personalised text takes an hour for a
-- few hundred leads. So moving a date forward made every affected lead newly
-- overdue and Instantly sent its generic fallback to all of them before a single
-- personalised email had been written. The client got the timing they asked for
-- and the emails they did not.
--
-- With this flag the change is saved here, Instantly is left on the OLD
-- schedule (so it keeps doing nothing new), the text is generated, and only then
-- is Instantly patched. The visible cost is that "send today" becomes "send in
-- about an hour"; the alternative is boilerplate to hundreds of customers.
alter table campaigns
  add column if not exists sequence_publish_pending boolean not null default false,
  add column if not exists sequence_publish_requested_at timestamptz;

comment on column campaigns.sequence_publish_pending is
  'Sequence changed locally; Instantly still holds the old one until the follow-up text for it exists.';
comment on column campaigns.sequence_publish_requested_at is
  'When the deferred publish was requested — drives the "preparing…" state in the UI.';
