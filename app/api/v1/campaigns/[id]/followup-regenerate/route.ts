import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { FollowUpRegenerateSchema } from "@/lib/validators/drafts";
import { regenerateFollowUpText } from "@/lib/services/followup-regenerate";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { logLeadEvent } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";

// Deliberately separate from /drafts/[id]/regenerate (the step-1 draft's
// regenerate endpoint) and from generateOneDraft entirely. Follow-up
// regeneration only ever sees the current follow-up text + the user's
// instruction — no lead/org context, no product library, no shared prompt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = FollowUpRegenerateSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: cl } = await db
    .from("campaign_leads")
    .select("id, lead_id, campaign_id, leads!lead_id(first_name)")
    .eq("id", parsed.data.campaign_lead_id)
    .eq("campaign_id", id)
    .maybeSingle();

  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");

  const leadRow = Array.isArray(cl.leads) ? cl.leads[0] : cl.leads;

  let rewritten: { body: string };
  try {
    rewritten = await regenerateFollowUpText({
      leadFirstName: leadRow?.first_name ?? null,
      currentBody: parsed.data.body,
      instruction: parsed.data.instruction ?? "Rewrite this follow-up.",
    });
  } catch (e) {
    return fail(502, "GENERATION_FAILED", (e as Error).message);
  }

  const { data: existing } = await db
    .from("email_drafts")
    .select("id, version")
    .eq("campaign_id", id)
    .eq("lead_id", cl.lead_id)
    .eq("step_number", parsed.data.step_number)
    .not("status", "in", "(rejected,failed)")
    .maybeSingle();

  const now = new Date().toISOString();
  const eventMeta = { campaign_id: id, step: parsed.data.step_number };

  if (existing) {
    await db.from("email_drafts").update({
      status: "rejected",
      rejection_reason: "superseded by follow-up regeneration",
      updated_at: now,
    }).eq("id", existing.id);
    // This route never logged anything before — a regenerated follow-up
    // silently replaced the old draft with no trace on the activity timeline.
    await logLeadEvent(db, cl.lead_id, "draft_rejected", `Follow-up email draft superseded by regeneration (step ${parsed.data.step_number})`, {
      actorId: user.id, metadata: { ...eventMeta, draft_id: existing.id },
    });
  }

  const { data: draft, error } = await db
    .from("email_drafts")
    .insert({
      lead_id: cl.lead_id,
      campaign_id: id,
      step_number: parsed.data.step_number,
      subject: "", // follow-ups always thread as a reply
      body: rewritten.body,
      status: "draft",
      version: (existing?.version ?? 0) + 1,
      parent_draft_id: existing?.id ?? null,
      created_at: now,
    })
    .select("id, subject, body, status")
    .single();

  if (error || !draft) return fail(500, "INTERNAL", error?.message ?? "Failed to save regenerated draft");

  await logLeadEvent(db, cl.lead_id, "draft_created", `Follow-up email regenerated (step ${parsed.data.step_number})`, {
    actorId: user.id, metadata: { ...eventMeta, draft_id: draft.id },
  });

  return ok({ draft });
}
