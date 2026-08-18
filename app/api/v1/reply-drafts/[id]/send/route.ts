import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { resolveReplyTarget, sendThreadReply, threadIdForInstantlyEmail } from "@/lib/services/unibox";
import { assertReplyDraftAccess } from "@/lib/auth/scope";
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertReplyDraftAccess(db, user, id); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => ({})) as {
    to?: unknown; cc?: unknown; bcc?: unknown; reply_to_uuid?: unknown;
  };
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
  const toSet = new Set(to);
  if (cc.some((e) => toSet.has(e)) || bcc.some((e) => toSet.has(e))) {
    return fail(400, "VALIDATION_ERROR", "An address cannot be in both TO and CC/BCC");
  }

  // Atomic claim (planning.md Phase 6.3): flip draft/approved → sending in one
  // guarded UPDATE. Two rapid clicks race on this row — exactly one gets it;
  // the other sees zero rows and 409s, so the customer can never receive the
  // reply twice. The approval gate is built into the WHERE (rejected/failed/
  // generating rows never match).
  const { data: claimed } = await db
    .from("reply_drafts")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["draft", "approved"])
    .select("*")
    .maybeSingle();

  if (!claimed) {
    const { data: rd } = await db.from("reply_drafts").select("status").eq("id", id).maybeSingle();
    if (!rd) return fail(404, "NOT_FOUND", "Reply draft not found");
    if (rd.status === "sent" || rd.status === "sending") {
      return fail(409, "ALREADY_SENT", "This reply was already sent");
    }
    return fail(409, "NOT_SENDABLE", `A reply in status '${rd.status}' cannot be sent`);
  }

  const previousStatus = "draft"; // safe rollback target: still requires review before re-send

  async function release(error?: string) {
    await db.from("reply_drafts")
      .update({ status: previousStatus, ...(error ? { error: error.slice(0, 500) } : {}), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "sending");
  }

  if (!claimed.reply_to_uuid || !claimed.eaccount) {
    await release();
    return fail(400, "MISSING_THREAD", "Missing reply_to_uuid or eaccount — cannot thread the reply");
  }
  if (!claimed.subject || !claimed.body) {
    await release();
    return fail(400, "EMPTY", "Reply subject/body is empty");
  }

  // Answer a specific message instead of the one this draft was generated
  // against — the AI-draft path needs the same targeting the manual composer
  // has, or a drafted reply to the lead still goes to whoever spoke last.
  // A reply_drafts row has no thread_id, so the thread is resolved from the
  // draft's own target first and the override is then checked against it.
  let replyToUuid = claimed.reply_to_uuid as string;
  let eaccount = claimed.eaccount as string;
  if (typeof body.reply_to_uuid === "string" && body.reply_to_uuid && body.reply_to_uuid !== replyToUuid) {
    const threadId = await threadIdForInstantlyEmail(db, replyToUuid);
    const target = threadId ? await resolveReplyTarget(db, threadId, body.reply_to_uuid) : null;
    if (!target) {
      await release();
      return fail(400, "INVALID_TARGET", "That message is not one you can reply to in this thread");
    }
    replyToUuid = target.instantlyEmailId;
    eaccount = target.eaccount ?? eaccount;
  }

  // Instantly always addresses the answered message's sender, so drop them from
  // the caller's To list instead of sending them the mail twice.
  const { data: targetRow } = await db
    .from("unibox_emails")
    .select("from_email")
    .eq("instantly_email_id", replyToUuid)
    .maybeSingle();
  const forcedTo = parseAddressList((targetRow?.from_email as string | null) ?? null)[0] ?? null;
  const additionalTo = to.filter((e) => e !== forcedTo);

  try {
    const bodyHtml = claimed.body.replace(/\n/g, "<br>");
    await sendThreadReply(db, {
      replyToUuid,
      eaccount,
      subject: claimed.subject,
      bodyHtml,
      bodyText: claimed.body,
      additionalTo: additionalTo.length ? additionalTo : undefined,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      campaignLeadId: claimed.campaign_lead_id,
      campaignId: claimed.campaign_id,
      replyEventId: claimed.reply_event_id,
      source: "campaign_replies",
      replyDraftId: claimed.id,
      sentBy: user.id,
    });
    return ok({ sent: true });
  } catch (err) {
    await release((err as Error).message);
    return fail(502, "INSTANTLY_ERROR", (err as Error).message);
  }
}
