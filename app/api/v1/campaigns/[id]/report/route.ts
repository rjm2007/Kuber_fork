import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import {
  CAMPAIGN_BUCKET_LABELS,
  CAMPAIGN_KANBAN_COLS,
  campaignBucket,
  computeCampaignStats,
  type CampaignKanbanBucket,
  type CampaignStatsRow,
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
    .select("id, sent_count, replied_count, bounced_count")
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
  let failed = 0;
  let generating = 0;
  let pending = 0;
  let succeeded = 0;

  for (const row of leads) {
    const draft = unwrapDraft(row.email_drafts as DraftRow);
    const ds = draft?.status;
    if (ds && ds !== "generating") draftsGenerated++;
    if (ds === "approved") certified++;
    if (ds === "failed") failed++;
    if (ds === "generating") generating++;
    if (!draft || !row.draft_id) pending++;
    if (ds === "draft" || ds === "approved" || ds === "sent") succeeded++;
    bucketCounts[campaignBucket(row)]++;
  }

  // One bucket per lead: a replied or bounced lead is NOT also counted as sent.
  // Both figures come from the same rows the caller can see, which is what makes
  // this employee-scoped for free — an employee's rows were already filtered to
  // their own leads above, a manager's were not.
  const scoped = computeCampaignStats(leads as CampaignStatsRow[]);
  // The campaign-wide columns are only a safe floor for a manager; falling back
  // to them for an employee would leak co-workers' numbers back in.
  const outcomes = user.role === "employee"
    ? scoped
    : {
        ...scoped,
        delivered_count: Math.max(scoped.delivered_count, campaign.sent_count ?? 0),
        replied_count: Math.max(scoped.replied_count, campaign.replied_count ?? 0),
        bounced_count: Math.max(scoped.bounced_count, campaign.bounced_count ?? 0),
      };
  const deliveredTotal = outcomes.delivered_count;
  const repliedTotal = outcomes.replied_count;
  const bouncedTotal = outcomes.bounced_count;
  const sentTotal = Math.max(0, deliveredTotal - repliedTotal - bouncedTotal);

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
      delivered: deliveredTotal,
      replied: repliedTotal,
      bounced: bouncedTotal,
      failed,
    },
    rates: {
      // Denominator is DELIVERED, not the narrowed sent tile — a reply is
      // evidence the mail arrived, so excluding replies from the base would
      // shrink it every time the campaign succeeds and inflate the rate.
      replyRate: deliveredTotal > 0 ? Math.round((repliedTotal / deliveredTotal) * 100) : 0,
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
