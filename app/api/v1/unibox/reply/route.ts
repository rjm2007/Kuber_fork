import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getThreadMessages, resolveReplyTarget, sendThreadReply } from "@/lib/services/unibox";
import { assertThreadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { parseAddressList } from "@/lib/thread-participants";

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
    /** Full To list. The answered message's sender is always addressed by
     *  Instantly regardless; anything else here rides in additional_recipients. */
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    reply_draft_id?: string;
    /** Which message in the thread to answer. Instantly addresses the reply to
     *  THIS message's sender, so it is how the caller picks the recipient.
     *  Omitted = the newest inbound message, the previous fixed behaviour. */
    reply_to_uuid?: string;
  } | null;

  if (!body?.thread_id || !body.body_html) {
    return fail(400, "VALIDATION_ERROR", "thread_id and body_html required");
  }

  const to = normalizeEmailList(body.to);
  const cc = normalizeEmailList(body.cc);
  const bcc = normalizeEmailList(body.bcc);
  if (to == null || cc == null || bcc == null) {
    return fail(400, "VALIDATION_ERROR", "to, cc and bcc must be arrays of up to 10 valid emails");
  }
  const ccSet = new Set(cc);
  if (bcc.some((e) => ccSet.has(e))) {
    return fail(400, "VALIDATION_ERROR", "An address cannot be in both CC and BCC");
  }
  // One address, one place. Sending the same person as both a To and a CC on the
  // same mail is a mistake every time, and Instantly would happily do it.
  const toSet = new Set(to);
  if (cc.some((e) => toSet.has(e)) || bcc.some((e) => toSet.has(e))) {
    return fail(400, "VALIDATION_ERROR", "An address cannot be in both TO and CC/BCC");
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

  // Targeted reply: answer a specific message rather than whichever arrived
  // last. Validated against this thread — an unchecked client-supplied uuid
  // would address the mail to an arbitrary conversation's participant.
  let replyToUuid = thread.reply_to_uuid;
  let eaccount = thread.eaccount;
  if (body.reply_to_uuid && body.reply_to_uuid !== replyToUuid) {
    const target = await resolveReplyTarget(db, body.thread_id, body.reply_to_uuid);
    if (!target) {
      return fail(400, "INVALID_TARGET", "That message is not one you can reply to in this thread");
    }
    replyToUuid = target.instantlyEmailId;
    // The mailbox that received the targeted message owns the reply, which is
    // not necessarily the one that received the newest message.
    eaccount = target.eaccount ?? eaccount;
  }

  // Instantly addresses the answered message's sender automatically and offers
  // no way to drop them, so they are removed from the caller's To list rather
  // than sent twice. Everything else becomes additional_recipients — real To
  // recipients, not CC.
  // A reply threads on reply_to_uuid, so the subject is a courtesy line rather
  // than routing — required here only because the client always had one to send.
  // It does not always: a thread where the lead never replied has no received
  // message to seed "Re: ..." from, and rejecting that left the composer unable
  // to send at all. Fall back to the newest subject anywhere in the thread, then
  // to a plain "Re:", so chasing a silent lead is never blocked.
  const threadSubject = [...thread.messages]
    .reverse()
    .find((m) => m.subject?.trim())?.subject?.trim();
  const subject = body.subject?.trim()
    || (threadSubject ? `Re: ${threadSubject.replace(/^Re:\s*/i, "")}` : "Re:");

  const forcedTo = parseAddressList(
    thread.messages.find((m) => m.instantly_email_id === replyToUuid)?.from_email ?? null,
  )[0] ?? null;
  const additionalTo = to.filter((e) => e !== forcedTo);

  const result = await sendThreadReply(db, {
    replyToUuid,
    eaccount,
    subject,
    bodyHtml: body.body_html,
    bodyText: body.body_text,
    additionalTo: additionalTo.length ? additionalTo : undefined,
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
