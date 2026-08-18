import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { BulkApproveSchema } from "@/lib/validators/drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";
import { getActiveJob } from "@/lib/services/regeneration-jobs";

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = BulkApproveSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const now = new Date().toISOString();

  let approved = 0;
  let skipped = 0;

  // Same rule as the single-draft approve: nothing may be certified while a bulk
  // regeneration is live for that campaign+step, because the run is about to
  // rewrite these very drafts. Memoised — a bulk approve is usually one campaign,
  // and this must not become one job lookup per draft.
  const activeJobByKey = new Map<string, boolean>();
  async function regenerationRunning(campaignId: string, stepNumber: number) {
    const key = `${campaignId}:${stepNumber}`;
    const cached = activeJobByKey.get(key);
    if (cached !== undefined) return cached;
    const running = !!(await getActiveJob(db, campaignId, stepNumber));
    activeJobByKey.set(key, running);
    return running;
  }

  for (const draftId of parsed.data.draft_ids) {
    const { data: draft } = await db
      .from("email_drafts")
      .select("id, status, lead_id, campaign_id, step_number")
      .eq("id", draftId)
      .maybeSingle();

    if (!draft || draft.status !== "draft") {
      skipped++;
      continue;
    }

    try { await assertCampaignAccess(db, user, draft.campaign_id); } catch { skipped++; continue; }

    if (await regenerationRunning(draft.campaign_id, draft.step_number ?? 1)) { skipped++; continue; }

    await db.from("email_drafts").update({
      status: "approved",
      approved_at: now,
      reviewed_by: user.id,
      updated_at: now,
    }).eq("id", draftId);

    // Never downgrade a lead already handed to Instantly — see the same guard in
    // drafts/[id] approve. A regeneration finishing after the send would otherwise
    // rewind 'sent' to 'approved' on a lead that has genuinely been mailed.
    await db.from("campaign_leads").update({
      crm_status: "approved",
      updated_at: now,
    }).eq("draft_id", draftId).is("instantly_campaign_id", null);

    await syncApprovedDraftToInstantly(db, draft.lead_id, draft.campaign_id);

    await logLeadEvent(db, draft.lead_id, "draft_approved", "Email draft approved", {
      actorId: user.id,
      metadata: { campaign_id: draft.campaign_id, draft_id: draftId, bulk: true },
    });

    approved++;
  }

  return ok({ approved, skipped });
}
