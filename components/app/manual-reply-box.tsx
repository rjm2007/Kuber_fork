"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { sendUniboxReply } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { ReplyAttachButton, ReplyAttachmentChips } from "@/components/app/reply-attach-controls";
import { appendReplyAttachments, type ReplyAttachment } from "@/lib/reply-attachments";

/**
 * Plain human-written reply — no AI, no reply_drafts row. Shared by Unibox and
 * campaign Outbox so both surfaces can answer a thread without an AI draft
 * existing first, which is the normal state now that drafting is opt-in.
 */
export function ManualReplyBox({
  threadId,
  token,
  replyToSubject,
  onSent,
  onCancel,
  onNewAiDraft,
  newAiDraftPending = false,
}: {
  threadId: string;
  token: string;
  replyToSubject: string | null;
  onSent: () => void;
  onCancel: () => void;
  /** Hands the reply over to the AI instead. This is the only place the first
   *  draft of a thread can be started from, since with no draft row there is no
   *  ReplyDraftBox header to carry the button. Omit to hide it. */
  onNewAiDraft?: () => void;
  newAiDraftPending?: boolean;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setSubject(replyToSubject ? `Re: ${replyToSubject.replace(/^Re:\s*/i, "")}` : "");
    setBody("");
    setAttachments([]);
  }, [threadId, replyToSubject]);

  const bodyText = body.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim();
  const canSend = subject.trim() && (bodyText.length > 0 || attachments.length > 0);

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    try {
      const bodyHtml = appendReplyAttachments(body.replace(/\n/g, "<br>"), attachments);
      await sendUniboxReply(token, {
        thread_id: threadId,
        subject,
        body_html: bodyHtml,
        body_text: [bodyText, ...attachments.map((a) => a.name)].filter(Boolean).join("\n"),
      });
      toast.success("Reply sent");
      onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="enter swatch-bar mt-4 rounded-xl border border-primary/20 bg-primary/5 overflow-hidden">
      <div className="px-4 py-2 border-b border-primary/10 flex items-center justify-between">
        <div>
          <p className="eyebrow">Manual reply</p>
          <span className="font-display text-xs font-semibold text-primary">Your reply</span>
        </div>
        <div className="flex items-center gap-2">
          {onNewAiDraft && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={newAiDraftPending}
              onClick={onNewAiDraft}
              className="h-6 gap-1 text-[11px] px-2 text-primary hover:text-primary"
              title="Write this reply with AI"
            >
              {newAiDraftPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
              {newAiDraftPending ? "Generating…" : "AI draft"}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-auto px-0 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground hover:bg-transparent"
          >
            Cancel
          </Button>
        </div>
      </div>
      <div className="p-4 space-y-3">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="text-sm" />
        <RichTextEditor value={body} onChange={setBody} placeholder="Write your reply…" minHeight={120} />
        <ReplyAttachmentChips
          attachments={attachments}
          onRemove={(i) => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
        />
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <ReplyAttachButton
            token={token}
            disabled={sending}
            currentCount={attachments.length}
            onUploaded={(a) => setAttachments((prev) => [...prev, a])}
          />
          <Button size="sm" disabled={sending || !canSend} onClick={() => void handleSend()} className="gap-1.5">
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send reply
          </Button>
        </div>
      </div>
    </div>
  );
}
