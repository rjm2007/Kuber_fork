import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { patchInstantlySequences, type InstantlyStep } from "@/lib/services/instantly";
import { findFollowupsToWrite } from "@/lib/services/followup-schedule";

/**
 * Publish a campaign's sequence to Instantly — but only once the emails exist.
 *
 * The order matters more than anything else here. Instantly acts on a schedule
 * change within seconds; generating a few hundred personalised follow-ups takes
 * about an hour. Patching first therefore means Instantly finds a pile of newly
 * overdue steps and sends its own generic fallback to every one of them before
 * a single real email has been written.
 *
 * So: save locally, leave Instantly on the old schedule, write the text, and
 * publish last. A campaign in that waiting state keeps sending on its OLD
 * timings, which is the safe place to be — late is recoverable, boilerplate to
 * three hundred customers is not.
 */

export type PublishResult = {
  published: string[];
  waiting: { campaignId: string; missing: number }[];
  failed: { campaignId: string; error: string }[];
};

/** Follow-ups that the NEW schedule makes due but which have no text yet. Zero
 *  means it is safe to let Instantly see the change. */
export async function countMissingText(
  db: SupabaseClient,
  campaignId: string,
): Promise<number> {
  const targets = await findFollowupsToWrite(db, { limit: 5000 });
  return targets.filter((t) => t.campaignId === campaignId).length;
}

/**
 * Publish every campaign that is waiting and now ready.
 *
 * Called after each follow-up writing pass, so a deferred change goes live the
 * moment the last email lands rather than waiting for anyone to come back and
 * press a button.
 */
export async function publishReadySequences(
  rootDb?: SupabaseClient,
): Promise<PublishResult> {
  const db = rootDb ?? createAdminClient();
  const result: PublishResult = { published: [], waiting: [], failed: [] };

  const { data: pending } = await db
    .from("campaigns")
    .select("id")
    .eq("sequence_publish_pending", true)
    .eq("is_deleted", false);

  if (!pending?.length) return result;

  // One sweep for every pending campaign rather than one per campaign: the
  // sweep is the expensive part and it already covers them all.
  const allTargets = await findFollowupsToWrite(db, { limit: 5000 });
  const missingByCampaign = new Map<string, number>();
  for (const t of allTargets) {
    missingByCampaign.set(t.campaignId, (missingByCampaign.get(t.campaignId) ?? 0) + 1);
  }

  for (const c of pending) {
    const campaignId = c.id as string;
    const missing = missingByCampaign.get(campaignId) ?? 0;
    if (missing > 0) {
      result.waiting.push({ campaignId, missing });
      continue;
    }

    try {
      await publishSequenceNow(db, campaignId);
      result.published.push(campaignId);
    } catch (e) {
      // Left pending on purpose: a failed patch must be retried, not silently
      // dropped, or the campaign runs forever on a schedule the user changed.
      result.failed.push({ campaignId, error: (e as Error).message });
    }
  }

  return result;
}

/** Push our steps to every Instantly sub-campaign and clear the pending flag. */
export async function publishSequenceNow(
  db: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const { data: steps } = await db
    .from("campaign_steps")
    .select("step_order, subject, body, delay, delay_unit")
    .eq("campaign_id", campaignId)
    .order("step_order");

  const payload: InstantlyStep[] = (steps ?? []).map((s) => ({
    subject: (s.subject as string) ?? "",
    body: (s.body as string) ?? "",
    delay: (s.delay as number) ?? 0,
    delayUnit: ((s.delay_unit as string) ?? "days") as InstantlyStep["delayUnit"],
  }));
  if (payload.length === 0) return;

  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("instantly_campaign_id")
    .eq("campaign_id", campaignId)
    .not("instantly_campaign_id", "is", null);

  // Every sub-campaign must take the change or the campaign ends up running two
  // different schedules by country. A single failure keeps the flag set so the
  // next pass retries the lot.
  for (const sub of subs ?? []) {
    await patchInstantlySequences(sub.instantly_campaign_id as string, payload);
  }

  await db.from("campaigns").update({
    sequence_publish_pending: false,
    sequence_publish_requested_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", campaignId);
}
