import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { generateReplyDraft } from "@/lib/services/generate-reply";
import { assertReplyDraftAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const { instruction } = (await req.json().catch(() => ({}))) as { instruction?: string };
  const db = dbForUser(user);
  try { await assertReplyDraftAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: old } = await db.from("reply_drafts").select("*").eq("id", id).maybeSingle();
  if (!old) return fail(404, "NOT_FOUND", "Reply draft not found");

  const { data: ev } = await db.from("reply_events").select("reply_body, campaign_id").eq("id", old.reply_event_id).maybeSingle();
  const masterCampaignId = old.campaign_id ?? ev?.campaign_id ?? null;
  let campaignName = "Campaign";
  let aiPromptContext: string | null = null;
  if (masterCampaignId) {
    const { data: c } = await db.from("campaigns").select("name, ai_prompt_context").eq("id", masterCampaignId).maybeSingle();
    if (c) { campaignName = c.name; aiPromptContext = c.ai_prompt_context ?? null; }
  }

  const { data: rd, error } = await db.from("reply_drafts").insert({
    reply_event_id: old.reply_event_id,
    campaign_lead_id: old.campaign_lead_id,
    campaign_id: old.campaign_id,
    status: "generating",
    reply_to_uuid: old.reply_to_uuid,
    eaccount: old.eaccount,
    version: (old.version ?? 1) + 1,
    parent_reply_draft_id: old.id,
    created_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !rd) return fail(500, "INTERNAL", error?.message ?? "insert failed");

  const result = await generateReplyDraft(db, {
    companyId: user.companyId ?? "any",
    replyDraftId: rd.id,
    masterCampaignId,
    campaignName,
    replyText: ev?.reply_body ?? "",
    replySubject: old.subject,
    originalEmailText: null,
    threadId: null,
    aiPromptContext,
    customInstruction: instruction,
    // With an instruction, edit the current reply — don't rewrite from the thread.
    previousDraft: instruction?.trim()
      ? { subject: old.subject, body: old.body }
      : null,
  });

  const { data: fresh } = await db.from("reply_drafts").select("*").eq("id", rd.id).maybeSingle();
  return result.ok ? ok(fresh) : fail(500, "GENERATION_FAILED", "Regeneration failed");
}
