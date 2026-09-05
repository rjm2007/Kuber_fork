-- resume-apollo-reveal: once a day -> every 30 minutes.
--
-- WHY IT WAS DAILY (2026_08_04_apollo_reveal_daily_cron.sql)
-- This is the only scheduled job that can spend money. It was put on a daily
-- schedule after 15-26 July 2026, when a single permanently-unresolvable lead
-- was re-asked every 15 minutes and ran up ~420 Apollo credits before anyone
-- noticed. At one pass a day the same defect costs 1 credit a day and shows up
-- in the usage log long before it matters.
--
-- WHY DAILY IS NOW THE WRONG TRADE
-- On 4 Sep 2026 a client import of 400 leads revealed 200 and then stopped: the
-- self-chain dropped a hop, and because that kick swallowed its own error
-- (`.catch(() => {})`) nothing recorded it. Half a paid import sat idle and the
-- only recovery was this job — up to 24 hours away. The client noticed before we
-- did. A delay that "costs nothing real" costs plenty when it is the sole
-- safety net and the thing it is catching is silent.
--
-- WHY 30 MINUTES IS SAFE NOW, AND WAS NOT IN JULY
-- The July runaway is structurally impossible today:
--   1. MAX_ENRICH_ATTEMPTS = 2 (lib/services/enrich-leads.ts) caps a lead at two
--      asks for its entire life, and the attempt is written BEFORE Apollo is
--      called, so a crash still burns the attempt. 96 passes a day cannot ask
--      about the same lead 96 times any more - that is the exact bug this cap
--      was added for.
--   2. triggerEnrichWatchdog filters on enrich_attempts < MAX, so an exhausted
--      lead stops waking the job at all.
--   3. claim_unenriched_leads (2026_07_19) takes a real lock, so two callers can
--      never pay for the same person.
--   4. One import per pass, never parallel - concurrent bulk_match streams
--      rate-limit each other and Apollo bills a 429 like a served request.
--   5. NEW in this change: triggerEnrichWatchdog now returns early if any lead
--      is still locked, so a 30-minute tick cannot start a second reveal while
--      the previous one is mid-flight. The lock self-expires after 10 minutes,
--      so a pass killed by the function timeout unblocks itself.
--
-- Total spend is unchanged either way: the same leads, at most 2 asks each. The
-- only thing that changes is how long a stalled import waits - minutes, not a day.
--
-- To revert: re-run with '10 4 * * *'.

select cron.unschedule('resume-apollo-reveal')
where exists (select 1 from cron.job where jobname = 'resume-apollo-reveal');

select cron.schedule(
  'resume-apollo-reveal',
  '*/30 * * * *',
  $$select public.ping_internal_route('/api/internal/resume-apollo-reveal', 60000)$$
);
