-- Daily job that writes the personalised follow-ups falling due, and pushes each
-- to Instantly.
--
-- WHY DAILY AND NOT SUB-HOURLY. A follow-up's due date moves in days, not
-- minutes: it is derived from campaign_leads.first_sent_at plus the cumulative
-- step delays. Asking every ten minutes would re-ask the same question 144 times
-- for an answer that changes once a day. The route writes a day AHEAD of the due
-- date (FOLLOWUP_LEAD_TIME_DAYS = 1 in lib/services/followup-schedule.ts), so a
-- single daily pass still lands the text in Instantly ~24h before the step fires.
--
-- 02:00 UTC = 07:30 IST, ahead of any sending window, so anything written this
-- morning is in Instantly before that day's first send.
--
-- THE WATCHDOG ALSO CALLS THIS, deliberately, and is NOT being removed. It is
-- the safety net: if this job fails or the schedule is edited away, the
-- 10-minute enrichment-watchdog picks the work up within ten minutes instead of
-- twenty-four hours. That duplication is free — findFollowupsToWrite skips any
-- (campaign, lead, step) that already has a draft, so a pass with nothing due is
-- a handful of Supabase reads and costs no LLM tokens and no Apollo credits. An
-- LLM call happens only when a follow-up is genuinely due and unwritten, which
-- is the one call that had to happen anyway.
--
-- Timeout matches the route's maxDuration = 55, plus headroom. Anything shorter
-- and pg_net drops the connection mid-flight and a merely slow run looks failed
-- (this bit unibox-sync at 15s — see 2026_07_23_pg_cron_internal_jobs.sql).
--
-- No company_id here, and that is correct: the route's guardUnscoped() allows an
-- unscoped sweep only when NODE_ENV=production, which is exactly this caller.
-- Every other environment must name its tenant.
select cron.schedule(
  'write-followups',
  '0 2 * * *',
  $$select public.ping_internal_route('/api/internal/write-followups', 60000)$$
);
