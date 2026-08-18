import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchDraftSchema } from "@/lib/validators/drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";
import { assertDraftAccess } from "@/lib/auth/scope";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";
import { getActiveJob } from "@/lib/services/regeneration-jobs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchDraftSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertDraftAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: draft } = await db
    .from("email_drafts")
    .select("id, status, lead_id, campaign_id, step_number")
    .eq("id", id)
    .maybeSingle();

  if (!draft) return fail(404, "NOT_FOUND", "Draft not found");

  const now = new Date().toISOString();
  const isFollowUp = (draft.step_number ?? 1) > 1;
  // Follow-ups are a separate email in the same thread — say which one moved,
  // or the timeline reads as the same draft being approved twice.
  const which = isFollowUp ? ` (follow-up step ${draft.step_number})` : "";
  const draftMeta = { campaign_id: draft.campaign_id, draft_id: id, step: draft.step_number ?? 1 };

  if (parsed.data.action === "approve") {
    if (draft.status !== "draft") return fail(409, "CONFLICT", `Cannot approve a draft with status '${draft.status}'`);

    // A bulk regeneration is about to rewrite these drafts, so certifying one
    // mid-run is work the run is going to throw away — and it is what produced
    // the certified-yet-already-sent lead on APOLLO CAMPAIGN 1. The status check
    // above cannot see it: a lead still sitting in the job queue reads 'draft'
    // right up until the worker reaches it. Refuse for the whole campaign+step
    // while a run is live rather than let reviewers race a background job.
    const activeJob = await getActiveJob(db, draft.campaign_id, draft.step_number ?? 1);
    if (activeJob) {
      return fail(409, "CONFLICT", "A regeneration is running for this campaign — wait for it to finish before certifying.");
    }

    await db.from("email_drafts").update({ status: "approved", approved_at: now, reviewed_by: user.id, updated_at: now }).eq("id", id);
    // Follow-ups never own campaign_leads.draft_id (see generateOneDraft), so
    // this naturally no-ops for them — only step 1 drives the primary status.
    //
    // instantly_campaign_id IS NULL is the "not handed off yet" guard, the same
    // predicate campaign-fanout uses to pick eligible leads. Without it, approving
    // a draft that finished regenerating AFTER the send had already gone out
    // rewound the lead from 'sent' back to 'approved' — leaving a lead Instantly
    // had genuinely mailed (and later followed up on) still wearing a "Certified"
    // pill. Seen live on APOLLO CAMPAIGN 1: sent 11:12:20, approved 11:13:04.
    await db.from("campaign_leads")
      .update({ crm_status: "approved", updated_at: now })
      .eq("draft_id", id)
      .is("instantly_campaign_id", null);
    await syncApprovedDraftToInstantly(db, draft.lead_id, draft.campaign_id);
    await logLeadEvent(db, draft.lead_id, "draft_approved", `Email draft approved${which}`, { actorId: user.id, metadata: draftMeta });
    return ok({ id, status: "approved" });
  }

  if (parsed.data.action === "reject") {
    if (!["draft", "approved"].includes(draft.status)) return fail(409, "CONFLICT", `Cannot reject a draft with status '${draft.status}'`);

    await db.from("email_drafts").update({ status: "rejected", rejection_reason: parsed.data.rejection_reason, updated_at: now }).eq("id", id);
    await db.from("campaign_leads").update({ crm_status: "enriched", draft_id: null, updated_at: now }).eq("draft_id", id);
    await logLeadEvent(db, draft.lead_id, "draft_rejected", `Email draft rejected${which}`, {
      actorId: user.id,
      metadata: { ...draftMeta, reason: parsed.data.rejection_reason ?? null },
    });
    return ok({ id, status: "rejected" });
  }

  if (parsed.data.action === "edit") {
    if (draft.status === "approved") return fail(409, "CONFLICT", "Cannot edit an approved draft — reopen it first");

    await db.from("email_drafts").update({ subject: parsed.data.subject, body: parsed.data.body, status: "draft", updated_at: now }).eq("id", id);
    await logLeadEvent(db, draft.lead_id, "draft_edited", `Email draft edited${which}`, { actorId: user.id, metadata: draftMeta });
    return ok({ id, status: "draft" });
  }

  if (parsed.data.action === "reopen") {
    if (draft.status !== "approved") return fail(409, "CONFLICT", `Cannot reopen a draft with status '${draft.status}'`);

    await db.from("email_drafts").update({
      status: "draft",
      approved_at: null,
      reviewed_by: null,
      updated_at: now,
    }).eq("id", id);
    await db.from("campaign_leads").update({ crm_status: "draft", updated_at: now }).eq("draft_id", id);
    await logLeadEvent(db, draft.lead_id, "draft_reopened", `Approved draft reopened for editing${which}`, { actorId: user.id, metadata: draftMeta });
    return ok({ id, status: "draft" });
  }

  if (parsed.data.action === "restore") {
    const { data: target } = await db
      .from("email_drafts")
      .select("id, lead_id, campaign_id, status")
      .eq("id", id)
      .maybeSingle();

    if (!target || target.lead_id !== draft.lead_id || target.campaign_id !== draft.campaign_id) {
      return fail(404, "NOT_FOUND", "Version not found in this draft chain");
    }

    if (target.status === "rejected") {
      await db.from("email_drafts").update({ status: "draft", updated_at: now }).eq("id", id);
    }

    // Same rule as everywhere else: only a step-1 restore may move the lead's
    // primary crm_status/draft_id — a follow-up's own version history must
    // never touch it.
    if (!isFollowUp) {
      await db.from("campaign_leads").update({
        draft_id: id,
        crm_status: target.status === "approved" ? "approved" : "draft",
        updated_at: now,
      }).eq("campaign_id", draft.campaign_id).eq("lead_id", draft.lead_id);
    }

    return ok({ id, status: target.status === "approved" ? "approved" : "draft" });
  }

  return fail(400, "VALIDATION_ERROR", "Unknown action");
}
