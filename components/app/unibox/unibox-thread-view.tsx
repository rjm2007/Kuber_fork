"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import Link from "next/link";
import { ChevronDown, CornerDownRight, ExternalLink, Loader2, Reply, ReplyAll, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { splitQuotedBody, emailPreview } from "@/lib/email-display";
import { sequenceStepLabel } from "@/lib/campaign-status";
import { convertResidualMarkdownInHtml } from "@/lib/utils/email-html";
import type { ReplyDraft, UniboxMessage } from "@/lib/api-client";
import { addThreadParticipantAsLead, generateReplyDraftForThread } from "@/lib/api-client";
import { ReplyDraftBox, replyDraftHasContent } from "@/components/app/reply-draft-box";
import { ManualReplyBox, type ReplyRecipientContext } from "@/components/app/manual-reply-box";
import { AddParticipantLeadDialog } from "@/components/app/add-participant-lead-dialog";
import {
  latestInboundMessage,
  ourAddresses,
  parseAddressList,
  replyRecipients,
  threadParticipants,
  unansweredInbound,
} from "@/lib/thread-participants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/leads/lead-ui";
import { EmptyState } from "@/components/ui/empty-state";

type Props = {
  messages: UniboxMessage[];
  leadName: string;
  leadEmail: string | null;
  campaign: { id: string; name: string } | null;
  threadId: string;
  token: string;
  canReply: boolean;
  latestDraft: ReplyDraft | null;
  replyToSubject: string | null;
  /** Our own mailbox on this thread, so it is never CC'd on our own reply. */
  eaccount: string | null;
  /** Thread addresses that are already leads — no "Add as lead" for them. */
  knownLeadEmails: string[];
  /** What a promoted participant inherits, shown before they confirm. */
  organizationName: string | null;
  ownerName: string | null;
  onChanged: () => void;
};

function QuotedBlock({ quoted, isHtml }: { quoted: string; isHtml: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 pt-2 border-t border-border/50">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        className="h-auto px-0 py-0 gap-1 text-[11px] font-normal text-muted-foreground hover:text-foreground hover:bg-transparent"
      >
        <span className="tracking-widest">⋯</span>
        {open ? "Hide quoted text" : "Show quoted text"}
      </Button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-muted-foreground/30 text-muted-foreground/90 text-xs leading-relaxed">
          {isHtml ? (
            <div
              className="[&_p]:mb-1.5 [&_blockquote]:opacity-80"
              dangerouslySetInnerHTML={{ __html: convertResidualMarkdownInHtml(quoted) }}
            />
          ) : (
            <p className="whitespace-pre-wrap">{quoted}</p>
          )}
        </div>
      )}
    </div>
  );
}

