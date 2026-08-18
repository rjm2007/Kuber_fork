"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Save, Check, ThumbsDown, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { ReplyAttachButton, ReplyAttachmentChips } from "@/components/app/reply-attach-controls";
import { ReplyCcBccFields, normalizeReplyEmails, validateCcBcc } from "@/components/app/reply-cc-bcc-fields";
import { LeadExcludedWarning, ReplyToField } from "@/components/app/reply-recipients";
import type { ReplyRecipientContext } from "@/components/app/manual-reply-box";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  editReplyDraft,
  approveReplyDraft,
  rejectReplyDraft,
  sendReplyDraft,
  regenerateReplyDraft,
  type ReplyDraft,
} from "@/lib/api-client";
import { normalizeReplyBodyHtml } from "@/lib/reply-body-html";
import { appendReplyAttachments, type ReplyAttachment } from "@/lib/reply-attachments";

const DRAFT_STATUS_STYLE: Record<string, string> = {
  generating: "bg-secondary text-muted-foreground",
  draft: "bg-blue-500/15 text-blue-400",
  approved: "bg-cyan-500/15 text-cyan-400",
  sent: "bg-green-500/15 text-green-400",
  failed: "bg-red-500/15 text-red-400",
  rejected: "bg-red-500/10 text-red-400/70",
};

