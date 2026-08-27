import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * WHEN a follow-up is written, and for whom.
 *
 * The whole design turns on one fact: a follow-up's due date is driven by when
 * that lead's OPENING email actually left, not by when the campaign was created.
 * Instantly drips a campaign out over days, so 100 leads sent across a week have
 * 100 different follow-up dates. Keying off `campaign_leads.first_sent_at` (set
 * by the `email_sent` webhook) makes that sort itself out with no special cases:
 * each lead simply carries its own clock.
 *
 * Consequences worth stating, because they look like bugs otherwise:
 *   • A lead that has never been sent has no due date and is never picked up.
 *     Correct — there is nothing to follow up on.
 *   • A campaign sitting in draft generates no follow-ups at all.
 *   • 50 sent today and 50 tomorrow produce two batches automatically.
 */

/** How far ahead of the due date a follow-up is written.
 *
 *  One day, deliberately. Writing at campaign start would spend tokens on leads
 *  who reply or bounce first (roughly a quarter of them). Writing on the due day
 *  itself races Instantly, which may fire the step before the text lands. A day
 *  of lead time is the cheap middle. */
export const FOLLOWUP_LEAD_TIME_DAYS = 1;

/** Statuses that mean the conversation is over — no follow-up should be written
 *  or sent. Instantly also stops the sequence itself on reply, so this mostly
 *  saves us the tokens rather than preventing a send.
 *
 *  These MUST be real values of the `campaign_lead_crm_status_enum` type.
 *  Postgres rejects the whole query with `22P02 invalid input value for enum`
 *  if even one is wrong — it does not ignore the unknown value, it 400s. An
 *  earlier version of this list carried "bounced" and "unsubscribed", which do
 *  not exist, and the effect was that the sweep silently returned nothing and
 *  no follow-up was ever written. Verified live: the enum accepts `new`,
 *  `enriched`, `draft`, `approved`, `sent`, `replied`, `failed`.
 *
 *  A bounce is recorded as `failed` by the email_bounced webhook, and an
 *  unsubscribe is carried on `lead_temperature`, not here. */
const DEAD_STATUSES = ["replied", "failed"];

export type FollowupStep = { step_order: number; delay: number; delay_unit: string | null };

/** A step's delay expressed in days.
 *
 *  Instantly's `delay` is the wait AFTER this step, before the next one — NOT
 *  the wait before this step. Getting that backwards is what made every
 *  follow-up due date too late by a whole step (see followupDueAt). Measured
 *  against 811 real send pairs on 26 Aug 2026: with step 1 delay=7 and step 2
 *  delay=14, step 2 actually landed 7.5 days after step 1 on average (min 6),
 *  not 14. */
export function delayInDays(step: FollowupStep): number {
  const n = step.delay ?? 0;
  switch ((step.delay_unit ?? "days").toLowerCase()) {
    case "minutes": return n / (60 * 24);
    case "hours":   return n / 24;
    default:        return n;
  }
}

/**
 * When step `stepOrder` falls due for a lead whose opening email left at
 * `firstSentAt`.
 *
 * Delays are cumulative and each one belongs to the step BEFORE the wait:
 * step 2 lands after step 1's delay, step 3 after step 1's plus step 2's. So the
 * sum runs over every step strictly before the target — step 1 included, which
 * is why the caller must fetch it.
 *
 * This read `> 1 && <= stepOrder` until 26 Aug 2026, i.e. it charged each step
 * its OWN delay and ignored step 1's entirely. With the client's 7/14/21 ladder
 * that put step 2 at day 14 when Instantly sends it on day 7, so every
 * personalised follow-up was written a week after Instantly had already sent
 * the generic fallback in its place. Verified against 811 real send pairs.
 *
 * Returns null when the opening email has not been sent, which is the signal to
 * skip the lead entirely.
 */
export function followupDueAt(
  firstSentAt: string | null | undefined,
  steps: FollowupStep[],
  stepOrder: number,
): Date | null {
  if (!firstSentAt) return null;
  const base = new Date(firstSentAt);
  if (Number.isNaN(base.getTime())) return null;

  const totalDays = steps
    .filter((s) => s.step_order < stepOrder)
    .reduce((sum, s) => sum + delayInDays(s), 0);

  return new Date(base.getTime() + totalDays * 24 * 60 * 60 * 1000);
}

/** True when a follow-up should be written now: due within the lead-time window.
 *  Already-overdue counts as due — a missed run must catch up rather than skip. */