function MessageRow({
  m,
  campaign,
  leadName,
  leadEmail,
  expanded,
  onToggle,
  canReply,
  isReplyTarget,
  isUnanswered,
  inReplyToLabel,
  onReplyTo,
  onReplyAll,
  onAddAsLead,
  addingLead,
}: {
  m: UniboxMessage;
  campaign: { id: string; name: string } | null;
  leadName: string;
  leadEmail: string | null;
  expanded: boolean;
  onToggle: () => void;
  canReply: boolean;
  isReplyTarget: boolean;
  /** Nobody has replied to THIS person since they wrote. */
  isUnanswered: boolean;
  /** For our own replies: who wrote the message this one answered. */
  inReplyToLabel: string | null;
  onReplyTo: () => void;
  onReplyAll: () => void;
  /** Set only for a third participant who is not already a lead. */
  onAddAsLead: (() => void) | null;
  addingLead: boolean;
}) {
  const isOutbound = m.direction !== "received";
  const fromAddress = parseAddressList(m.from_email)[0] ?? null;
  const leadAddress = parseAddressList(leadEmail)[0] ?? null;
  const isFromLead = !!fromAddress && fromAddress === leadAddress;

  // Show WHO actually sent it (review §4.2) — a thread can be visible to more
  // than one teammate (campaign access + lead-assignment fallback), so
  // hardcoding "You" was misleading for anyone but the original sender.
  // Falls back to "Team" for auto-sent/cold-outreach messages with no known sender.
  //
  // Inbound used to render `leadName` unconditionally, so a reply from anyone
  // CC'd onto the thread appeared under the lead's name with nothing to say
  // otherwise — the reader had no way to tell two different people apart.
  const senderName = isOutbound
    ? (m.sent_by_name ?? "Team")
    : isFromLead
      ? leadName
      : (fromAddress ?? "Unknown sender");

  // Real headers, not an assumed counterparty: the old "to {leadName}" caption
  // claimed every outbound message reached the lead even when Instantly had
  // addressed it to whoever sent the message being answered.
  const toAddresses = parseAddressList(m.to_emails);
  const ccAddresses = parseAddressList(m.cc_emails);
  const { main, quoted } = useMemo(
    () => splitQuotedBody(m.body_html, m.body_text),
    [m.body_html, m.body_text],
  );
  const isHtml = !!m.body_html;
  const snippet = useMemo(
    () => emailPreview(m.body_text, m.body_html, 100),
    [m.body_text, m.body_html],
  );
  const isUnread = m.is_unread && !isOutbound;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-border/60 hover:bg-secondary/40 transition-colors",
          isUnread && "bg-primary/5",
        )}
      >
        <Avatar name={senderName} size="sm" />
        <span className={cn("shrink-0 max-w-[160px] truncate text-sm", isUnread ? "font-semibold" : "font-medium text-foreground/90")}>
          {senderName}
        </span>
        {!isOutbound && !isFromLead && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 text-muted-foreground">
            via cc
          </Badge>
        )}
        {/* Collapsed is how the thread is read at a glance, so the signal that
            demands action has to survive here — not only once expanded. */}
        {isUnanswered && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 border-amber-500/40 text-amber-500">
            Not answered
          </Badge>
        )}
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {snippet || "(empty message)"}
        </span>
        {isUnread && <span className="size-1.5 rounded-full bg-primary shrink-0" />}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {format(new Date(m.timestamp_email), "MMM d")}
        </span>
      </button>
    );
  }

  return (
    <div className={cn("border-b border-border/60", isUnread && "bg-primary/5")}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
      >
        <Avatar name={senderName} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{senderName}</span>
            {fromAddress && fromAddress !== senderName && (
              <span className="font-mono text-[11px] text-muted-foreground">{fromAddress}</span>
            )}
            {!isOutbound && !isFromLead && (
              <Badge variant="outline" className="rounded font-mono text-[9px] px-1.5 py-0.5 text-muted-foreground">
                not the lead
              </Badge>
            )}
            {/* Answering someone else does not answer this person — without
                this marker a prospect's question disappears behind a reply
                that went to a colleague CC'd onto the thread. */}
            {isUnanswered && (
              <Badge variant="outline" className="rounded font-mono text-[9px] px-1.5 py-0.5 border-amber-500/40 text-amber-500">
                Not answered
              </Badge>
            )}
            {isReplyTarget && (
              <Badge variant="selected" className="rounded font-mono text-[9px] px-1.5 py-0.5">
                Replying to this
              </Badge>
            )}
            {isUnread && (
              <Badge variant="selected" className="rounded font-mono text-[9px] px-1.5 py-0.5">
                Unread
              </Badge>
            )}
          </div>
          {/* Which message this answered. Without it a reply to a CC'd
              colleague is indistinguishable from a reply to the prospect —
              the thread just reads as one flat chain. */}
          {inReplyToLabel && (
            <p className="flex items-center gap-1 font-mono text-[11px] text-primary/80 truncate">
              <CornerDownRight className="size-3 shrink-0" />
              in reply to {inReplyToLabel}
            </p>
          )}
          <p className="font-mono text-xs text-muted-foreground truncate">
            to {toAddresses.length > 0 ? toAddresses.join(", ") : "—"}
            {ccAddresses.length > 0 && ` · cc ${ccAddresses.join(", ")}`}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2 text-[11px] text-muted-foreground">
          {campaign && isOutbound && (
            <Link
              href={`/campaigns/${campaign.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              {campaign.name}
              <ExternalLink className="size-2.5 opacity-70" />
            </Link>
          )}
          <span className="font-mono tabular-nums">{format(new Date(m.timestamp_email), "MMM d, h:mm a")}</span>
        </div>
      </button>
      <div className="px-4 pb-4 pl-[52px] text-sm">
        {main ? (
          isHtml ? (
            <div
              className="leading-relaxed [&_p]:mb-2 [&_p:last-child]:mb-0"
              dangerouslySetInnerHTML={{ __html: convertResidualMarkdownInHtml(main) }}
            />
          ) : (
            <p className="whitespace-pre-wrap">{main}</p>
          )
        ) : (
          <p className="text-muted-foreground italic">(empty message)</p>
        )}
        {quoted && <QuotedBlock quoted={quoted} isHtml={isHtml} />}
        {/* Instantly's raw step tag is "0_1_0" — meaningless to a salesperson.
            Same wording as the campaign Outbox so one thread reads identically
            in both places. */}
        {m.step && isOutbound && sequenceStepLabel(m.step) && (
          <span className="inline-block mt-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {sequenceStepLabel(m.step)}
          </span>
        )}
        {/* Answering a specific message is the only way to choose the
            recipient: Instantly derives the To from the message being replied
            to. Outbound messages are not targets — that would address the mail
            back at ourselves. */}
        {!isOutbound && canReply && (
          <div className="mt-2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReplyTo}
              className="h-7 gap-1.5 px-2 text-[11px] text-primary hover:text-primary"
            >
              <Reply className="size-3" />
              Reply to {senderName}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReplyAll}
              className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              title="Answer this message with everyone on the thread in the To line"
            >
              <ReplyAll className="size-3" />
              Reply all
            </Button>
            {/* A stakeholder who joins a thread is the strongest signal a cold
                sequence produces, and until someone presses this they exist
                only inside this one conversation. Never automatic — see the
                add-lead route for why. */}
            {onAddAsLead && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={addingLead}
                onClick={onAddAsLead}
                className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                title="Add this person as a lead in the same organization"
              >
                {addingLead ? <Loader2 className="size-3 animate-spin" /> : <UserPlus className="size-3" />}
                Add as lead
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function UniboxThreadView({
  messages,
  leadName,
  leadEmail,
  campaign,
  threadId,
  token,
  canReply,
  latestDraft,
  replyToSubject,
  eaccount,
  knownLeadEmails,
  organizationName,
  ownerName,
  onChanged,
}: Props) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  /** Which message the composer answers. null = the newest inbound one. */
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  /** Reply all seeds every participant into To; plain Reply seeds just one. */
  const [replyAll, setReplyAll] = useState(true);
  /** Participant the Add-as-lead dialog is open for. */
  const [addLeadFor, setAddLeadFor] = useState<string | null>(null);
  const [savingLead, setSavingLead] = useState(false);

  const sorted = useMemo(
    () => [...messages].sort((a, b) => a.timestamp_email.localeCompare(b.timestamp_email)),
    [messages],
  );

  // A thread can hold more people than us and the lead — anyone CC'd can reply
  // into it. These drive both the recipient bar and the reply-all default.
  const ourEmails = useMemo(() => ourAddresses(sorted, [eaccount]), [sorted, eaccount]);
  const leadAddress = useMemo(() => parseAddressList(leadEmail)[0] ?? null, [leadEmail]);
  const participants = useMemo(
    () => threadParticipants(sorted, { ourEmails, leadEmail }),
    [sorted, ourEmails, leadEmail],
  );
  const targetMessage = useMemo(
    () => sorted.find((m) => m.instantly_email_id === replyTargetId) ?? latestInboundMessage(sorted),
    [sorted, replyTargetId],
  );
  const unansweredIds = useMemo(
    () => new Set(unansweredInbound(sorted, ourEmails).map((m) => m.instantly_email_id)),
    [sorted, ourEmails],
  );

  // Replies grouped under what they answer. A reply whose parent is not in this
  // thread (or that predates the in_reply_to column) stays top-level rather than
  // disappearing.
  const repliesByParent = useMemo(() => {
    const ids = new Set(sorted.map((m) => m.instantly_email_id));
    const map = new Map<string, UniboxMessage[]>();
    for (const m of sorted) {
      const parent = m.in_reply_to_email_id;
      if (!parent || !ids.has(parent)) continue;
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent)!.push(m);
    }
    return map;
  }, [sorted]);
  const topLevelMessages = useMemo(() => {
    const ids = new Set(sorted.map((m) => m.instantly_email_id));
    return sorted.filter((m) => !m.in_reply_to_email_id || !ids.has(m.in_reply_to_email_id));
  }, [sorted]);
  const recipients: ReplyRecipientContext = useMemo(() => {
    // `to` is the address Instantly forces in; `cc` here is everyone else on
    // the thread. Reply all puts them all in To (Instantly's
    // additional_recipients), plain Reply addresses only the one person.
    const { to, cc } = replyRecipients(targetMessage, participants);
    return {
      to: replyAll ? [...to, ...cc] : to,
      lockedTo: to[0] ?? null,
      participants: participants.map((p) => p.email),
      leadEmail,
      leadName,
      replyToUuid: targetMessage?.instantly_email_id ?? null,
    };
  }, [targetMessage, participants, leadEmail, leadName, replyAll]);

  // Sender of the message each of our replies answered, for the "in reply to"
  // line. Recorded at send time, so it stays correct even when a reply carries
  // several To addresses.
  const senderByEmailId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of sorted) {
      const from = parseAddressList(m.from_email)[0];
      if (from) map.set(m.instantly_email_id, from);
    }
    return map;
  }, [sorted]);

  // Subject follows the message being answered, not whichever reply arrived
  // first — they differ once a second participant starts a sub-thread.
  const effectiveSubject = targetMessage?.subject ?? replyToSubject;

  useEffect(() => {
    setReplyOpen(false);
    setGenerating(false);
    setReplyTargetId(null);
    setReplyAll(true);
    const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    setExpandedIds(last ? new Set([last.id]) : new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const knownLeadSet = useMemo(
    () => new Set(knownLeadEmails.map((e) => e.trim().toLowerCase())),
    [knownLeadEmails],
  );

  async function handleConfirmAddLead(firstName: string, lastName: string) {
    if (!addLeadFor) return;
    setSavingLead(true);
    try {
      await addThreadParticipantAsLead(token, threadId, {
        email: addLeadFor,
        first_name: firstName,
        last_name: lastName || undefined,
      });
      toast.success(`${firstName} added as a lead`);
      setAddLeadFor(null);
      onChanged();
    } catch (e) {
      const err = e as Error & { code?: string };
      toast.error(
        err.code === "DUPLICATE" ? "This person is already a lead" : err.message,
      );
    } finally {
      setSavingLead(false);
    }
  }

  function handleReplyTo(m: UniboxMessage, all: boolean) {
    setReplyTargetId(m.instantly_email_id);
    setReplyAll(all);
    setExpandedIds((prev) => new Set(prev).add(m.id));
    setReplyOpen(true);
  }

  function toggle(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasDraftReady = !!latestDraft && latestDraft.status !== "generating" && latestDraft.status !== "sent" && latestDraft.status !== "rejected";
  const isGenerating = latestDraft?.status === "generating" || generating;

  // Opening the composer is just a toggle — it never starts an AI draft. That
  // only happens when "AI draft" below is pressed.
  function handleReplyClick() {
    setReplyOpen((open) => !open);
  }

  async function handleGenerateClick() {
    setReplyOpen(true);
    setGenerating(true);
    try {
      await generateReplyDraftForThread(token, { thread_id: threadId });
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  if (messages.length === 0) {
    return (
      <div className="p-6">
        <EmptyState boxed={false} message="No messages in this thread yet." />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <AddParticipantLeadDialog
        open={!!addLeadFor}
        email={addLeadFor}
        organizationName={organizationName}
        ownerName={ownerName}
        saving={savingLead}
        onCancel={() => setAddLeadFor(null)}
        onConfirm={(f, l) => void handleConfirmAddLead(f, l)}
      />
      <div className="enter rounded-xl border border-border bg-field dark:bg-card overflow-hidden mx-6 mt-6">
        {topLevelMessages.map((m) => {
          const row = (msg: UniboxMessage) => (
            <MessageRow
              m={msg}
              campaign={campaign}
              leadName={leadName}
              leadEmail={leadEmail}
              expanded={expandedIds.has(msg.id)}
              onToggle={() => toggle(msg.id)}
              canReply={canReply}
              // Only while the composer is open — otherwise the badge reads as a
              // permanent property of the message ("this is the one being
              // answered") rather than the state of a reply you are writing.
              isReplyTarget={replyOpen && msg.instantly_email_id === targetMessage?.instantly_email_id}
              isUnanswered={unansweredIds.has(msg.instantly_email_id)}
              inReplyToLabel={
                msg.in_reply_to_email_id
                  ? senderByEmailId.get(msg.in_reply_to_email_id) ?? null
                  : null
              }
              onReplyTo={() => handleReplyTo(msg, false)}
              onReplyAll={() => handleReplyTo(msg, true)}
              onAddAsLead={(() => {
                const from = parseAddressList(msg.from_email)[0];
                const isThirdParty =
                  msg.direction === "received" && !!from && from !== leadAddress && !ourEmails.has(from);
                if (!isThirdParty || knownLeadSet.has(from)) return null;
                return () => setAddLeadFor(from);
              })()}
              addingLead={savingLead && addLeadFor === parseAddressList(msg.from_email)[0]}
            />
          );
          const children = repliesByParent.get(m.instantly_email_id) ?? [];
          return (
            <Fragment key={m.id}>
              {row(m)}
              {/* Our replies sit under the message they answer, so an
                  unanswered question is visible as a branch with nothing
                  beneath it rather than a line lost in a flat chain. Exactly
                  one level deep: only inbound messages can be replied to, so a
                  child can never have children of its own. */}
              {children.map((child) => (
                <div key={child.id} className="border-l-2 border-primary/25 bg-secondary/20 pl-4">
                  {row(child)}
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>

      <div className="px-6 pb-6 pt-4">
        {canReply && (
          <Button
            size="sm"
            onClick={handleReplyClick}
            className="gap-1.5 rounded-full px-4"
          >
            <Reply className="size-3.5" />
            Reply
            <ChevronDown className={cn("size-3.5 transition-transform", replyOpen && "rotate-180")} />
          </Button>
        )}

        {replyOpen && canReply && (
          <div className="pl-0 mt-3">
            {isGenerating && !hasDraftReady ? (
              <div className="mt-2 py-4 space-y-3 animate-pulse">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Writing reply…
                </div>
                <div className="space-y-2 pl-6">
                  <div className="h-3 w-full bg-secondary rounded" />
                  <div className="h-3 w-5/6 bg-secondary rounded" />
                  <div className="h-3 w-2/3 bg-secondary rounded" />
                </div>
              </div>
            ) : hasDraftReady ? (
              <ReplyDraftBox
                key={latestDraft!.id}
                draft={latestDraft!}
                token={token}
                // Prefill whenever the draft already has saved/AI content — same
                // persistence behavior as Campaign Outbox.
                startBlank={!replyDraftHasContent(latestDraft)}
                onChanged={onChanged}
                onNewAiDraft={() => void handleGenerateClick()}
                newAiDraftPending={isGenerating}
                recipients={recipients}
              />
            ) : (
              <ManualReplyBox
                threadId={threadId}
                token={token}
                replyToSubject={effectiveSubject}
                recipients={recipients}
                onSent={() => {
                  onChanged();
                  setReplyOpen(false);
                }}
                onCancel={() => setReplyOpen(false)}
                onNewAiDraft={() => void handleGenerateClick()}
                newAiDraftPending={isGenerating}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
