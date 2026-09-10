import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Set a campaign's hot_count / cold_count from its leads, instead of adding one.
 *
 * Four paths set campaign_leads.lead_temperature (the Instantly webhook, the
 * inbox sync, a manual status change in Unibox, the replies backfill) and only
 * the webhook counted it. When the inbox sync marked a lead hot first, the
 * webhook then saw "no change" and skipped the count: on 10 Sep 2026 a campaign
 * with two hot leads showed Hot 0 until the nightly reconcile. Nothing ever
 * lowered the count either, so a lead moved from hot to cold stayed counted.
 *
 * A count is exact and idempotent, so it no longer matters which path gets
 * there first or how often it runs. Same rule as reconcile-counters.
 */
export async function recountCampaignTemperature(db: SupabaseClient, campaignId: string | null | undefined): Promise<void> {
  if (!campaignId) return;
  try {
    const count = async (temperature: string) => {
      const { count: n } = await db
        .from("campaign_leads")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .eq("lead_temperature", temperature);
      return n;
    };
    const [hot, cold] = await Promise.all([count("hot"), count("cold")]);
    // A failed count must not zero the tile.
    if (hot === null || cold === null) return;
    await db.from("campaigns").update({ hot_count: hot, cold_count: cold }).eq("id", campaignId);
  } catch {
    /* non-fatal - reconcile-counters recomputes these nightly */
  }
}
