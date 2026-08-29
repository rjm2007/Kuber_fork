import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { generateReplyDraft } from "@/lib/services/generate-reply";
import { assertThreadAccess } from "@/lib/auth/scope";
import { stripQuotedText } from "@/lib/email-display";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 55;

/**
 * On-demand AI reply draft — the ONLY path that starts a reply generation.
 *
 * Drafting used to fire automatically the moment a reply landed (webhook →
 * /api/internal/process-reply) and again whenever someone opened the Reply
 * composer. Both were removed: the LLM now runs only when a human presses the
 * "AI draft" button, which is what this route serves. Do not re-add an
 * automatic caller — the whole point is that no draft exists until asked for.
 *
 * Accepts either a Unibox `thread_id` or an Outbox `campaign_lead_id`; both
 * resolve to the same thing, the newest inbound message we hold for that
 * conversation.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const b = (await req.json().catch(() => ({}))) as {
    thread_id?: string;
    campaign_lead_id?: string;
    instruction?: string;
  };
  if (!b.thread_id && !b.campaign_lead_id) {
    return fail(400, "VALIDATION_ERROR", "thread_id or campaign_lead_id required");
  }

  const db = dbForUser(user);

  // Self-heal: any draft left in 'generating' by a crashed run would otherwise
  // keep the composer stuck on the spinner forever.
  try { await db.rpc("reset_stuck_reply_drafts", { stale_minutes: 5 }); } catch { /* non-fatal */ }

  let inboundQuery = db
    .from("unibox_emails")
    .select("*")
    .eq("direction", "received")
    .order("timestamp_email", { ascending: false })
    .limit(1);
  inboundQuery = b.thread_id
    ? inboundQuery.eq("thread_id", b.thread_id)
    : inboundQuery.eq("campaign_lead_id", b.campaign_lead_id!);

  const { data: inboundRows } = await inboundQuery;
  const inbound = inboundRows?.[0];
  if (!inbound) {
    return fail(404, "NO_INBOUND", "No inbound reply to draft against in this thread");
  }

  try {
    await assertThreadAccess(db, user, {
      campaignId: inbound.campaign_id as string | null,
      campaignLeadId: inbound.campaign_lead_id as string | null,
    });
  } catch (r) {
    return r as Response;
  }

  // reply_drafts.reply_event_id is NOT NULL, so a draft can only exist once the
  // reply has been attributed to a campaign event. The mirror can run ahead of
  // that when the webhook was missed and only the Unibox sync ingested the mail.
  let replyEventId = (inbound.reply_event_id as string | null) ?? null;
  if (!replyEventId && inbound.campaign_lead_id) {
    const { data: ev } = await db
      .from("reply_events")
      .select("id")
      .eq("campaign_lead_id", inbound.campaign_lead_id)
      .eq("event_type", "reply_received")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    replyEventId = ev?.id ?? null;
  }
  if (!replyEventId) {
    return fail(
      409,
      "NO_REPLY_EVENT",
      "This reply is not linked to a campaign yet — sync the campaign Outbox and try again",
    );
  }

  const masterCampaignId = (inbound.campaign_id as string | null) ?? null;
  let campaignName = "Campaign";
  let aiPromptContext: string | null = null;
  if (masterCampaignId) {
    const { data: c } = await db
      .from("campaigns")
      .select("name, ai_prompt_context")
      .eq("id", masterCampaignId)
      .maybeSingle();
    if (c) { campaignName = c.name; aiPromptContext = c.ai_prompt_context ?? null; }
  }

  const { data: ev } = await db
    .from("reply_events")
    .select("reply_body, reply_subject")
    .eq("id", replyEventId)
    .maybeSingle();
  const replyText =
    ev?.reply_body
    ?? stripQuotedText(inbound.body_text as string | null)
    ?? (inbound.body_text as string | null)
    ?? "";

  // Our side of the conversation, straight from the mirror — no Instantly call
  // needed for the fallback context in generateReplyDraft.
  let originalEmailText: string | null = null;
  if (inbound.thread_id) {
    const { data: ours } = await db
      .from("unibox_emails")
      .select("body_text")
      .eq("thread_id", inbound.thread_id)
      .neq("direction", "received")
      .order("timestamp_email", { ascending: true })
      .limit(1);
    originalEmailText = (ours?.[0]?.body_text as string | null)?.trim() || null;
  }

  // Versioned off whatever the thread already has so the history stays a chain,
  // exactly as /reply-drafts/[id]/regenerate does.
  const { data: siblings } = await db
    .from("reply_drafts")
    .select("id, version")
    .eq("reply_event_id", replyEventId)
    .order("version", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  const previous = siblings?.[0] ?? null;

  const { data: rd, error } = await db
    .from("reply_drafts")
    .insert({
      reply_event_id: replyEventId,
      campaign_lead_id: inbound.campaign_lead_id ?? null,
      campaign_id: masterCampaignId,
      status: "generating",
      reply_to_uuid: inbound.instantly_email_id ?? null,
      eaccount: inbound.eaccount ?? null,
      version: (previous?.version ?? 0) + 1,
      parent_reply_draft_id: previous?.id ?? null,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !rd) return fail(500, "INTERNAL", error?.message ?? "Could not create the draft");

  const result = await generateReplyDraft(db, {
    companyId: user.companyId ?? "any",
    replyDraftId: rd.id,
    masterCampaignId,
    campaignName,
    replyText,
    replySubject: (ev?.reply_subject as string | null) ?? (inbound.subject as string | null) ?? null,
    originalEmailText,
    threadId: (inbound.thread_id as string | null) ?? null,
    aiPromptContext,
    customInstruction: b.instruction,
  });

  const { data: fresh } = await db.from("reply_drafts").select("*").eq("id", rd.id).maybeSingle();
  return result.ok ? ok(fresh) : fail(500, "GENERATION_FAILED", "Could not generate the reply draft");
}
