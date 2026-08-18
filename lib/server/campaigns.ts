import type { SupabaseClient } from "@supabase/supabase-js";
import { mapDbCampaign, type DbCampaign } from "@/lib/mappers";
import { employeeCampaignIds, campaignsEditableByEmployee } from "@/lib/auth/scope";
import { computeCampaignStats } from "@/lib/campaign-status";

type StatsRow = {
  campaign_id: string;
  crm_status: string;
  first_sent_at: string | null;
  lead_temperature: string | null;
  email_drafts: { status: string } | { status: string }[] | null;
};

/** Overlay employee-scoped lead/sent/replied/hot/cold onto campaign rows.
 *  campaigns.total_leads etc. are campaign-wide; employees must only see
 *  counts for leads assigned to them (same rule as the REST list/detail APIs). */
async function overlayEmployeeStats(
  db: SupabaseClient,
  campaigns: DbCampaign[],
  scopedUserId: string,
): Promise<DbCampaign[]> {
  if (campaigns.length === 0) return campaigns;
  const ids = campaigns.map((c) => c.id);
  const { data: ownRows } = await db
    .from("campaign_leads")
    .select("campaign_id, crm_status, first_sent_at, lead_temperature, email_drafts(status), leads!lead_id!inner(assigned_to)")
    .in("campaign_id", ids)
    .eq("leads.assigned_to", scopedUserId);

  const byCampaign = new Map<string, StatsRow[]>();
  for (const row of (ownRows ?? []) as StatsRow[]) {
    const list = byCampaign.get(row.campaign_id) ?? [];
    list.push(row);
    byCampaign.set(row.campaign_id, list);
  }

  return campaigns.map((c) => {
    const stats = computeCampaignStats(byCampaign.get(c.id) ?? []);
    return {
      ...c,
      total_leads: stats.total_leads,
      // sent_count is DELIVERED here too — mapDbCampaign subtracts replied and
      // bounced off it. Handing it the already-narrowed number would subtract
      // them twice and under-report this employee's SENT tile.
      sent_count: stats.delivered_count,
      replied_count: stats.replied_count,
      bounced_count: stats.bounced_count,
      hot_count: stats.hot_count,
      cold_count: stats.cold_count,
    };
  });
}

/** List campaigns; when `scopedUserId` is given (an employee), only campaigns
 *  they created, were assigned, OR that contain a lead assigned to them — the
 *  same rule as the API + detail access check (via employeeCampaignIds), so
 *  the list no longer hides campaigns an employee owns leads inside.
 *  Stats (leads/sent/replied/hot/cold) are also recomputed for that employee. */
export async function getCampaigns(db: SupabaseClient, scopedUserId?: string) {
  if (scopedUserId) {
    const ids = await employeeCampaignIds(db, scopedUserId);
    if (ids.length === 0) return [];
    const { data, error } = await db
      .from("campaigns")
      .select("*")
      .eq("is_deleted", false)
      .in("id", ids)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const scoped = await overlayEmployeeStats(db, (data ?? []) as unknown as DbCampaign[], scopedUserId);
    // Mirrors the REST list route: an employee may edit the shared
    // Options/Sequences only of campaigns no other employee is part of.
    const editable = await campaignsEditableByEmployee(db, scopedUserId, ids);
    return scoped.map((c) => mapDbCampaign({ ...c, can_edit_settings: editable.has(c.id) }));
  }

  const { data, error } = await db
    .from("campaigns")
    .select("*")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  // No scopedUserId means a manager — they administer every campaign.
  return (data ?? []).map((c) => mapDbCampaign({ ...(c as unknown as DbCampaign), can_edit_settings: true }));
}

/** Fetch one campaign. When `scopedUserId` is given (employee), overlay
 *  lead/sent/replied/hot/cold so the detail drawer badge + analytics tiles
 *  match the employee's assigned leads, not the campaign-wide totals. */
export async function getCampaign(db: SupabaseClient, id: string, scopedUserId?: string) {
  const { data, error } = await db
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  if (scopedUserId) {
    const [scoped] = await overlayEmployeeStats(db, [data as unknown as DbCampaign], scopedUserId);
    const editable = await campaignsEditableByEmployee(db, scopedUserId, [id]);
    return mapDbCampaign({ ...scoped, can_edit_settings: editable.has(id) });
  }
  return mapDbCampaign({ ...(data as unknown as DbCampaign), can_edit_settings: true });
}
