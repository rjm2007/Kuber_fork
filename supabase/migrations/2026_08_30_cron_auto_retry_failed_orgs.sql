-- Schedule auto-retry-failed-orgs.
--
-- The route has existed since July and was never scheduled: not in vercel.json,
-- not in pg_cron, and called from nowhere in the codebase. So the safety net it
-- provides — requeueing a failed organisation once one of its leads finally has
-- a usable email — had never run a single time.
--
-- Every 6 hours, offset to :15 so it does not collide with the 10-minute
-- enrichment watchdog or the nightly jobs at 02:00-04:00.
--
-- Safe to enable against the current data: the route only requeues orgs with
-- enrichment_attempts < 3, and every failed org was set to 3 on 30 Aug when the
-- client decided the existing lead quality was not worth re-enriching. Verified
-- zero rows match at the time of scheduling, so this spends nothing today and
-- only acts on organisations that arrive later.
select cron.schedule(
  'auto-retry-failed-orgs',
  '15 */6 * * *',
  $$select public.ping_internal_route('/api/internal/auto-retry-failed-orgs', 60000)$$
);
