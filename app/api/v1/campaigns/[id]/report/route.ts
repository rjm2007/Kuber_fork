import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import {
  CAMPAIGN_BUCKET_LABELS,
  CAMPAIGN_KANBAN_COLS,
  campaignBucket,
  type CampaignKanbanBucket,
} from "@/lib/campaign-status";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

type DraftRow = { status: string } | { status: string }[] | null;

function unwrapDraft(raw: DraftRow): { status: string } | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, sent_count, replied_count")
    .eq("id", id)
    .maybeSingle();

  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  // A campaign is a shared container across employees (spec §5) — an
  // employee's report must only reflect their own leads, never the whole
  // campaign (confirmed live: an employee with 2 of a campaign's 7 leads was
  // seeing the full campaign-wide funnel/draft-generation numbers).
  let rowsQuery = db
    .from("campaign_leads")
    .select("id, crm_status, first_sent_at, draft_id, email_drafts(status), leads!inner(assigned_to)")
    .eq("campaign_id", id);
  if (user.role === "employee") rowsQuery = rowsQuery.eq("leads.assigned_to", user.id);
  const { data: rows } = await rowsQuery;

  const leads = rows ?? [];
  const bucketCounts: Record<CampaignKanbanBucket, number> = {
    pending: 0,
    draft: 0,
    approved: 0,
    sent: 0,
    replied: 0,
  };

  let draftsGenerated = 0;
  let certified = 0;
  let delivered = 0;
  let failed = 0;
  let generating = 0;
  let pending = 0;
  let succeeded = 0;

  for (const row of leads) {
    const draft = unwrapDraft(row.email_drafts as DraftRow);
    const ds = draft?.status;
    if (row.first_sent_at) delivered++;
    if (ds && ds !== "generating") draftsGenerated++;
    if (ds === "approved") certified++;
    if (ds === "failed") failed++;
    if (ds === "generating") generating++;
    if (!draft || !row.draft_id) pending++;
    if (ds === "draft" || ds === "approved" || ds === "sent") succeeded++;
    bucketCounts[campaignBucket(row)]++;
  }

  const replied = leads.filter((r) => r.crm_status === "replied").length;
  // campaign.sent_count / replied_count are campaign-wide counters — only a
  // safe floor for a manager (who sees the whole campaign); falling back to
  // them for an employee would leak the other employees' numbers back in.
  //
  // "Sent" is DELIVERED (first_sent_at), not the draft's 'sent' status — that
  // one flips when we hand the lead to Instantly, days before the mail leaves.
  // This tile read 100/100 on a campaign where only 44 had actually gone out.
  const sentTotal = user.role === "employee" ? delivered : Math.max(delivered, campaign.sent_count ?? 0);
  const repliedTotal = user.role === "employee" ? replied : Math.max(replied, campaign.replied_count ?? 0);

  const attempted = succeeded + failed;
  const successRate = attempted > 0 ? Math.round((succeeded / attempted) * 100) : 0;

  const stageDistribution = CAMPAIGN_KANBAN_COLS.map((col) => ({
    stage: col.id,
    label: CAMPAIGN_BUCKET_LABELS[col.id],
    count: bucketCounts[col.id],
  })).filter((s) => s.count > 0);

  return ok({
    campaignId: id,
    totals: {
      leads: leads.length,
      draftsGenerated,
      certified,
      sent: sentTotal,
      replied: repliedTotal,
      failed,
    },
    rates: {
      replyRate: sentTotal > 0 ? Math.round((repliedTotal / sentTotal) * 100) : 0,
      certifyRate: draftsGenerated > 0 ? Math.round((certified / draftsGenerated) * 100) : 0,
    },
    draftGeneration: {
      total: leads.length,
      pending,
      generating,
      succeeded,
      failed,
      successRate,
    },
    stageDistribution,
  });
}
