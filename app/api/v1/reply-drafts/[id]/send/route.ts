import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { sendThreadReply } from "@/lib/services/unibox";
import { assertReplyDraftAccess } from "@/lib/auth/scope";
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertReplyDraftAccess(db, user, id); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => ({})) as { cc?: unknown; bcc?: unknown };
  const cc = normalizeEmailList(body.cc);
  const bcc = normalizeEmailList(body.bcc);
  if (cc == null || bcc == null) {
    return fail(400, "VALIDATION_ERROR", "cc and bcc must be arrays of up to 10 valid emails");
  }
  const ccSet = new Set(cc);
  if (bcc.some((e) => ccSet.has(e))) {
    return fail(400, "VALIDATION_ERROR", "An address cannot be in both CC and BCC");
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

  try {
    const bodyHtml = claimed.body.replace(/\n/g, "<br>");
    await sendThreadReply(db, {
      replyToUuid: claimed.reply_to_uuid,
      eaccount: claimed.eaccount,
      subject: claimed.subject,
      bodyHtml,
      bodyText: claimed.body,
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