export function isDueForWriting(dueAt: Date | null, now = new Date()): boolean {
  if (!dueAt) return false;
  const horizon = new Date(now.getTime() + FOLLOWUP_LEAD_TIME_DAYS * 24 * 60 * 60 * 1000);
  return dueAt <= horizon;
}

/**
 * Row cap for the two "what is already done" lookups below.
 *
 * PostgREST returns at most 1000 rows when no limit is given, and Supabase does
 * not raise that default. Both lookups exist to STOP work being redone, so a
 * silent truncation does not lose data — it spends money and sends wrong email.
 * That is exactly what happened: on 27 Aug 2026 the delivered-steps lookup had
 * 1788 rows to read, silently got 1000, and the sweep rewrote 202 follow-ups
 * Instantly had already sent (about 680 across three days).
 *
 * Paired with a hard failure when a lookup comes back full — see assertComplete.
 * Guessing which 1000 rows PostgREST chose is not a thing worth doing.
 */
const LOOKUP_LIMIT = 50_000;

/** Refuses to continue when a "what is already done" lookup came back exactly
 *  full, because past that point we cannot tell done from not-done. Throwing
 *  costs a skipped sweep, which the next run repeats; guessing costs real
 *  emails to real customers. */
function assertComplete(rows: unknown[] | null, what: string) {
  if ((rows?.length ?? 0) >= LOOKUP_LIMIT) {
    throw new Error(
      `findFollowupsToWrite: the ${what} lookup returned ${LOOKUP_LIMIT} rows, so it is probably `
      + `truncated. Refusing to write follow-ups from an incomplete picture — raise LOOKUP_LIMIT.`,
    );
  }
}

export type FollowupTarget = {
  campaignId: string;
  campaignLeadId: string;
  leadId: string;
  stepOrder: number;
  dueAt: string;
  instantlyLeadId: string | null;
};

/**
 * Every follow-up that needs writing right now, across all live campaigns.
 *
 * Deliberately one sweep rather than per-campaign: the daily job has no campaign
 * in hand, and a lead's due date has nothing to do with which campaign it sits
 * in. Ordered by due date so that if the batch is capped, the most urgent are
 * written first — a follow-up due tomorrow matters more than one due next week.
 */
