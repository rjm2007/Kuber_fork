import type { SupabaseClient } from "@supabase/supabase-js";
import { getInstantlyCampaign } from "@/lib/services/instantly";

/**
 * Does Instantly's copy of each sequence still match ours?
 *
 * Instantly keeps its OWN copy of the steps. We push ours at fan-out and when a
 * follow-up is saved, and then never look again — so if the two drift apart,
 * nothing notices. They drifted for weeks: our campaign_steps said one thing,
 * Instantly's said another, follow-up 2 was scheduled for day 42 instead of day
 * 14, and the first anyone knew was the client asking why no follow-up had
 * arrived. This is the check that would have caught it the next morning.
 *
 * Compares delays only. Bodies are per-lead custom variables and legitimately
 * differ; the delay is the thing that decides WHEN a customer gets mailed, and
 * it is the thing that silently went wrong.
 */

/** Instantly rate-limits hard — hammering its campaign endpoint returned 403
 *  within a few dozen calls while investigating this. A daily check has no
 *  reason to rush, so it walks rather than runs. */
const PACE_MS = 400;

/** Cap per run. With ~100 sub-campaigns and PACE_MS this is a couple of minutes
 *  of wall clock; the route's own budget stops it earlier if needed. */
const MAX_CHECKED = 250;

export type SequenceDrift = {
  campaignId: string;
  campaignName: string;
  instantlyCampaignId: string;
  ourDelays: number[];
  instantlyDelays: number[];
};

export type DriftReport = {
  checked: number;
  drifted: SequenceDrift[];
  unreachable: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function findSequenceDrift(
  db: SupabaseClient,
  opts: { companyId?: string; budgetMs?: number } = {},
): Promise<DriftReport> {
  const startedAt = Date.now();
  const budget = opts.budgetMs ?? 40_000;

  let q = db
    .from("campaigns")
    .select("id, name, company_id")
    .eq("is_deleted", false)
    .in("status", ["active", "processing"]);
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  const { data: campaigns } = await q;
  if (!campaigns?.length) return { checked: 0, drifted: [], unreachable: 0 };

  const campaignIds = campaigns.map((c) => c.id as string);

  const { data: steps } = await db
    .from("campaign_steps")
    .select("campaign_id, step_order, delay")
    .in("campaign_id", campaignIds)
    .order("step_order")
    .limit(5000);

  const ourByCampaign = new Map<string, number[]>();
  for (const s of steps ?? []) {
    const id = s.campaign_id as string;
    if (!ourByCampaign.has(id)) ourByCampaign.set(id, []);
    ourByCampaign.get(id)!.push((s.delay as number) ?? 0);
  }

  // One sub-campaign per (campaign, country, sender). Checking every one would
  // be hundreds of calls; they are all patched together from the same steps, so
  // one per campaign catches a drift without the rate-limit risk.
  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("campaign_id, instantly_campaign_id")
    .in("campaign_id", campaignIds)
    .not("instantly_campaign_id", "is", null)
    .limit(5000);

  const firstSub = new Map<string, string>();
  for (const s of subs ?? []) {
    const id = s.campaign_id as string;
    if (!firstSub.has(id)) firstSub.set(id, s.instantly_campaign_id as string);
  }

  const nameById = new Map(campaigns.map((c) => [c.id as string, c.name as string]));
  const report: DriftReport = { checked: 0, drifted: [], unreachable: 0 };

  for (const [campaignId, instantlyId] of firstSub) {
    if (report.checked >= MAX_CHECKED) break;
    if (Date.now() - startedAt > budget) break;

    const ours = ourByCampaign.get(campaignId);
    if (!ours?.length) continue;

    try {
      const remote = await getInstantlyCampaign(instantlyId);
      const theirs = (remote.sequences?.[0]?.steps ?? []).map((s) => s.delay ?? 0);
      report.checked++;

      // A missing sequence is not drift — a campaign can legitimately be
      // mid-creation. Only a populated, DIFFERENT sequence counts.
      if (theirs.length === 0) continue;
      if (theirs.length === ours.length && theirs.every((d, i) => d === ours[i])) continue;

      report.drifted.push({
        campaignId,
        campaignName: nameById.get(campaignId) ?? campaignId,
        instantlyCampaignId: instantlyId,
        ourDelays: ours,
        instantlyDelays: theirs,
      });
    } catch {
      // A single unreachable campaign must not fail the sweep — a 429 on one
      // call says nothing about the others.
      report.unreachable++;
    }

    await sleep(PACE_MS);
  }

  return report;
}

/**
 * Record drift where the service-health banner will find it.
 *
 * Reuses enrichment_logs + /api/v1/service-health rather than inventing a
 * second alerting path: that banner is already the one place every role sees
 * when something upstream is wrong.
 */
export async function logSequenceDrift(
  db: SupabaseClient,
  drifted: SequenceDrift[],
): Promise<void> {
  if (drifted.length === 0) return;
  try {
    await db.from("enrichment_logs").insert(
      drifted.map((d) => ({
        source: "instantly",
        event: "SEQUENCE_DRIFT",
        error: `"${d.campaignName}" follow-up timing differs: ours ${d.ourDelays.join("/")}, `
             + `Instantly ${d.instantlyDelays.join("/")}`,
        payload: d as unknown as Record<string, unknown>,
        created_at: new Date().toISOString(),
      })),
    );
  } catch { /* non-fatal: the check must not break on a logging failure */ }
}