/** True when the draft has real subject/body text (ignores empty HTML shells). */
export function replyDraftHasContent(draft: Pick<ReplyDraft, "subject" | "body"> | null | undefined): boolean {
  if (!draft) return false;
  if (draft.subject?.trim()) return true;
  const text = (draft.body ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
  return text.length > 0;
}

interface ReplyDraftBoxProps {
  draft: ReplyDraft;
  token: string;
  onChanged: () => void;
  /** When true, starts with blank subject/body for manual composition instead of
   *  prefilling the AI-generated content — the user can opt into AI via the
   *  "Generate with AI" button instead. */
  startBlank?: boolean;
  /** Writes a brand-new AI draft for the thread, discarding what is in the
   *  editor. Sits beside Regenerate, which instead rewrites this draft and can
   *  take an instruction. Omit to hide it. */
  onNewAiDraft?: () => void;
  newAiDraftPending?: boolean;
  /** Thread participants, when the caller knows them (Unibox). Omitted by the
   *  campaign Outbox, which keeps the previous answer-the-newest behaviour. */
  recipients?: ReplyRecipientContext;
}

export function ReplyDraftBox({
  draft,
  token,
  onChanged,
  startBlank = false,
  onNewAiDraft,
  newAiDraftPending = false,
  recipients,
}: ReplyDraftBoxProps) {
  const [draftId, setDraftId] = useState(draft.id);
  const [status, setStatus] = useState(draft.status);
  const [subject, setSubject] = useState(startBlank ? "" : draft.subject ?? "");
  const [body, setBody] = useState(() => (startBlank ? "" : normalizeReplyBodyHtml(draft.body ?? "")));
  const [aiUsed, setAiUsed] = useState(!startBlank);
  const [error, setError] = useState(draft.error);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenQuery, setRegenQuery] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [to, setTo] = useState<string[]>(recipients?.to ?? []);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const regenTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Toggling "Regenerate" only reveals a small panel right below the button —
  // easy to read as "the click did nothing" if focus doesn't move there.
  useEffect(() => {
    if (!regenOpen) return;
    const id = requestAnimationFrame(() => regenTextareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [regenOpen]);

  // Rehydrate when the draft row changes (e.g. after regenerate creates a new
  // version). Do not depend on subject/body — that would wipe in-progress edits
  // whenever the parent silently refreshes.
  useEffect(() => {
    setDraftId(draft.id);
    setStatus(draft.status);
    setError(draft.error);
    setAttachments([]);
    setTo(recipients?.to ?? []);
    setCc([]);
    setBcc([]);
    if (replyDraftHasContent(draft)) {
      setSubject(draft.subject ?? "");
      setBody(normalizeReplyBodyHtml(draft.body ?? ""));
      setAiUsed(true);
    } else if (!startBlank) {
      setSubject(draft.subject ?? "");
      setBody(normalizeReplyBodyHtml(draft.body ?? ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when draft row identity changes
  }, [draft.id]);

  // Re-seed To when the target or the Reply/Reply-all choice changes.
  // Deliberately separate from the rehydrate effect above: folding it in there
  // would also re-run the subject/body reset and wipe an in-progress edit every
  // time the user picked a different message to answer.
  const toKey = (recipients?.to ?? []).join(",");
  useEffect(() => {
    if (!recipients) return;
    setTo(recipients.to);
    setCc([]);
    setBcc([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toKey stands in for the array identity
  }, [recipients?.replyToUuid, toKey]);

  // Bake pending chips into the body as download links. TipTap has no Image
  // extension, so inline <img> would be stripped on the next editor sync —
  // Instantly also has no attachment field, so a hosted link is what the lead
  // actually receives (same as campaign emails).
  function bodyWithAttachments(current = body): string {
    if (attachments.length === 0) return current;
    return appendReplyAttachments(current, attachments, { inlineImages: false });
  }

  // Parent thread (Outbox / Unibox) owns the mail-style row after send —
  // do not flash a chat bubble here.
  if (status === "sent") return null;

  async function handleSave() {
    setSaving(true);
    try {
      const nextBody = bodyWithAttachments();
      const updated = await editReplyDraft(token, draftId, subject, nextBody);
      setBody(nextBody);
      setAttachments([]);
      setStatus(updated.status);
      toast.success("Reply draft saved");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    setSaving(true);
    try {
      const nextBody = bodyWithAttachments();
      const updated = await approveReplyDraft(token, draftId, subject, nextBody);
      setBody(nextBody);
      setAttachments([]);
      setStatus(updated.status);
      toast.success("Reply approved");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSend() {
    const ccN = normalizeReplyEmails(cc);
    const bccN = normalizeReplyEmails(bcc);
    const listErr = validateCcBcc(ccN, bccN);
    if (listErr) {
      toast.error(listErr);
      return;
    }
    setSending(true);
    try {
      if (attachments.length > 0) {
        const nextBody = bodyWithAttachments();
        await editReplyDraft(token, draftId, subject, nextBody);
        setBody(nextBody);
        setAttachments([]);
      }
      await sendReplyDraft(token, draftId, {
        ...(to.length ? { to: normalizeReplyEmails(to) } : {}),
        ...(ccN.length ? { cc: ccN } : {}),
        ...(bccN.length ? { bcc: bccN } : {}),
        ...(recipients?.replyToUuid ? { reply_to_uuid: recipients.replyToUuid } : {}),
      });
      setStatus("sent");
      toast.success("Reply sent");
      onChanged();
    } catch (e) {
      const msg = (e as Error).message ?? "Failed to send reply";
      toast.error(
        msg.includes("MISSING_THREAD")
          ? "Cannot send: the original email reference has expired in Instantly. Regenerate the reply to get a fresh thread reference."
          : msg,
      );
    } finally {
      setSending(false);
    }
  }

  async function handleReject() {
    setSaving(true);
    try {
      const updated = await rejectReplyDraft(token, draftId);
      setStatus(updated.status);
      toast.success("Reply rejected");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    // Same rule as the campaign drawer, but only once an AI draft exists:
    // the first "Generate with AI" legitimately has nothing to revise.
    if (aiUsed && !regenQuery.trim()) return;
    setRegenerating(true);
    try {
      const updated = await regenerateReplyDraft(token, draftId, regenQuery || undefined);
      setDraftId(updated.id);
      setSubject(updated.subject ?? "");
      setBody(normalizeReplyBodyHtml(updated.body ?? ""));
      setStatus(updated.status);
      setError(updated.error);
      setAiUsed(true);
      setAttachments([]);
      setRegenOpen(false);
      setRegenQuery("");
      toast.success(aiUsed ? "Reply regenerated" : "AI reply generated");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div className="enter swatch-bar w-full rounded-xl rounded-br-sm border border-primary/20 bg-primary/5 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-primary/10 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="leading-tight">
            <p className="eyebrow">AI draft · review</p>
            <span className="font-display text-xs font-semibold text-primary">Your reply</span>
          </div>
          <Badge variant="outline" className={cn("rounded-md border-transparent font-mono text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5", DRAFT_STATUS_STYLE[status] ?? "")}>
            {status}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {/* Only meaningful once there is AI text to throw away — while the box
              is still blank the button on the right already reads
              "Generate with AI" and does the same job. */}
          {aiUsed && onNewAiDraft && (
            <Button
              size="sm"
              variant="ghost"
              disabled={regenerating || newAiDraftPending}
              onClick={onNewAiDraft}
              className="h-6 gap-1 text-[11px] px-2 text-primary hover:text-primary"
              title="Write a fresh AI draft, discarding what is in the editor"
            >
              {newAiDraftPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
              {newAiDraftPending ? "Generating…" : "New AI draft"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={regenerating || newAiDraftPending}
            onClick={() => (aiUsed ? setRegenOpen((o) => !o) : void handleRegenerate())}
            className={cn(
              "h-6 gap-1 text-[11px] px-2",
              aiUsed && regenOpen ? "text-primary bg-primary/10 hover:text-primary hover:bg-primary/10" :
              aiUsed ? "text-muted-foreground hover:text-foreground" : "text-primary hover:text-primary",
            )}
          >
            {regenerating ? (
              <Loader2 className="size-3 animate-spin" />
            ) : aiUsed ? (
              <RotateCcw className="size-3" />
            ) : (
              <Sparkles className="size-3" />
            )}
            {regenerating ? "Generating…" : aiUsed ? "Regenerate" : "Generate with AI"}
          </Button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {recipients && (
          <>
            <ReplyToField
              to={to}
              onChange={setTo}
              lockedTo={recipients.lockedTo}
              suggestions={recipients.participants}
              disabled={saving || sending || regenerating}
            />
            <LeadExcludedWarning
              to={to}
              cc={cc}
              bcc={bcc}
              leadEmail={recipients.leadEmail}
              leadName={recipients.leadName}
            />
          </>
        )}
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="text-sm font-medium" />
        <ReplyCcBccFields
          token={token}
          cc={cc}
          bcc={bcc}
          onCcChange={setCc}
          onBccChange={setBcc}
          disabled={saving || sending || regenerating}
        />
        <RichTextEditor value={body} onChange={setBody} minHeight={180} />
        <ReplyAttachmentChips
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
        />

        <div className="flex items-center gap-2 flex-wrap">
          <ReplyAttachButton
            token={token}
            disabled={saving || sending}
            currentCount={attachments.length}
            onUploaded={(a) => setAttachments((prev) => [...prev, a])}
          />
          <Button size="sm" variant="outline" disabled={saving} onClick={() => void handleSave()} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
          </Button>

          {status !== "approved" && (
            <Button size="sm" disabled={saving} onClick={() => void handleApprove()} className="gap-1.5">
              <Check className="size-3.5" /> Approve
            </Button>
          )}

          {status === "approved" && (
            <Button size="sm" disabled={sending} onClick={() => void handleSend()} className="gap-1.5 bg-green-600 hover:bg-green-700">
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send reply
            </Button>
          )}

          {status === "draft" && (
            <Button size="sm" variant="outline" disabled={saving} onClick={() => void handleReject()} className="gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10">
              <ThumbsDown className="size-3.5" /> Reject
            </Button>
          )}
        </div>

        {regenOpen && (
          <div className="enter swatch-bar-top rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
            <p className="eyebrow">Regenerate instructions</p>
            <Textarea
              ref={regenTextareaRef}
              value={regenQuery}
              onChange={(e) => setRegenQuery(e.target.value)}
              rows={3}
              placeholder={aiUsed ? 'Describe the change, e.g. "remove the last paragraph"…' : "Optional instruction, e.g. Focus on pricing…"}
              className="text-sm resize-y"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleRegenerate(); }}
            />
            <Button size="sm" disabled={regenerating || (aiUsed && !regenQuery.trim())} onClick={() => void handleRegenerate()} className="gap-1.5">
              {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : (aiUsed ? <RotateCcw className="size-3.5" /> : <Sparkles className="size-3.5" />)}
              {aiUsed ? "Regenerate" : "Generate with AI"}
            </Button>
          </div>
        )}

        {status === "failed" && error && (
          <p className="font-mono text-xs text-red-400 mt-1">Error: {error}</p>
        )}
      </div>
    </div>
  );
}