export async function findFollowupsToWrite(
  db: SupabaseClient,
  opts: { limit?: number; now?: Date; companyId?: string } = {},
): Promise<FollowupTarget[]> {
  const limit = opts.limit ?? 50;
  const now = opts.now ?? new Date();

  // Live campaigns only. A draft campaign has sent nothing, and a paused one
  // should not be quietly preparing work while the user believes it is stopped.
  //
  // companyId narrows the sweep to one tenant. Unscoped is correct in
  // production, where the cron serves every company at once. It is NEVER
  // correct from a developer machine: local dev points at the same Supabase as
  // production, so an unscoped run on localhost reaches the client's live
  // campaigns. That happened on 25 Aug 2026 — a local test wrote 6 follow-ups
  // into the client's APOLLO CAMPAIGN 2 and pushed them to Instantly. The route
  // now refuses an unscoped run outside production; this parameter is how a
  // local run stays inside the dev tenant.
  let campaignQuery = db
    .from("campaigns")
    .select("id")
    .eq("is_deleted", false)
    .in("status", ["active", "processing"]);

  if (opts.companyId) campaignQuery = campaignQuery.eq("company_id", opts.companyId);

  const { data: campaigns } = await campaignQuery;

  const campaignIds = (campaigns ?? []).map((c) => c.id as string);
  if (campaignIds.length === 0) return [];

  // Step 1 is fetched too. It is never a follow-up TARGET, but its delay is
  // what schedules step 2, so leaving it out made every due date a step late.
  const { data: allSteps } = await db
    .from("campaign_steps")
    .select("campaign_id, step_order, delay, delay_unit")
    .in("campaign_id", campaignIds)
    .order("step_order");

  const stepsByCampaign = new Map<string, FollowupStep[]>();
  for (const s of allSteps ?? []) {
    const id = s.campaign_id as string;
    if (!stepsByCampaign.has(id)) stepsByCampaign.set(id, []);
    stepsByCampaign.get(id)!.push(s as FollowupStep);
  }
  // Campaigns with no follow-up step at all have nothing to schedule.
  for (const [id, steps] of stepsByCampaign) {
    if (!steps.some((s) => s.step_order > 1)) stepsByCampaign.delete(id);
  }
  if (stepsByCampaign.size === 0) return [];

  // Only leads whose opening email has actually left. `first_sent_at` is written
  // by the email_sent webhook, so its presence IS the proof that step 1 landed.
  const { data: leads } = await db
    .from("campaign_leads")
    .select("id, campaign_id, lead_id, crm_status, first_sent_at, instantly_lead_id")
    .in("campaign_id", [...stepsByCampaign.keys()])
    .not("first_sent_at", "is", null)
    .not("crm_status", "in", `(${DEAD_STATUSES.join(",")})`)
    .limit(5000);

  if (!leads?.length) return [];

  // Which (lead, step) pairs already have a LIVE draft. One query rather than
  // one per lead: this sweep runs across every campaign and would otherwise be
  // N+1.
  //
  // 'rejected' is excluded because it means superseded, not written. Two things
  // produce those rows: regenerating (which leaves the previous version behind,
  // alongside a live one that still blocks correctly), and correcting a bounced
  // contact (which supersedes every follow-up for that lead, because they greet
  // the person who bounced by name — see the replace route). In the second case
  // nothing live is left, and the lead must become writable again rather than
  // keeping a follow-up addressed to someone else.
  const { data: existing } = await db
    .from("email_drafts")
    .select("lead_id, campaign_id, step_number")
    .in("campaign_id", [...stepsByCampaign.keys()])
    .gt("step_number", 1)
    // 'rejected' is a superseded version and 'failed' is an attempt that
    // produced nothing — neither is a written follow-up, so neither may block a
    // retry. Excluding only 'rejected' meant one bad LLM call stranded that
    // lead's follow-up permanently: the row blocked every later sweep, and the
    // customer received the generic fallback with nothing on screen to show why.
    .not("status", "in", "(rejected,failed)")
    .limit(LOOKUP_LIMIT);
  assertComplete(existing, "written-drafts");

  const written = new Set(
    (existing ?? []).map((d) => `${d.campaign_id}:${d.lead_id}:${d.step_number}`),
  );

  // Steps Instantly has ALREADY delivered. Writing one of those spends an LLM
  // call on an email the customer received days ago, and then pushes the new
  // text into a variable nothing will read again.
  //
  // Not hypothetical: when the due-date bug above was fixed, 575 follow-ups
  // became "due and unwritten" at once and 569 of them had already gone out.
  // Without this filter the very next sweep would have written all 569.
  //
  // `step` is Instantly's "{sequence}_{stepIndex}_{variant}" and stepIndex is
  // 0-based, so step_order N is stepIndex N-1. Matching on the index alone
  // keeps every A/B variant of that step counted as sent.
  const { data: delivered } = await db
    .from("unibox_emails")
    .select("instantly_lead_id, step")
    .eq("direction", "sent_campaign")
    .in("campaign_id", [...stepsByCampaign.keys()])
    .not("instantly_lead_id", "is", null)
    .limit(LOOKUP_LIMIT);
  assertComplete(delivered, "delivered-steps");

  const sentSteps = new Set<string>();
  for (const row of delivered ?? []) {
    const index = Number((row.step as string | null)?.split("_")[1]);
    if (Number.isFinite(index)) sentSteps.add(`${row.instantly_lead_id}:${index + 1}`);
  }

  const targets: FollowupTarget[] = [];
  for (const cl of leads) {
    const steps = stepsByCampaign.get(cl.campaign_id as string) ?? [];
    for (const step of steps) {
      if (step.step_order <= 1) continue; // step 1 is the opening email, not a follow-up
      const key = `${cl.campaign_id}:${cl.lead_id}:${step.step_order}`;
      if (written.has(key)) continue;
      // Already delivered — too late to personalise, and the next step is what
      // matters now, so keep scanning rather than breaking out.
      if (sentSteps.has(`${cl.instantly_lead_id}:${step.step_order}`)) continue;

      const dueAt = followupDueAt(cl.first_sent_at as string, steps, step.step_order);
      if (!isDueForWriting(dueAt, now)) continue;

      targets.push({
        campaignId: cl.campaign_id as string,
        campaignLeadId: cl.id as string,
        leadId: cl.lead_id as string,
        stepOrder: step.step_order,
        dueAt: dueAt!.toISOString(),
        instantlyLeadId: (cl.instantly_lead_id as string | null) ?? null,
      });
      // Only the earliest unwritten step per lead. Writing step 3 before step 2
      // exists would produce a follow-up referring to a message never sent.
      break;
    }
  }

  targets.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return targets.slice(0, limit);
}
