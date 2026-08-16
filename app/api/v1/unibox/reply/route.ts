import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getThreadMessages, sendThreadReply } from "@/lib/services/unibox";
import { assertThreadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmailList(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const e = item.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) return null;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length > 10) return null;
  }
  return out;
}

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const body = await req.json().catch(() => null) as {
    thread_id?: string;
    subject?: string;
    body_html?: string;
    body_text?: string;
    cc?: unknown;
    bcc?: unknown;
    reply_draft_id?: string;
  } | null;

  if (!body?.thread_id || !body.subject || !body.body_html) {
    return fail(400, "VALIDATION_ERROR", "thread_id, subject, and body_html required");
  }

  const cc = normalizeEmailList(body.cc);
  const bcc = normalizeEmailList(body.bcc);
  if (cc == null || bcc == null) {
    return fail(400, "VALIDATION_ERROR", "cc and bcc must be arrays of up to 10 valid emails");
  }
  const ccSet = new Set(cc);
  if (bcc.some((e) => ccSet.has(e))) {
    return fail(400, "VALIDATION_ERROR", "An address cannot be in both CC and BCC");
  }

  const db = dbForUser(user);
  const thread = await getThreadMessages(db, body.thread_id);
  try {
    await assertThreadAccess(db, user, {
      campaignId: (thread.campaign as { id?: string } | null)?.id ?? null,
      campaignLeadId: thread.campaign_lead_id,
    });
  } catch (r) {
    return r as Response;
  }
  if (!thread.reply_to_uuid || !thread.eaccount) {
    return fail(400, "MISSING_THREAD", "No received message to reply to in this thread");
  }

  const result = await sendThreadReply(db, {
    replyToUuid: thread.reply_to_uuid,
    eaccount: thread.eaccount,
    subject: body.subject,
    bodyHtml: body.body_html,
    bodyText: body.body_text,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    campaignLeadId: thread.campaign_lead_id,
    campaignId: (thread.campaign as { id?: string } | null)?.id ?? null,
    source: "unibox",
    replyDraftId: body.reply_draft_id,
    sentBy: user.id,
  });

  return ok(result);
}
