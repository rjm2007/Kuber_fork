-- Which message a reply answered.
--
-- A thread can hold more than two people: anyone CC'd can write into it, and
-- Instantly files their message under the same lead. Once that happens the
-- thread reads as one flat chain and there is nothing on screen saying WHICH
-- message a given reply was answering — a reply to a CC'd colleague looks
-- identical to a reply to the prospect.
--
-- Inferring it from to_emails is not good enough now that a reply can carry
-- several To addresses (additional_recipients), so the link is recorded at send
-- time instead. Only ever set for mail WE send; NULL on everything synced in
-- from Instantly, which carries no such link.
alter table unibox_emails
  add column if not exists in_reply_to_email_id text;

comment on column unibox_emails.in_reply_to_email_id is
  'instantly_email_id of the message this reply answered. Set only for replies sent through our own endpoints; NULL for synced/inbound mail.';

-- Threads are read whole and then grouped in memory, so this only needs to make
-- the per-thread lookup of "what answered this message" cheap.
create index if not exists unibox_emails_in_reply_to_idx
  on unibox_emails (in_reply_to_email_id)
  where in_reply_to_email_id is not null;
