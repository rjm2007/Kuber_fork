import type { SupabaseClient } from "@supabase/supabase-js";
import { generateOneDraft } from "@/lib/services/generate-drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";

/** Draft statuses a regeneration may start from. Anything else (sent, generating) is refused. */
export const REGENERATABLE_STATUSES = ["draft", "failed", "rejected", "approved"] as const;

/**
 * Statuses a BULK run is allowed to touch. Deliberately narrower than
 * REGENERATABLE_STATUSES: a bulk click must never silently undo a reviewer's
 * approval, so 'approved' (Certified) is excluded and stays a per-lead action.
 * 'rejected' is excluded too — those are superseded historical versions, not
 * the live draft.
 */
export const BULK_REGENERATABLE_STATUSES = ["draft", "failed"] as const;

export type DraftVersionRow = {
  id: string;
  subject: string | null;
  body: string | null;
  status: string;
  version: number;
};

export type RegenerateResult =
  | { ok: true; draft: DraftVersionRow }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" | "INTERNAL" | "GENERATION_FAILED"; reason: string };

/**
 * Regenerate a single draft, creating a new version of it.
 *
 * This is the one implementation of the regeneration dance, shared by the
 * single-draft route and the bulk worker so both version identically:
 *
 *   1. demote the current draft to 'rejected' ("superseded by regeneration")
 *   2. insert a new row with version + 1 and parent_draft_id pointing at it
 *   3. generate into that new row
 *   4. on success, repoint campaign_leads.draft_id (step 1 only)
 *   5. on ANY failure, restore the old draft to its original status
 *
 * Step 1 is not optional: uq_email_drafts_campaign_lead_step allows only one
 * draft per (campaign_id, lead_id, step_number) whose status is not
 * rejected/failed, so the old row must step aside before the new one exists.
 * Step 5 is what stops a failed regeneration from silently destroying an
 * already-approved email (planning.md Phase 6.2).
 *
 * Callers are responsible for authorisation — this runs with the admin client.
 */
