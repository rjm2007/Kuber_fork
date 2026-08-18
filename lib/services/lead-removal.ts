import type { createAdminClient } from "@/lib/supabase/admin";
import { deleteInstantlyLead } from "@/lib/services/instantly";
import { logLeadEvent } from "@/lib/services/lead-events";

type Db = ReturnType<typeof createAdminClient>;

/** Campaign name off the joined row, which PostgREST may hand back either shape. */
function campaignName(rel: unknown): string {
  const c = Array.isArray(rel) ? rel[0] : rel;
  return (c as { name?: string } | null)?.name ?? "a campaign";
}

export type LeadRemovalResult = {
  instantly_removed: number;
  instantly_errors: string[];
  memberships_closed: number;
  memberships_removed: number;
};

// Statuses that mean "nothing was ever sent for this membership" — safe to
// hard-remove so the lead simply vanishes from the campaign's kanban/counts.
const PRE_SEND_STATUSES = ["new", "enriching", "enriched", "draft", "draft_ready", "approved", "skipped", "failed"];

/**
 * Deleting a lead must actually stop outreach (planning.md Phase 5 / Q7):
 *   • memberships already pushed to Instantly → delete the Instantly lead
 *     (kills scheduled follow-ups) and close the membership (history kept);
 *   • memberships never sent → remove them and their unsent drafts entirely;
 *   • affected campaigns get their total_leads recounted.
 * Idempotent: re-running after a partial Instantly failure retries cleanly
 * (Instantly 404s are treated as already-removed).
 *
 * Note the intentional asymmetry (review §3.6): pre-send data is hard-deleted
 * because nothing else references it, but post-send `reply_events` /
 * `unibox_emails` / `reply_drafts` rows are left in place — they're real send
 * history, not working data, and every access path already scopes through
 * `campaign_leads`/`leads.is_deleted`, so a deleted lead's threads simply stop
 * being reachable rather than needing their own cleanup. If a future surface
 * ever reads those tables directly without going through that scoping, it
 * must check `is_deleted` itself.
 */
export async function removeLeadFromOutreach(db: Db, leadId: string): Promise<LeadRemovalResult> {
  const result: LeadRemovalResult = {
    instantly_removed: 0,
    instantly_errors: [],
    memberships_closed: 0,
    memberships_removed: 0,
  };

  // This lead may have been someone else's bounce replacement. Deleting it
  // without clearing those pointers leaves the bounced row wearing a green
  // "Replaced" marker with nothing behind it — which tells the next person the
  // bounce is handled when it no longer is. Runs BEFORE the no-memberships
  // early return: a replacement's own membership is hard-removed by the
  // pre-send branch below, so on a re-run there is nothing left to iterate and
  // the stale pointer would survive forever.
  const { data: unlinked } = await db
    .from("campaign_leads")
    .update({ replaced_by_lead_id: null, updated_at: new Date().toISOString() })
    .eq("replaced_by_lead_id", leadId)
    .select("lead_id, campaign_id");
  for (const row of unlinked ?? []) {
    await logLeadEvent(db, row.lead_id as string, "status_changed",
      "Replacement contact was deleted — this bounce needs attention again",
      { metadata: { campaign_id: row.campaign_id, deleted_replacement_lead_id: leadId } });
  }

  const { data: memberships } = await db
    .from("campaign_leads")
    .select("id, campaign_id, crm_status, instantly_lead_id, campaigns(name)")
    .eq("lead_id", leadId);

  if (!memberships || memberships.length === 0) return result;

  const now = new Date().toISOString();
  const affectedCampaignIds = new Set<string>();

  for (const m of memberships) {
    affectedCampaignIds.add(m.campaign_id as string);

    if (m.instantly_lead_id) {
      // Already in Instantly — stop future sends, keep the membership as history.
      try {
        await deleteInstantlyLead(m.instantly_lead_id as string);
        result.instantly_removed++;
      } catch (e) {
        result.instantly_errors.push(`campaign_lead ${m.id}: ${(e as Error).message}`);
        // Still close the membership — the lead is deleted in our system either
        // way, and re-running the delete retries the Instantly removal.
      }
      if (m.crm_status !== "closed") {
        await db.from("campaign_leads")
          .update({ crm_status: "closed", updated_at: now })
          .eq("id", m.id);
        result.memberships_closed++;
        await logLeadEvent(db, leadId, "removed_from_campaign",
          `Outreach stopped in "${campaignName(m.campaigns)}" — lead deleted`,
          { metadata: { campaign_id: m.campaign_id, history_kept: true } });
      }
    } else if (PRE_SEND_STATUSES.includes(m.crm_status as string)) {
      // Never sent — remove the membership and its unsent drafts entirely.
      await db.from("email_drafts")
        .delete()
        .eq("campaign_id", m.campaign_id)
        .eq("lead_id", leadId)
        .neq("status", "sent");
      await db.from("campaign_leads").delete().eq("id", m.id);
      result.memberships_removed++;
      await logLeadEvent(db, leadId, "removed_from_campaign",
        `Removed from campaign "${campaignName(m.campaigns)}" — nothing had been sent yet`,
        { metadata: { campaign_id: m.campaign_id } });
    } else if (m.crm_status !== "closed") {
      // Post-send status without an Instantly id (e.g. replied via unmapped
      // path) — just close it.
      await db.from("campaign_leads")
        .update({ crm_status: "closed", updated_at: now })
        .eq("id", m.id);
      result.memberships_closed++;
      await logLeadEvent(db, leadId, "removed_from_campaign",
        `Outreach stopped in "${campaignName(m.campaigns)}" — lead deleted`,
        { metadata: { campaign_id: m.campaign_id, history_kept: true } });
    }
  }

  // Recount total_leads from ground truth for every affected campaign.
  for (const campaignId of affectedCampaignIds) {
    const { count } = await db
      .from("campaign_leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    await db.from("campaigns")
      .update({ total_leads: count ?? 0, updated_at: now })
      .eq("id", campaignId);
  }

  return result;
}