export async function regenerateOneDraft(
  db: SupabaseClient,
  draftId: string,
  opts: {
    userId?: string;
    customInstruction?: string;
    /** Tags the resulting lead_events entry so the Activity tab shows it came from a bulk run. */
    bulkJobId?: string;
    /** Restricts which starting statuses are accepted; defaults to the full single-draft set. */
    allowedStatuses?: readonly string[];
  } = {},
): Promise<RegenerateResult> {
  const allowed = opts.allowedStatuses ?? REGENERATABLE_STATUSES;

  const { data: oldDraft } = await db
    .from("email_drafts")
    .select("id, status, lead_id, campaign_id, version, step_number, subject, body")
    .eq("id", draftId)
    .maybeSingle();

  if (!oldDraft) return { ok: false, code: "NOT_FOUND", reason: "Draft not found" };

  if (!allowed.includes(oldDraft.status)) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: `Cannot regenerate a draft with status '${oldDraft.status}'`,
    };
  }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, human_in_loop, ai_prompt_context")
    .eq("id", oldDraft.campaign_id)
    .maybeSingle();

  if (!campaign) return { ok: false, code: "NOT_FOUND", reason: "Campaign not found" };

  const { data: cl } = await db
    .from("campaign_leads")
    .select(`
      id, lead_id,
      attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
      leads!lead_id(
        id, first_name, last_name, email, title, headline, seniority, city, country, assigned_to,
        organizations(name, domain, website, industry, employees, city, country, company_description, sells_to, keywords)
      )
    `)
    .eq("campaign_id", oldDraft.campaign_id)
    .eq("lead_id", oldDraft.lead_id)
    .maybeSingle();

  if (!cl) return { ok: false, code: "NOT_FOUND", reason: "Campaign lead not found" };

  const nextVersion = (oldDraft.version ?? 1) + 1;

  // Re-assert `allowed` in the WHERE clause, not just in the check above. Several
  // database round-trips separate that check from this write, and a user pressing
  // Certify inside that window used to be steamrolled: the status read said
  // 'draft', the approval landed, and this update then demoted an APPROVED draft
  // to 'rejected' anyway. One lead on APOLLO CAMPAIGN 1 was certified 1.3s before
  // a bulk job reached it, got regenerated out from under the approval, and was
  // sent and followed up on while still displaying "Certified".
  //
  // A single UPDATE ... WHERE status IN (...) is atomic, so the loser of the race
  // now matches zero rows and backs out instead of overwriting the winner.
  const { data: demoted } = await db.from("email_drafts").update({
    status: "rejected",
    rejection_reason: "superseded by regeneration",
    updated_at: new Date().toISOString(),
  }).eq("id", draftId).in("status", allowed).select("id");

  if (!demoted || demoted.length === 0) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "Draft changed status while regeneration was starting — not regenerated",
    };
  }

  /** Puts the previous draft back the way it was, so a failure loses nothing. */
  async function revertOldDraft() {
    await db.from("email_drafts").update({
      status: oldDraft!.status,
      rejection_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", draftId);
  }

  const { data: newDraftRow, error: insertErr } = await db
    .from("email_drafts")
    .insert({
      lead_id: oldDraft.lead_id,
      campaign_id: oldDraft.campaign_id,
      status: "generating",
      version: nextVersion,
      parent_draft_id: oldDraft.id,
      step_number: oldDraft.step_number,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !newDraftRow) {
    await revertOldDraft();
    return { ok: false, code: "INTERNAL", reason: insertErr?.message ?? "Failed to create draft row" };
  }

  const result = await generateOneDraft(
    db,
    cl,
    oldDraft.campaign_id,
    campaign.human_in_loop,
    campaign.name,
    opts.userId,
    opts.customInstruction,
    campaign.ai_prompt_context ?? undefined,
    newDraftRow.id,
    oldDraft.step_number ?? 1,
    opts.bulkJobId,
    // Instruction regenerates must edit THIS email. Without the previous
    // subject/body the model only sees lead data + the instruction and rewrites
    // the whole message (e.g. "remove the last paragraph" becomes a new pitch).
    opts.customInstruction?.trim()
      ? { subject: oldDraft.subject, body: oldDraft.body }
      : null,
  );

  if (!result.ok) {
    // The new row is marked failed by generateOneDraft; revert the old draft
    // back to its original status so it remains the active version.
    await revertOldDraft();
    return { ok: false, code: "GENERATION_FAILED", reason: result.reason };
  }

  // generateOneDraft repoints campaign_leads.draft_id for step-1 drafts on
  // success; make sure it points at the new version even for edge paths.
  if ((oldDraft.step_number ?? 1) === 1) {
    await db.from("campaign_leads").update({
      draft_id: newDraftRow.id,
      updated_at: new Date().toISOString(),
    }).eq("id", cl.id);
  }

  const { data: newDraft } = await db
    .from("email_drafts")
    .select("id, subject, body, status, version")
    .eq("id", result.draftId)
    .single();

  // Instantly holds its OWN copy of the text, in that lead's customBodyN custom
  // variable, and reads it only once — when the lead is added. Rewriting the
  // draft in our database therefore changes nothing about what the customer
  // receives unless we push it.
  //
  // Gated on 'approved' because that is the point at which the text is meant to
  // go out. Opening emails under human-in-the-loop come back as 'draft' and are
  // pushed later by the certify path, so this is a no-op for them. Follow-ups
  // are auto-approved by design, so this IS their push — without it, a
  // regenerated follow-up looked correct in the UI while Instantly happily sent
  // the previous version.
  //
  // Best-effort: a regeneration that succeeded must not be reported as failed
  // because Instantly was briefly unreachable. The daily follow-up writer and
  // the certify path both re-sync from the same approved rows.
  if (newDraft?.status === "approved") {
    try {
      await syncApprovedDraftToInstantly(db, oldDraft.lead_id, oldDraft.campaign_id);
    } catch { /* pushed again by the next sync of this lead */ }
  }

  return { ok: true, draft: newDraft as DraftVersionRow };
}
