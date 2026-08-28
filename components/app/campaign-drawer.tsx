"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Megaphone, Users, Send, MessageSquare, Clock, Gauge, ArrowUp,
  Globe, Calendar, ExternalLink, Loader2, CheckCircle2, RotateCcw, RefreshCw, Check, Save, History, ChevronDown, ArrowLeft,
  List, LayoutGrid, BarChart2, Flame, Snowflake, ThumbsDown, Layers, Paperclip, X, Sparkles, Pencil, Reply, AlertTriangle,
  Building2, MapPin, ReplyAll, CornerDownRight, UserPlus, ArrowRight,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatChatDate, startsNewChatDay } from "@/lib/chat-format";
import { emailPreview, splitQuotedBody } from "@/lib/email-display";
import { convertResidualMarkdownInHtml } from "@/lib/utils/email-html";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatTile } from "@/components/ui/stat-tile";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SearchInput } from "@/components/ui/search-input";
import { Pill } from "@/components/ui/pill";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import {
  fetchCampaignLeads,
  fetchDraftProgress,
  approveDraft,
  bulkApproveDrafts,
  editDraft,
  regenerateDraft,
  sendApprovedLeads,
  fetchDraftHistory,
  fetchCampaignSteps,
  restoreDraftVersion,
  reopenDraft,
  fetchCampaignReport,
  retryFailedDrafts,
  fetchCampaignReplies,
  syncCampaignReplies,
  editReplyDraft,
  approveReplyDraft,
  rejectReplyDraft,
  sendReplyDraft,
  generateReplyDraftForThread,
  regenerateFollowUpStepTemplate,
  saveCampaignSteps,
  uploadCampaignLeadAttachment,
  removeCampaignLeadAttachment,
  patchCampaignConfig,
  fetchCampaignComments,
  postCampaignComment,
  toggleCampaignCommentReaction,
  previewRegeneration,
  regenerateCampaignDrafts,
  fetchRegenerationJob,
  cancelRegenerationJob,
  replaceBouncedLead,
  type CampaignReplyThread,
  type CampaignComment,
  type ReplyDraft,
  type RegenerationJobStatus,
  type RegenerationSkipped,
  addThreadParticipantAsLead,
} from "@/lib/api-client";
import { RegenerateDraftsModal } from "@/components/app/regenerate-drafts-modal";
import { ReplaceLeadModal, type ReplaceLeadTarget } from "@/components/app/replace-lead-modal";
import { DiscussionComment } from "@/components/app/discussion-comment";
import { CampaignKanban } from "@/components/app/campaign-kanban";
import { CampaignReportView, type CampaignReportData } from "@/components/app/campaign-report";
import { ReplyDraftBox, replyDraftHasContent } from "@/components/app/reply-draft-box";
import { ManualReplyBox, type ReplyRecipientContext } from "@/components/app/manual-reply-box";
import { AddParticipantLeadDialog } from "@/components/app/add-participant-lead-dialog";
import {
  isInbound,
  ourAddresses,
  parseAddressList,
  replyRecipients,
  replyTargetFor,
  threadParticipants,
  unansweredInbound,
} from "@/lib/thread-participants";
import { LeadDrawer } from "@/components/app/lead-drawer";
import { OrgDrawer } from "@/components/app/org-drawer";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/lib/app-context";
import type { Campaign } from "@/components/app/create-campaign-modal";
import { CampaignConfigModal } from "@/components/app/campaign-config-modal";
import { EditCampaignForm, SharedSettingsNotice } from "@/components/app/edit-campaign-modal";
import { InfoTip } from "@/components/ui/info-tip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Lead } from "@/lib/leads";
import type { CampaignStepInput } from "@/lib/constants";
import {
  DRAFT_BADGE_SHORT,
  CAMPAIGN_STATUS_HELP,
  CAMPAIGN_ACTION_HELP,
  type CampaignLeadsSort,
} from "@/lib/leads";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/ui/empty-state";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";
import {
  computeCampaignStats, deliveryBucket, deliveryLabel, DELIVERY_BUCKET_LABELS,
  sequenceStepLabel,
  type DeliveryBucket,
  type DeliveryLeadLike,
} from "@/lib/campaign-status";
import { cumulativeDays, dayLabel } from "@/lib/followup-schedule-preview";
import { extractFollowupWaitsFromSteps, rebuildStepsWithFollowupWaits } from "@/lib/constants";

/**
 * Strips quoted-reply lines from a stored email plain-text body for display.
 * Handles both "> quoted" lines and "On [date]... wrote:" attribution lines.
 * Applied on the display side so it works for both old stored data (before the
 * webhook-side strip was added) and future data.
 */
function stripQuotedLines(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith(">")) break;
    if (trimmed === "--" || trimmed === "—") break;
    // "On ... wrote:" spanning 1-3 lines (Gmail wraps address across lines)
    if (/^On .+wrote:\s*$/.test(trimmed)) break;
    if (/^On .+/.test(trimmed)) {
      const next1 = lines[i + 1]?.trimStart() ?? "";
      const next2 = lines[i + 2]?.trimStart() ?? "";
      if (/wrote:\s*$/.test(next1) || /wrote:\s*$/.test(next2)) break;
    }
    kept.push(lines[i]);
  }
  return kept.join("\n").trim() || null;
}

const DRAFT_STATUS_LABEL: Record<string, string> = {
  generating: "Generating",
  draft:      "Draft",
  approved:   "Certified",
  sent:       "Sent",
  failed:     "Failed",
  rejected:   "Rejected",
};

/**
 * Delivery pill colours. Amber for "sending" is deliberate — it reads as
 * in-flight, so nobody mistakes a lead still waiting in Instantly's drip for
 * one that has actually been mailed (green).
 */
const DELIVERY_PILL_CLS: Record<DeliveryBucket, string> = {
  not_queued:  "bg-muted text-muted-foreground border border-border",
  sending:     "bg-amber-500/15 text-amber-600 border border-amber-500/30",
  sent:        "bg-green-500/15 text-green-600 border border-green-500/30",
  replied:     "bg-primary/15 text-primary border border-primary/30",
  bounced:     "bg-red-500/15 text-red-500 border border-red-500/30",
  send_failed: "bg-red-500/15 text-red-500 border border-red-500/30",
};

/** In-flight wording, kept apart from status labels — this is an activity, not a stored status. */
const DRAFT_ACTIVITY_LABEL: Record<"generating" | "regenerating", string> = {
  generating:   "Generating",
  regenerating: "Regenerating",
};

const DRAFT_STATUS_STYLE: Record<string, string> = {
  generating: "bg-amber-500/10 text-amber-400",
  draft:      "bg-blue-500/10 text-blue-400",
  approved:   "bg-green-500/10 text-green-400",
  sent:       "bg-teal-500/10 text-teal-400",
  failed:     "bg-red-500/10 text-red-400",
  rejected:   "bg-zinc-500/10 text-zinc-400",
};

type AttachmentInfo = {
  perLead: { name: string; size: number; mime: string } | null;
  campaignDefault: { name: string; size: number; mime: string } | null;
  effective: { name: string; size: number; url: string | null; source: "lead" | "campaign" } | null;
};

type CampaignLead = {
  id: string;
  lead_id: string;
  crm_status: string;
  lead_temperature: string | null;
  created_at: string;
  leads: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    title: string | null;
    country: string | null;
    company_name: string | null;
    org_id?: string | null;
    company_domain?: string | null;
    company_country?: string | null;
    company_city?: string | null;
    company_website?: string | null;
    /** Set when this contact was added to stand in for a bounced one. */
    replaces_lead_id?: string | null;
  } | null;
  email_drafts: {
    id: string; subject: string | null; body: string | null; status: string;
    step_number?: number | null; created_at?: string;
    /** 'ai' = the model wrote it. 'template' = the safety net went in because
     *  generation failed; fallback_reason says why, in the client's words. */
    source?: string | null;
    fallback_reason?: string | null;
  } | null;
  /**
   * Set by the leads API when a step-1 draft row is mid-generation. It cannot be
   * read off `email_drafts`: draft_id only points at the new row once generation
   * succeeds, so until then a first draft looks like no draft at all and a
   * regeneration looks like the old row demoted to 'rejected'.
   */
  draft_activity?: DraftActivity;
  /** Set by Instantly's email_sent webhook — the mail actually went out. NULL
   *  while crm_status='sent' means queued in the drip, not yet delivered. */
  first_sent_at?: string | null;
  /** Highest sequence step delivered so far (step 1 = opening mail, so step N
   *  is follow-up N-1). first_sent_at alone cannot show this — it is stamped
   *  once and never moves as the follow-ups go out. */
  last_step_sent?: number | null;
  /** When the highest confirmed step (any step, including 1) actually went out
   *  — real webhook timestamp from reply_events, falling back to first_sent_at.
   *  Feeds the estimated-due-date math (effectiveLastStep/estimateNextDue) —
   *  never a guess, this is Instantly confirming delivery. */
  last_step_sent_at?: string | null;
  /** Which sequence step the address rejected (1 = the opening email), so a
   *  mailbox that died between sends reads differently from one dead all along. */
  bounced_step?: number | null;
  /** Every mail the sequence itself sent this lead — the opening email and each
   *  follow-up — mirrored back by Instantly. Empty until the Unibox sync has
   *  picked them up, which is why the step-1 draft is still used as a fallback. */
  sequence_messages?: Array<{
    id: string;
    step: string | null;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    timestamp_email: string | null;
    to_emails: string | null;
    cc_emails: string | null;
    from_email: string | null;
    /** Instantly's own email id and sending mailbox — needed to let a reply
     *  start from this send itself when the lead has never written back
     *  (see resolveOutboxReplyTarget). Absent on pre-migration rows. */
    instantly_email_id?: string | null;
    eaccount?: string | null;
    /** The Unibox thread this send belongs to — the fallback source for
     *  replying when getCampaignReplyThreads has no entry for this lead at
     *  all (a never-replied lead is the common case, so that endpoint
     *  deliberately skips them; see its own comment for why). */
    thread_id?: string | null;
  }>;
  /** Set once someone answered this bounce by adding another contact at the same
   *  company. The row stays bounced (and still counts as one) — this only marks
   *  it as dealt with, so nobody redoes the work. */
  replaced_by_lead_id?: string | null;
  /** Who answered the bounce, and when. Null on bounces replaced before the
   *  attribution columns existed — the panel then omits the line. */
  replaced_at?: string | null;
  replaced_by_user_name?: string | null;
  /** From the email_bounced webhook — the day the address rejected us. */
  bounced_at?: string | null;
  /** Every draft for this lead, all steps. `email_drafts` is flattened to the
   *  opening email by loadData; the Sequences tab needs the follow-ups too. */
  all_drafts?: EmailDraftRow[];
  /** One live draft per follow-up step, straight from the API. Separate from
   *  `all_drafts` because the embed behind that one can only ever return the
   *  opening email — campaign_leads.draft_id is a one-to-one key. */
  followup_drafts?: EmailDraftRow[];
  attachment?: AttachmentInfo;
};

/** One entry in a draft's version history. Shared by the opening email's panel
 *  and the per-lead follow-up panel — both read the same /drafts/history route,
 *  which is step-agnostic. */
type DraftVersion = {
  id: string;
  subject: string | null;
  body: string | null;
  status: string;
  version: number;
  created_at: string;
};

type DraftActivity = "generating" | "regenerating" | null;

type DraftProgress = {
  total: number; generating: number; draft: number; approved: number;
  sent: number; failed: number; pending: number;
};

const DAY_SHORT: Record<string, string> = {
  monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu",
  friday: "Fri", saturday: "Sat", sunday: "Sun",
};

function sortCampaignLeads(leads: CampaignLead[], sort: CampaignLeadsSort): CampaignLead[] {
  const copy = [...leads];
  if (sort === "newest") {
    return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return copy.sort((a, b) => {
    const aName = [a.leads?.first_name, a.leads?.last_name].filter(Boolean).join(" ");
    const bName = [b.leads?.first_name, b.leads?.last_name].filter(Boolean).join(" ");
    return aName.localeCompare(bName);
  });
}

/** Stub for LeadDrawer — it refetches full lead details by id. */
function campaignLeadToDrawerLead(cl: CampaignLead): Lead {
  const l = cl.leads;
  return {
    id: cl.lead_id,
    firstName: l?.first_name ?? "",
    lastName: l?.last_name ?? "",
    email: l?.email ?? "",
    company: l?.company_name ?? "",
    domain: l?.company_domain ?? "",
    domainSource: null,
    phone: "",
    jobTitle: l?.title ?? "",
    country: l?.country ?? "",
    status: "Enriched",
    score: "—",
    source: "Apollo",
    campaign: "",
    campaigns: [],
    createdAt: cl.created_at,
    orgId: l?.org_id ?? null,
    enrichmentStage: null,
    companyDescription: null,
    sellsTo: null,
    lastError: null,
    hasScraped: false,
    importId: null,
    batchLabel: null,
    batchColor: null,
    assignedTo: null,
    orgShared: null,
  };
}

type EmailDraftRow = NonNullable<CampaignLead["email_drafts"]>;

/** Instantly step templates use {{customSubject}} / {{customBodyN}} — not display text. */
function isInstantlyPlaceholder(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  return /^\{\{custom(?:Subject|Body)\d*\}\}$/.test(value.trim());
}

function getLeadDrafts(cl: CampaignLead): EmailDraftRow[] {
  const raw = cl.email_drafts as unknown;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as EmailDraftRow[];
  return [raw as EmailDraftRow];
}

function getLeadDraftForStep(cl: CampaignLead, stepNumber: number): EmailDraftRow | null {
  return getLeadDrafts(cl).find((d) => (d.step_number ?? 1) === stepNumber) ?? null;
}


/** Campaign steps shown in the Sequences tab (initial email is edited under Drafts). */
function sequenceFollowUpSteps(
  steps: Array<{ step_order: number; subject: string; body: string; delay: number; delay_unit: string }>,
) {
  return steps.filter((s) => s.step_order > 1);
}

// The leads API only ever writes last_step_sent from FOLLOW-UP webhook events
// — step 1 (the opening email) is deliberately never written there because
// campaign_leads.first_sent_at already covers it (see
// app/api/v1/campaigns/[id]/leads/route.ts). So a lead who has only received
// the opening email has last_step_sent=null, which must NOT be read as "step
// 1 wasn't sent" — it means "highest CONFIRMED step is 1", same as any other
// lead whose opening delivered but no follow-up has gone out yet. This is the
// one place that null is resolved correctly; every follow-up read in this
// file should go through here rather than reading last_step_sent directly.
function effectiveLastStep(cl: DeliveryLeadLike): number {
  if (cl.last_step_sent) return cl.last_step_sent;
  const b = deliveryBucket(cl);
  return b === "sent" || b === "replied" || b === "bounced" ? 1 : 0;
}

/** True while a lead is still active in the sequence (sent/sending, not
 *  replied/bounced/stopped) AND has not yet received every configured
 *  follow-up step. Drives the "Follow-up" filter option on the Leads and
 *  Outbox dropdowns — a lightweight yes/no read, not the full schedule/date
 *  math a dedicated progress view would need. */
function hasUpcomingFollowup(
  cl: DeliveryLeadLike,
  steps: Array<{ step_order: number; subject: string; body: string; delay: number; delay_unit: string }>,
): boolean {
  const delivery = deliveryBucket(cl);
  if (delivery !== "sent" && delivery !== "sending") return false;
  const followUpCount = sequenceFollowUpSteps(steps).filter((s) => s.subject.trim() || s.body.trim()).length;
  if (followUpCount === 0) return false;
  return effectiveLastStep(cl) < 1 + followUpCount;
}

/**
 * PER-STEP variants of the two predicates above.
 *
 * The aggregate versions answer "any follow-up at all", which lumps step 2 and
 * step 3 into one number: a lead who received only follow-up 1 and a lead who
 * received both counted identically, and "Follow-up due" never said WHICH one
 * was coming. On the client's live campaign that read as "Follow-up sent 86 /
 * Follow-up due 84" with no way to tell the steps apart.
 *
 * `last_step_sent` already records the step number, so this is purely a
 * counting change — nothing extra is stored.
 */

/** That exact follow-up step has already gone out to this lead. */
function hasReceivedFollowupStep(cl: DeliveryLeadLike, stepOrder: number): boolean {
  return effectiveLastStep(cl) >= stepOrder;
}

/** That exact follow-up step is the NEXT one owed to this lead. Only the next
 *  step counts as due: a lead on step 2 is not "due" for step 3 as well, or one
 *  lead would appear in two buckets at once and the totals would overcount. */
function hasUpcomingFollowupStep(
  cl: DeliveryLeadLike,
  stepOrder: number,
  steps: Array<{ step_order: number; subject: string; body: string; delay: number; delay_unit: string }>,
): boolean {
  if (!hasUpcomingFollowup(cl, steps)) return false;
  return effectiveLastStep(cl) === stepOrder - 1;
}

/** One place that turns a filter value into a yes/no, so the dropdown counts and
 *  the list can never disagree — they call the same function. */
function matchesDeliveryFilter(
  cl: DeliveryLeadLike,
  value: string,
  steps: Array<{ step_order: number; subject: string; body: string; delay: number; delay_unit: string }>,
): boolean {
  if (value === "all") return true;
  if (value === "followup") return hasUpcomingFollowup(cl, steps);
  if (value === "followup_sent") return hasReceivedFollowup(cl);
  const dueMatch = /^followup_(\d+)$/.exec(value);
  if (dueMatch) return hasUpcomingFollowupStep(cl, Number(dueMatch[1]), steps);
  const sentMatch = /^followup_sent_(\d+)$/.exec(value);
  if (sentMatch) return hasReceivedFollowupStep(cl, Number(sentMatch[1]));
  return deliveryBucket(cl) === value;
}

/** True once at least one follow-up (step 2+) has actually gone out —
 *  independent of current status, so a lead who later replied or bounced
 *  still counts here (they did receive it). Complements hasUpcomingFollowup
 *  above: "due" looks forward, "sent" looks back. */
function hasReceivedFollowup(cl: DeliveryLeadLike): boolean {
  return effectiveLastStep(cl) >= 2;
}

function sequenceDisplayStep(stepOrder: number): number {
  return stepOrder - 1;
}

function getSidebarBadge(cl: CampaignLead, isGenerating: boolean): string {
  const ds = cl.email_drafts?.status;
  if (ds && DRAFT_BADGE_SHORT[ds]) return DRAFT_BADGE_SHORT[ds];
  if (cl.crm_status === "new" || cl.crm_status === "enriched") {
    return isGenerating ? "Pending" : "Pending";
  }
  return "—";
}

type CampaignViewTab = "analytics" | "leads" | "outbox" | "sequences" | "options" | "discussion";

function DraftStatusBadge({
  label,
  styleClass,
  helpText,
}: {
  label: string;
  styleClass: string;
  helpText?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md shrink-0",
        "inline-flex items-center justify-center gap-1",
        styleClass,
      )}
    >
      {label}
      {helpText && <InfoTip text={helpText} />}
    </span>
  );
}

/** Gmail/Unibox-style expandable message row — collapsed shows sender + snippet + date, expanded shows the full body. */
function OutboxQuotedBlock({ quoted, isHtml }: { quoted: string; isHtml: boolean }) {
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

function OutboxMessageRow({
  senderName,
  toLabel,
  ccLabel,
  fromThirdParty,
  isUnanswered,
  isReplyTarget,
  inReplyToLabel,
  replyTargetName,
  stepLabel,
  onReplyTo,
  onReplyAll,
  onAddAsLead,
  addingLead,
  timestamp,
  bodyHtml,
  bodyText,
  expanded,
  onToggle,
}: {
  senderName: string;
  toLabel: string;
  ccLabel: string;
  /** Inbound from someone other than the lead — needs saying out loud. */
  fromThirdParty: boolean;
  /** Nobody has replied to this person since they wrote. */
  isUnanswered: boolean;
  isReplyTarget: boolean;
  /** For our own replies: who wrote the message this one answered. */
  inReplyToLabel: string | null;
  /** Who a reply from here will actually address — differs from senderName
   *  whenever this row is one of our own outbound messages. */
  replyTargetName: string | null;
  /** "Opening email" / "Follow-up 1" — which sequence send this is. */
  stepLabel: string | null;
  /** Set whenever a valid inbound message exists to thread a reply off —
   *  any row can be one now, not just inbound messages (see replyTargetFor). */
  onReplyTo: (() => void) | null;
  onReplyAll: (() => void) | null;
  /** Set only for a third participant who is not already a lead. */
  onAddAsLead: (() => void) | null;
  addingLead: boolean;
  timestamp: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const snippet = emailPreview(bodyText, bodyHtml, 100);
  const { main, quoted } = splitQuotedBody(bodyHtml, bodyText);
  const isHtml = !!bodyHtml;

  if (!expanded) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left font-normal border-b border-border/60 last:border-b-0 hover:bg-secondary/40 cursor-pointer transition-colors"
      >
        <Avatar name={senderName} size="sm" />
        <span className="shrink-0 max-w-[160px] truncate text-sm font-medium text-foreground/90">
          {senderName}
        </span>
        {fromThirdParty && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 text-muted-foreground">
            via cc
          </Badge>
        )}
        {/* Which sequence send this is. On the collapsed row because that is the
            glanceable one — the whole point is reading the thread at a glance. */}
        {stepLabel && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 border-primary/40 text-primary">
            {stepLabel}
          </Badge>
        )}
        {/* Same reason as the Unibox: the collapsed row is the glanceable one. */}
        {isUnanswered && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 border-amber-500/40 text-amber-500">
            Not answered
          </Badge>
        )}
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {snippet || "(empty message)"}
        </span>
        {/* Reply without expanding first — same eligibility/target logic as
            the full button below, just reachable from the collapsed row. */}
        {onReplyTo && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onReplyTo(); }}
            title={`Reply to ${replyTargetName ?? senderName}`}
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
          >
            <Reply className="size-3.5" />
          </button>
        )}
        {timestamp && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {format(new Date(timestamp), "MMM d")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        className="h-auto w-full justify-start items-start gap-3 px-4 py-3 text-left font-normal rounded-none hover:bg-secondary/30"
      >
        <Avatar name={senderName} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{senderName}</span>
            {fromThirdParty && (
              <Badge variant="outline" className="rounded font-mono text-[9px] px-1.5 py-0.5 text-muted-foreground">
                not the lead
              </Badge>
            )}
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
          </div>
          {inReplyToLabel && (
            <p className="flex items-center gap-1 font-mono text-[11px] text-primary/80 truncate">
              <CornerDownRight className="size-3 shrink-0" />
              in reply to {inReplyToLabel}
            </p>
          )}
          <p className="font-mono text-xs text-muted-foreground truncate">
            to {toLabel || "—"}
            {ccLabel && ` · cc ${ccLabel}`}
          </p>
        </div>
        {timestamp && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {format(new Date(timestamp), "MMM d, h:mm a")}
          </span>
        )}
      </Button>
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
        {quoted && <OutboxQuotedBlock quoted={quoted} isHtml={isHtml} />}
        {/* Picking the message decides the recipient: Instantly addresses a
            reply to the sender of whatever it answers, so without this the
            composer can only ever reach whoever happened to write last. */}
        {onReplyTo && (
          <div className="mt-2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onReplyTo}
              className="h-7 gap-1.5 px-2 text-[11px] text-primary hover:text-primary"
            >
              <Reply className="size-3" />
              Reply to {replyTargetName ?? senderName}
            </Button>
            {onReplyAll && (
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
            )}
            {/* Same action as the Unibox — a stakeholder who joins the thread
                should be promotable from wherever the rep is standing. */}
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

export function CampaignDetail({
  campaign,
  onBack,
}: {
  campaign: Campaign;
  onBack: () => void;
}) {
  const [campaignName, setCampaignName] = useState(campaign.name);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(campaign.name);
  const [savingName, setSavingName] = useState(false);
  const [campaignLeads, setCampaignLeads] = useState<CampaignLead[]>([]);
  const [progress, setProgress] = useState<DraftProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenQuery, setRegenQuery] = useState("");
  const regenPanelRef = useRef<HTMLDivElement>(null);
  const regenTextareaRef = useRef<HTMLTextAreaElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  // Bulk regeneration: the confirm modal's server-resolved preview, the live job, and submit state.
  const [bulkRegenPreview, setBulkRegenPreview] = useState<{
    counts: { draft: number; failed: number };
    skipped: RegenerationSkipped;
    isSubset: boolean;
    campaignLeadIds?: string[];
    /** 1 for the opening email, 2+ for a follow-up step. Carried through to the
     *  enqueue so the confirm modal cannot start a run against a different step
     *  from the one that was previewed. */
    stepNumber?: number;
  } | null>(null);
  const [bulkRegenSubmitting, setBulkRegenSubmitting] = useState(false);
  const [bulkRegenOpening, setBulkRegenOpening] = useState(false);
  const [regenJob, setRegenJob] = useState<RegenerationJobStatus | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [saving, setSaving] = useState(false);
  const [certifying, setCertifying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // campaign_lead ids whose regeneration this tab kicked off. The server only
  // starts reporting `draft_activity` on the next poll, so without this the row
  // shows its old (now superseded) status for up to a full refresh cycle.
  const [locallyRegenerating, setLocallyRegenerating] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [leadsSort, setLeadsSort] = useState<CampaignLeadsSort>("az");
  // "followup_2" = step 2 is the next one owed; "followup_sent_2" = step 2 has
  // already gone. The old flat "followup"/"followup_sent" values are kept so an
  // existing selection does not break, but the dropdown now offers per-step ones.
  const [leadsDelivery, setLeadsDelivery] = useState<string>("all");
  const [leadsViewMode, setLeadsViewMode] = useState<"list" | "kanban">("list");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [campaignSteps, setCampaignSteps] = useState<CampaignStepInput[]>([]);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [viewTab, setViewTab] = useState<CampaignViewTab>("analytics");
  const [report, setReport] = useState<CampaignReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [drawerOrgId, setDrawerOrgId] = useState<string | null>(null);
  /** "View the email that bounced" — the dead thread is folded away, not
   *  deleted, so a disputed bounce can still be checked. Resets per selection. */
  const [bouncedThreadOpen, setBouncedThreadOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<ReplaceLeadTarget | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const [threads, setThreads] = useState<CampaignReplyThread[]>([]);
  const [outboxFilter, setOutboxFilter] = useState<
    "all" | "action" | "certified" | "sending" | "sent" | "replied" | "bounced" | "followup" | "followup_sent"
  >("all");
  const [outboxExpandOverrides, setOutboxExpandOverrides] = useState<Set<string>>(new Set());
  const [outboxReplyOpen, setOutboxReplyOpen] = useState(false);
  const [outboxReplyStartBlank, setOutboxReplyStartBlank] = useState(true);
  /** Which message the Outbox composer answers. null = newest inbound. */
  const [outboxReplyTargetId, setOutboxReplyTargetId] = useState<string | null>(null);
  /** Reply all seeds every participant into To; plain Reply seeds just one. */
  const [outboxReplyAll, setOutboxReplyAll] = useState(true);
  /** Participant the Add-as-lead dialog is open for, and its in-flight state. */
  const [outboxAddLeadFor, setOutboxAddLeadFor] = useState<string | null>(null);
  const [outboxSavingLead, setOutboxSavingLead] = useState(false);
  const [outboxNewReplyLoading, setOutboxNewReplyLoading] = useState(false);
  const [syncingReplies, setSyncingReplies] = useState(false);
  const syncHitTimesRef = useRef<number[]>([]);
  const SYNC_RATE_LIMIT = 10;
  const SYNC_RATE_WINDOW_MS = 60_000;
  const [leadsSearch, setLeadsSearch] = useState("");
  const [selectedSequenceStep, setSelectedSequenceStep] = useState<number>(2);
  // seq edit state — initialized when selectedSequenceStep changes
  /** Sequences tab, middle column: which lead's own follow-up is open. */
  const [seqLeadId, setSeqLeadId] = useState<string | null>(null);
  /** Right panel shows either that lead's own email, or the shared template.
   *  Both are needed: the template still carries the delay and the writing
   *  instructions, and losing it would make a step uneditable. */
  const [seqPane, setSeqPane] = useState<"lead" | "template">("lead");
  // Opens on ALL, not on a filtered subset. Defaulting to "due" showed 86 of
  // 100 leads and made the other 14 — the replied and the bounced — look like
  // they had vanished from the campaign. They stay in the list, labelled.
  const [seqLeadFilter, setSeqLeadFilter] = useState<"due" | "sent" | "unwritten" | "all">("all");
  const [seqLeadSearch, setSeqLeadSearch] = useState("");
  const [seqLeadRegenerating, setSeqLeadRegenerating] = useState<string | null>(null);
  /** Editable follow-up waits, for the Steps pane. Held separately from
   *  campaignSteps so typing does not repeatedly re-save. */
  const [seqStepEdits, setSeqStepEdits] = useState<{ delay: number; delay_unit: "minutes" | "hours" | "days"; ai_instruction?: string | null }[]>([]);
  /** Campaign-wide follow-up guidance, and the per-step boxes above. */
  const [seqCampaignInstruction, setSeqCampaignInstruction] = useState("");
  /** Which follow-up is being hand-edited, and its working copy. */
  const [seqEditingDraftId, setSeqEditingDraftId] = useState<string | null>(null);
  const [seqEditBody, setSeqEditBody] = useState("");
  const [seqEditSaving, setSeqEditSaving] = useState(false);
  /** Which follow-up has its regenerate box open, and what was typed into it.
   *  The opening email has always asked before regenerating; this one fired
   *  immediately, which spends a credit and replaces the email with no chance
   *  to say what was wrong with it. */
  const [seqRegenOpenFor, setSeqRegenOpenFor] = useState<string | null>(null);
  const [seqRegenQuery, setSeqRegenQuery] = useState("");
  /** Per-lead follow-up version history.
   *
   *  Loaded ON DEMAND rather than in an effect keyed on the open lead, unlike
   *  the opening email's history. The middle column invites clicking through
   *  dozens of leads, and a fetch per click to answer a question nobody asked is
   *  a lot of requests for a panel most people never open. The cost is that the
   *  button cannot know in advance whether there is anything to show, so it says
   *  so after opening instead of hiding itself. */
  const [seqVersions, setSeqVersions] = useState<DraftVersion[]>([]);
  /** Which draft's history panel is open. Keyed by draft id because the pane
   *  now shows every step at once, so "open" is no longer a single boolean. */
  const [seqHistoryOpen, setSeqHistoryOpen] = useState<string | null>(null);
  const [seqHistoryLoading, setSeqHistoryLoading] = useState(false);
  /** The historical version being read, or null for the current one. */
  const [seqPreviewVersion, setSeqPreviewVersion] = useState<DraftVersion | null>(null);
  const [seqRestoring, setSeqRestoring] = useState(false);
  /** True when the STORED body is the {{customBodyN}} placeholder and the editor is
   *  only showing sample text in its place. */
  const [seqStepSaving, setSeqStepSaving] = useState(false);
  const [comments, setComments] = useState<CampaignComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [loadingComments, setLoadingComments] = useState(false);
  const [sendingComment, setSendingComment] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement | null>(null);
  const activeCampaignIdRef = useRef(campaign.id);

  const [systemPromptUpdatedAt, setSystemPromptUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch("/api/v1/settings/prompt-meta", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json();
      setSystemPromptUpdatedAt(json.data?.updatedAt ?? null);
    })();
  }, []);

  const { loadCampaigns, session: appSession, role } = useApp();
  // Options/Sequences are shared campaign-wide settings (spec §5 — a campaign
  // is a container that can hold leads owned by several employees at once).
  // Managers may always edit them. An employee may only when they are the sole
  // employee in this campaign; otherwise editing would silently change what a
  // teammate's leads send under. The server decides (can_edit_settings) and
  // re-checks on write — this only mirrors its verdict into the controls.
  const canEditSettings = role === "manager" || campaign.canEditSettings === true;

  const loadComments = useCallback(async (campaignId: string, quiet = false) => {
    if (!appSession?.access_token) return;
    if (!quiet) setLoadingComments(true);
    try {
      const next = await fetchCampaignComments(appSession.access_token, campaignId);
      if (activeCampaignIdRef.current !== campaignId) return;
      setComments((current) => {
        if (!quiet) return next;
        const byId = new Map(current.map((comment) => [comment.id, comment]));
        for (const comment of next) byId.set(comment.id, comment);
        return [...byId.values()].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
      });
    } catch (loadError) {
      if (!quiet) toast.error((loadError as Error).message || "Could not load the discussion");
    } finally {
      if (!quiet && activeCampaignIdRef.current === campaignId) setLoadingComments(false);
    }
  }, [appSession?.access_token]);

  async function handleSendComment() {
    if (!appSession?.access_token || sendingComment || !commentBody.trim()) return;
    const body = commentBody.trim();
    setSendingComment(true);
    try {
      const comment = await postCampaignComment(appSession.access_token, campaign.id, body);
      setComments((current) => [...current, comment]);
      setCommentBody("");
    } catch (sendError) {
      toast.error((sendError as Error).message || "Could not send the message");
    } finally {
      setSendingComment(false);
    }
  }

  async function handleToggleCommentReaction(commentId: string, emoji: string) {
    if (!appSession?.access_token) return;
    try {
      const reactions = await toggleCampaignCommentReaction(
        appSession.access_token,
        campaign.id,
        commentId,
        emoji,
      );
      setComments((current) =>
        current.map((comment) =>
          comment.id === commentId ? { ...comment, reactions } : comment,
        ),
      );
    } catch (error) {
      toast.error((error as Error).message || "Could not update reaction");
      throw error;
    }
  }

  useEffect(() => {
    activeCampaignIdRef.current = campaign.id;
    setComments([]);
    setCommentBody("");
    void loadComments(campaign.id, true);
  }, [campaign.id, loadComments]);

  useEffect(() => {
    if (viewTab !== "discussion") return;
    void loadComments(campaign.id);
    const interval = window.setInterval(() => void loadComments(campaign.id, true), 10000);
    return () => window.clearInterval(interval);
  }, [campaign.id, viewTab, loadComments]);

  useEffect(() => {
    if (viewTab !== "discussion") return;
    commentsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [comments, viewTab]);

  useEffect(() => {
    setCampaignName(campaign.name);
    setNameDraft(campaign.name);
    setEditingName(false);
  }, [campaign.id, campaign.name]);

  async function handleSaveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === campaignName) {
      setEditingName(false);
      setNameDraft(campaignName);
      return;
    }
    setSavingName(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const result = await patchCampaignConfig(session.access_token, campaign.id, { name: trimmed });
      if (result.sync_errors.length > 0) {
        toast.warning("Renamed, but Instantly sync had errors: " + result.sync_errors[0]);
      } else {
        toast.success("Campaign renamed");
      }
      setCampaignName(trimmed);
      setEditingName(false);
      if (appSession?.access_token) void loadCampaigns(appSession.access_token);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingName(false);
    }
  }

  const loadData = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const token = session.access_token;
    const [leadsRes, prog] = await Promise.all([
      fetchCampaignLeads(token, campaign.id),
      fetchDraftProgress(token, campaign.id),
    ]);
    const rawLeads = leadsRes.campaign_leads as CampaignLead[];

    const leads = rawLeads.map((cl) => {
      // email_drafts is flattened to the STEP 1 draft here, because most of this
      // screen means "the opening email" when it says draft. That flattening also
      // threw the follow-up drafts away, so anything asking for step 2 found
      // nothing. Keep the full set alongside it for the Sequences tab.
      const allDrafts = [...getLeadDrafts(cl), ...(cl.followup_drafts ?? [])];
      const step1Draft = getLeadDraftForStep(cl, 1);
      return { ...cl, all_drafts: allDrafts, email_drafts: step1Draft ?? null };
    });
    setCampaignLeads(leads);
    setProgress(prog);
    return leads;
  }, [campaign.id]);

  const loadRegenJob = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;
      const { job } = await fetchRegenerationJob(session.access_token, campaign.id);
      setRegenJob(job);
      return job;
    } catch {
      return null;
    }
  }, [campaign.id]);

  const loadReplies = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const { threads: t } = await fetchCampaignReplies(session.access_token, campaign.id);
    setThreads(t);
  }, [campaign.id]);

  const runSyncReplies = useCallback(async (opts?: { silent?: boolean }) => {
    const now = Date.now();
    syncHitTimesRef.current = syncHitTimesRef.current.filter(
      (t) => now - t < SYNC_RATE_WINDOW_MS,
    );
    if (syncHitTimesRef.current.length >= SYNC_RATE_LIMIT) {
      if (!opts?.silent) toast.warning("Please wait a few seconds before trying again.");
      return;
    }
    syncHitTimesRef.current.push(now);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setSyncingReplies(true);
    try {
      const result = await syncCampaignReplies(session.access_token, campaign.id);
      await Promise.all([loadReplies(), loadData()]);
      if (!opts?.silent) {
        if (result.backfilled > 0) {
          toast.success(`Synced ${result.backfilled} missed repl${result.backfilled === 1 ? "y" : "ies"} from Instantly`);
        } else {
          toast.success("Replies are up to date");
        }
      }
    } catch (e) {
      if (!opts?.silent) toast.error((e as Error).message);
    } finally {
      setSyncingReplies(false);
    }
  }, [campaign.id, loadData, loadReplies]);

  // Pull missed Instantly replies when opening Outbox — webhooks often miss in local/ngrok.
  useEffect(() => {
    if (viewTab !== "outbox") return;
    void runSyncReplies({ silent: true });
    // intentionally only when switching into Outbox
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewTab, campaign.id]);

  useEffect(() => {
    setOutboxReplyOpen(false);
    setOutboxReplyStartBlank(true);
    setOutboxReplyTargetId(null);
    setOutboxReplyAll(true);
  }, [selectedId]);

  // Clicking "Regenerate" only reveals a collapsed panel below the button —
  // easy to miss if it lands below the fold, which reads as "nothing happened."
  // Scroll it into view and focus the textarea so the click has an unmistakable result.
  useEffect(() => {
    if (!regenOpen) return;
    const id = requestAnimationFrame(() => {
      regenPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      regenTextareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [regenOpen]);

  // Same fix as Regenerate: "Version history" only reveals a panel below the
  // button, which can land off-screen and read as a dead click.
  useEffect(() => {
    if (!historyOpen) return;
    const id = requestAnimationFrame(() => {
      historyPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(id);
  }, [historyOpen]);

  /** The "AI draft" button — the only thing that starts an LLM reply now.
   *  Opening the composer no longer generates anything on its own. */
  async function handleGenerateOutboxReply(campaignLeadId: string) {
    setOutboxNewReplyLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await generateReplyDraftForThread(session.access_token, { campaign_lead_id: campaignLeadId });
      await loadReplies();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOutboxNewReplyLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void loadReplies();
    void loadRegenJob();
    loadData()
      .then((leads) => {
        if (leads && leads.length === 1) {
          setSelectedId(leads[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [loadData, loadRegenJob]);

  // Refresh reply threads when opening Outbox so Unibox Generate/Save shows up
  // without remounting the campaign drawer.
  useEffect(() => {
    if (viewTab !== "outbox") return;
    void loadReplies();
  }, [viewTab, loadReplies]);

  useEffect(() => {
    if (viewTab !== "analytics") return;
    let cancelled = false;
    setReportLoading(true);
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      try {
        const data = await fetchCampaignReport(session.access_token, campaign.id);
        if (!cancelled) setReport(data);
      } catch {
        if (!cancelled) setReport(null);
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [viewTab, campaign.id, campaignLeads.length, progress?.sent, progress?.failed]);

  // Loaded eagerly (not gated to the Sequences tab) because the Leads/Outbox
  // "Follow-up due/sent" filters and the Analytics step-performance panel both
  // need campaignSteps too — gating this to viewTab==="sequences" left those
  // filters silently empty until the user happened to open Sequences first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      try {
        const { steps, followup_instruction } = await fetchCampaignSteps(session.access_token, campaign.id);
        if (!cancelled) {
          setSeqCampaignInstruction(followup_instruction ?? "");
          const mapped = steps.map((s) => ({ step_order: s.step_order, subject: s.subject, body: s.body, delay: s.delay, delay_unit: s.delay_unit }));
          setCampaignSteps(mapped);
          const followUps = mapped.filter((s) => s.step_order > 1);
          if (followUps.length > 0) {
            setSelectedSequenceStep((prev) =>
              followUps.some((s) => s.step_order === prev) ? prev : followUps[0].step_order,
            );
          }
        }
      } catch {
        if (!cancelled) setCampaignSteps([]);
      }
    })();
    return () => { cancelled = true; };
  }, [campaign.id]);

  useEffect(() => {
    if (!progress) return;
    const isGenerating = (progress.generating + progress.pending) > 0;
    if (!isGenerating) return;
    const interval = setInterval(() => { void loadData(); }, 3000);
    return () => clearInterval(interval);
  }, [progress, loadData]);

  // A bulk regeneration runs entirely server-side, so the only way to see it
  // advance is to ask. Poll the job and the leads together while one is live;
  // on the tick where it stops being active, refresh once more so the final
  // drafts are on screen.
  useEffect(() => {
    if (!regenJob?.active) return;
    const interval = setInterval(() => {
      void (async () => {
        const job = await loadRegenJob();
        await loadData();
        if (job && !job.active) {
          const done = job.status === "completed";
          if (done && job.failed > 0) {
            toast.warning(`Regenerated ${job.succeeded} draft${job.succeeded !== 1 ? "s" : ""}; ${job.failed} failed`);
          } else if (done) {
            toast.success(`${job.succeeded} draft${job.succeeded !== 1 ? "s" : ""} regenerated`);
          }
        }
      })();
    }, 3000);
    return () => clearInterval(interval);
  }, [regenJob?.active, loadRegenJob, loadData]);

  const selected = campaignLeads.find((cl) => cl.id === selectedId) ?? null;

  useEffect(() => {
    if (selected?.email_drafts) {
      setEditSubject(selected.email_drafts.subject ?? "");
      setEditBody(selected.email_drafts.body ?? "");
    } else {
      setEditSubject("");
      setEditBody("");
    }
    setRegenOpen(false);
    setRegenQuery("");
    setHistoryOpen(false);
    setPreviewVersionId(null);
    setError("");
    setOutboxExpandOverrides(new Set());
    setBouncedThreadOpen(false);
  }, [selected?.id, selected?.email_drafts?.subject, selected?.email_drafts?.body]);

  useEffect(() => {
    if (!selected?.email_drafts?.id) { setVersions([]); return; }
    async function loadHistory() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { versions: v } = await fetchDraftHistory(session.access_token, selected!.email_drafts!.id);
        setVersions(v);
      } catch { setVersions([]); }
    }
    void loadHistory();
  }, [selected?.email_drafts?.id]);

  // Regenerating a few times in one sitting is normal, and a date-only label
  // then renders a row of identical "Aug 3" chips that look like they came from
  // somewhere else entirely. Show the clock time instead whenever every version
  // lands on the same calendar day; keep the date once history spans days.
  const versionsSpanOneDay =
    versions.length > 0 &&
    new Set(versions.map((v) => new Date(v.created_at).toDateString())).size === 1;

  useEffect(() => {
    async function loadCampaignSteps() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { steps } = await fetchCampaignSteps(session.access_token, campaign.id);
        setCampaignSteps(steps.map((s) => ({ step_order: s.step_order, subject: s.subject, body: s.body, delay: s.delay, delay_unit: s.delay_unit })));
      } catch { setCampaignSteps([]); }
    }
    void loadCampaignSteps();
  }, [campaign.id]);

  // Sort days in calendar order (Mon–Sun) before display.
  // Object.entries() returns JSON key insertion order which is arbitrary.
  const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
  const activeDays = DAY_ORDER
    .filter((k) => campaign.sendDays?.[k])
    .map((k) => DAY_SHORT[k] ?? k);

  const draftReadyLeads = campaignLeads.filter((cl) => cl.email_drafts?.status === "draft");
  const sendReadyLeads = campaignLeads.filter((cl) =>
    (cl.email_drafts?.status === "approved" || cl.crm_status === "approved") &&
    cl.email_drafts?.status !== "sent" &&
    cl.crm_status !== "sent"
  );
  const certifiedCount = sendReadyLeads.length;
  const isGenerating = progress ? (progress.generating + progress.pending) > 0 : false;
  const progressPct = progress && progress.total > 0
    ? Math.round(((progress.draft + progress.approved + progress.sent + progress.failed) / progress.total) * 100)
    : 0;
  const progressCompleted = progress
    ? progress.draft + progress.approved + progress.sent + progress.failed
    : 0;

  /**
   * What this lead is doing right now, if anything. The server reports it from
   * the live `generating` row; `locallyRegenerating` covers the gap between
   * clicking Regenerate and the next poll, so the badge never blinks back to
   * "No draft" in between.
   */
  function getDraftActivity(cl: CampaignLead): DraftActivity {
    if (locallyRegenerating.has(cl.id)) return "regenerating";
    return cl.draft_activity ?? null;
  }

  function getDisplayStatus(cl: CampaignLead): string {
    const activity = getDraftActivity(cl);
    if (activity) return DRAFT_ACTIVITY_LABEL[activity];
    // Prefer delivery outcome over draft status once mail has left (or bounced) —
    // otherwise a bounced lead still reads as "Sent" because email_drafts stays sent.
    const delivery = deliveryBucket(cl);
    if (delivery !== "not_queued") return deliveryLabel(cl);
    if (cl.email_drafts?.status) return DRAFT_STATUS_LABEL[cl.email_drafts.status] ?? cl.crm_status;
    if (cl.crm_status === "new" || cl.crm_status === "enriched") return isGenerating ? "Pending" : "No draft";
    return cl.crm_status;
  }

  function getStatusStyle(cl: CampaignLead): string {
    if (getDraftActivity(cl)) return DRAFT_STATUS_STYLE.generating;
    const delivery = deliveryBucket(cl);
    if (delivery !== "not_queued") return DELIVERY_PILL_CLS[delivery];
    const ds = cl.email_drafts?.status;
    if (ds && DRAFT_STATUS_STYLE[ds]) return DRAFT_STATUS_STYLE[ds];
    return "bg-secondary text-muted-foreground";
  }

  const [attaching, setAttaching] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);

  async function handleLeadAttachmentUpload(file: File) {
    if (!selected) return;
    setAttaching(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await uploadCampaignLeadAttachment(session.access_token, selected.id, file);
      toast.success(`${file.name} set for this lead — regenerate the draft to include the download link`);
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleLeadAttachmentRemove() {
    if (!selected) return;
    setAttaching(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await removeCampaignLeadAttachment(session.access_token, selected.id);
      toast.success("Per-lead attachment removed");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAttaching(false);
    }
  }

  async function handleSaveEdit() {
    if (!selected?.email_drafts?.id) return;
    setSaving(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await editDraft(session.access_token, selected.email_drafts.id, editSubject, editBody);
      toast.success("Draft saved");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReopen() {
    if (!selected?.email_drafts?.id) return;
    setCertifying(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await reopenDraft(session.access_token, selected.email_drafts.id);
      toast.success("Draft reopened for editing");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCertifying(false);
    }
  }

  async function handleRestoreVersion(versionId: string) {
    setRestoring(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await restoreDraftVersion(session.access_token, versionId);
      setPreviewVersionId(null);
      toast.success("Version restored");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRestoring(false);
    }
  }

  function loadVersionPreview(v: { id: string; subject: string | null; body: string | null }) {
    setPreviewVersionId(v.id);
    setEditSubject(v.subject ?? "");
    setEditBody(v.body ?? "");
  }

  const isPreviewingHistory = previewVersionId !== null && previewVersionId !== selected?.email_drafts?.id;

  // The system prompt (Settings) can be edited after a draft was already generated.
  // Only a not-yet-sent "draft" is safe to silently regenerate — anything approved/sent
  // reflects a human decision and shouldn't be nudged.
  const isPromptStaleForSelected =
    selected?.email_drafts?.status === "draft" &&
    !!systemPromptUpdatedAt &&
    !!selected.email_drafts.created_at &&
    new Date(systemPromptUpdatedAt).getTime() > new Date(selected.email_drafts.created_at).getTime();

  async function handleCertifyOne(draftId: string) {
    setCertifying(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await approveDraft(session.access_token, draftId);
      toast.success("Draft certified");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCertifying(false);
    }
  }

  async function handleBulkCertify(draftIds?: string[]) {
    const ids = draftIds ?? campaignLeads
      .filter((cl) => cl.email_drafts?.status === "draft")
      .map((cl) => cl.email_drafts!.id);
    if (ids.length === 0) return;
    setCertifying(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await bulkApproveDrafts(session.access_token, ids);
      toast.success(`${ids.length} draft${ids.length !== 1 ? "s" : ""} certified`);
      setCheckedIds(new Set());
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCertifying(false);
    }
  }

  async function handleCertifyAll() {
    await handleBulkCertify();
  }

  /**
   * Open the bulk-regenerate confirm modal. The counts come from the server, not
   * from what this component happens to have loaded — an employee's "all" is
   * only their own assigned leads, and that boundary is resolved server-side.
   */
  async function openBulkRegenerate(campaignLeadIds?: string[], stepNumber?: number) {
    setBulkRegenOpening(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const preview = await previewRegeneration(session.access_token, campaign.id, campaignLeadIds, stepNumber);
      if (preview.eligible === 0) {
        toast.info(
          (stepNumber ?? 1) > 1
            ? "No follow-ups are eligible — already-sent ones cannot be rewritten."
            : "No drafts are eligible — certified and sent emails are not regenerated in bulk.",
        );
        return;
      }
      setBulkRegenPreview({
        counts: preview.by_status,
        skipped: preview.skipped,
        isSubset: !!campaignLeadIds?.length,
        campaignLeadIds,
        stepNumber,
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBulkRegenOpening(false);
    }
  }

  async function submitBulkRegenerate(instruction: string) {
    if (!bulkRegenPreview) return;
    setBulkRegenSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { total } = await regenerateCampaignDrafts(session.access_token, campaign.id, {
        campaignLeadIds: bulkRegenPreview.campaignLeadIds,
        customInstruction: instruction || undefined,
        stepNumber: bulkRegenPreview.stepNumber,
      });
      toast.success(`Regenerating ${total} draft${total !== 1 ? "s" : ""} in the background`);
      setBulkRegenPreview(null);
      setCheckedIds(new Set());
      await loadRegenJob();
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBulkRegenSubmitting(false);
    }
  }

  async function handleCancelRegenJob() {
    setCancellingJob(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { remaining } = await cancelRegenerationJob(session.access_token, campaign.id);
      toast.success(`Regeneration cancelled — ${remaining} lead${remaining !== 1 ? "s" : ""} left untouched`);
      await loadRegenJob();
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCancellingJob(false);
    }
  }

  function markRegenerating(campaignLeadIds: string[], on: boolean) {
    setLocallyRegenerating((prev) => {
      const next = new Set(prev);
      for (const id of campaignLeadIds) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }

  async function handleRegenerate() {
    if (!selected?.email_drafts?.id) return;
    // An instruction is required. With an empty box this used to fall through to
    // a from-scratch rewrite, so one button meant two different things depending
    // on whether a field had text in it — and pressing it twice with the same
    // instruction produced byte-identical drafts, which read as "regenerate does
    // nothing". Rewriting from scratch has its own labelled button
    // ("Regenerate using new system prompt").
    if (!regenQuery.trim()) return;
    const clId = selected.id;
    setRegenerating(true);
    markRegenerating([clId], true);
    setRegenOpen(false);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { draft } = await regenerateDraft(session.access_token, selected.email_drafts.id, regenQuery || undefined);
      setEditSubject(draft.subject ?? "");
      setEditBody(draft.body ?? "");
      setRegenQuery("");
      toast.success("Draft regenerated");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRegenerating(false);
      markRegenerating([clId], false);
    }
  }

  async function handleRegenerateWithNewPrompt() {
    if (!selected?.email_drafts?.id) return;
    const clId = selected.id;
    setRegenerating(true);
    markRegenerating([clId], true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { draft } = await regenerateDraft(session.access_token, selected.email_drafts.id);
      setEditSubject(draft.subject ?? "");
      setEditBody(draft.body ?? "");
      toast.success("Draft regenerated with the updated system prompt");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRegenerating(false);
      markRegenerating([clId], false);
    }
  }

  async function handleSend(campaignLeadIds?: string[]) {
    setSending(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const toSend = campaignLeadIds?.length ?? sendReadyLeads.length;
      if (toSend === 0) {
        setError("No certified leads to send.");
        return;
      }
      const result = await sendApprovedLeads(
        session.access_token,
        campaign.id,
        campaignLeadIds?.length ? { campaignLeadIds } : undefined,
      );
      if (result.sent === 0) {
        toast.error("No leads were sent to Instantly. Check timezone and sending window settings.");
        return;
      }
      toast.success(`${result.sent} lead${result.sent !== 1 ? "s" : ""} sent to Instantly`);
      setCheckedIds(new Set());
      await loadData();
      await loadCampaigns(session.access_token);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // Send-only. Certifying used to live here too, which meant a ticked draft put
  // an identical "Certify (N)" in both the header and the list toolbar. Certify
  // now has exactly two homes — "Certify all" in the header for the whole
  // campaign, "Certify (N)" in the toolbar for what you ticked — matching the
  // Regenerate pair beside them.
  async function handlePrimaryAction() {
    if (checkedSendCount > 0) {
      const ids = campaignLeads
        .filter((cl) => checkedIds.has(cl.id) && sendReadyLeads.some((s) => s.id === cl.id))
        .map((cl) => cl.id);
      await handleSend(ids);
      return;
    }
    await handleSend();
  }

  async function handleRetryOne(draftId: string, campaignLeadId: string) {
    setRetryingId(campaignLeadId);
    markRegenerating([campaignLeadId], true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await regenerateDraft(session.access_token, draftId);
      toast.success("Draft queued for regeneration");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRetryingId(null);
      markRegenerating([campaignLeadId], false);
    }
  }

  async function handleRetryAllFailed() {
    setRetryingAll(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { retried, errors } = await retryFailedDrafts(session.access_token, campaign.id);
      if (errors.length > 0 && retried === 0) {
        toast.error(errors[0] ?? "Retry failed");
      } else if (errors.length > 0) {
        toast.warning(`Retried ${retried}; ${errors.length} still failed`);
      } else {
        toast.success(`${retried} draft${retried !== 1 ? "s" : ""} queued for regeneration`);
      }
      await loadData();
      if (viewTab === "analytics") {
        const data = await fetchCampaignReport(session.access_token, campaign.id);
        setReport(data);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetryingAll(false);
    }
  }

  /**
   * Regenerate ONE lead's follow-up.
   *
   * Goes through regenerateDraft (the same versioned path opening emails use),
   * not the older followup-regenerate endpoint: that one rewrites existing text
   * with no company context, which is exactly what made follow-ups generic. This
   * route re-runs generation for the draft's own step, so it picks up the
   * follow-up prompt and the prospect's details.
   *
   * The new text is written to the database immediately, so it survives
   * switching lead, switching tab or closing the drawer — reopening never costs
   * another AI call. The previous version is kept, not overwritten.
   */
  /**
   * Open (or close) the version history for the lead's follow-up, fetching it
   * the first time.
   *
   * Refetches on every open rather than caching: the user regenerates from the
   * same panel, so a cached list is stale the moment it is most likely to be
   * looked at.
   */
  async function toggleSeqHistory(draftId: string) {
    if (seqHistoryOpen === draftId) { setSeqHistoryOpen(null); return; }
    setSeqHistoryOpen(draftId);
    setSeqHistoryLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { versions: v } = await fetchDraftHistory(session.access_token, draftId);
      setSeqVersions(v);
    } catch {
      setSeqVersions([]);
    } finally {
      setSeqHistoryLoading(false);
    }
  }

  /** Bring an older follow-up back as the current one. Restoring is itself
   *  versioned server-side, so the text being replaced is not lost either. */
  async function handleRestoreSeqVersion(versionId: string) {
    setSeqRestoring(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await restoreDraftVersion(session.access_token, versionId);
      setSeqPreviewVersion(null);
      setSeqHistoryOpen(null);
      toast.success("Version restored");
      await loadData();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSeqRestoring(false);
    }
  }

  /**
   * Save the follow-up waits from the Steps pane.
   *
   * Goes through the same route the Options tab uses, so it inherits
   * prepare-then-publish: if the new timing makes follow-ups due that have no
   * text yet, Instantly is left on the OLD schedule until they are written,
   * rather than firing boilerplate into the gap.
   */
  /**
   * Save a hand-edited follow-up.
   *
   * Goes through the draft edit action, which pushes to Instantly — Instantly
   * holds its own copy of the body and reads it once, so without that push the
   * edit would be visible here and the customer would still receive the text
   * that was just replaced.
   */
  async function handleSaveFollowupEdit(draftId: string) {
    setSeqEditSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      await editDraft(session.access_token, draftId, "", seqEditBody);
      setSeqEditingDraftId(null);
      await loadData();
      toast.success("Follow-up updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSeqEditSaving(false);
    }
  }

  async function handleSaveSeqSteps() {
    if (!canEditSettings) return;
    setSeqStepSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const rebuilt = rebuildStepsWithFollowupWaits(campaignSteps, seqStepEdits)
        // rebuildStepsWithFollowupWaits only knows about timing, so the
        // per-step instruction is re-attached by position afterwards.
        .map((st) => st.step_order > 1
          ? { ...st, ai_instruction: seqStepEdits[st.step_order - 2]?.ai_instruction ?? null }
          : st);
      const res = await saveCampaignSteps(
        session.access_token, campaign.id, rebuilt, seqCampaignInstruction.trim() || null,
      );
      const { steps } = await fetchCampaignSteps(session.access_token, campaign.id);
      setCampaignSteps(steps);
      toast.success(
        res.published === false
          ? `Saved. Writing ${res.preparing} follow-up${res.preparing === 1 ? "" : "s"} before this goes live — Instantly keeps the current schedule until then.`
          : "Steps saved",
      );
    } catch (e) {
      toast.error("Failed to save: " + (e as Error).message);
    } finally {
      setSeqStepSaving(false);
    }
  }

  async function handleRegenerateLeadFollowup(campaignLeadId: string, draftId: string, instruction?: string) {
    if (!canEditSettings) return;
    setSeqLeadRegenerating(campaignLeadId);
    setSeqRegenOpenFor(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      // Blank means "write it again from scratch"; text means "change this
      // specific thing", which the generator treats as an edit of the current
      // email rather than a fresh one.
      await regenerateDraft(session.access_token, draftId, instruction?.trim() || undefined);
      // The list gained an entry and the previewed one is no longer current.
      setSeqPreviewVersion(null);
      setSeqHistoryOpen(null);
      setSeqRegenQuery("");
      await loadData();
      toast.success("Follow-up regenerated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSeqLeadRegenerating(null);
    }
  }

  function handleKanbanSelect(campaignLeadId: string) {
    setSelectedId(campaignLeadId);
    setViewTab("leads");
  }

  function handleOpenInOutbox(campaignLeadId: string) {
    setSelectedId(campaignLeadId);
    setOutboxFilter("all");
    setViewTab("outbox");
  }

  /** The contact added to answer this bounce, if there is one. It was put into
   *  THIS campaign and inherits the bounced lead's owner, so it is always
   *  already in `campaignLeads` — no extra fetch to name it. */
  function replacementFor(cl: CampaignLead): CampaignLead | null {
    if (!cl.replaced_by_lead_id) return null;
    return campaignLeads.find((c) => c.lead_id === cl.replaced_by_lead_id) ?? null;
  }

  function replacedTooltip(cl: CampaignLead): string {
    const r = replacementFor(cl);
    const who = r?.leads?.email
      ?? [r?.leads?.first_name, r?.leads?.last_name].filter(Boolean).join(" ");
    return who ? `Replaced by ${who}` : "A replacement contact was added at this company";
  }

  /** The other direction: the bounced contact this one stands in for. The
   *  bounced row stays in the campaign after being retired, so it is still here
   *  to name and to open. */
  function originalFor(cl: CampaignLead): CampaignLead | null {
    const id = cl.leads?.replaces_lead_id;
    if (!id) return null;
    return campaignLeads.find((c) => c.lead_id === id) ?? null;
  }

  function replacesTooltip(cl: CampaignLead): string {
    const original = originalFor(cl);
    const who = [original?.leads?.first_name, original?.leads?.last_name].filter(Boolean).join(" ")
      || original?.leads?.email;
    return who ? `Added to replace ${who}, whose address bounced` : "Added to replace a bounced contact";
  }

  /** The two chips are a two-way door: a bounce opens its replacement, a
   *  replacement opens the bounce it answers. Neither is a dead end. */
  function openReplacementOf(cl: CampaignLead) {
    const r = replacementFor(cl);
    if (r) handleOpenInOutbox(r.id);
  }

  function openOriginalOf(cl: CampaignLead) {
    const o = originalFor(cl);
    if (o) handleOpenInOutbox(o.id);
  }

  /** A bounce cost us a door into that company, not the company itself — this
   *  opens the dialog that adds another address there. */
  function openReplace(cl: CampaignLead) {
    setReplaceError("");
    setReplaceTarget({
      campaignLeadId: cl.id,
      bouncedName: [cl.leads?.first_name, cl.leads?.last_name].filter(Boolean).join(" ") || "This contact",
      bouncedEmail: cl.leads?.email ?? null,
      companyName: cl.leads?.company_name ?? null,
      companyWebsite: cl.leads?.company_website ?? cl.leads?.company_domain ?? null,
    });
  }

  async function handleReplaceConfirm(input: { email: string; first_name: string; last_name?: string; title?: string }) {
    if (!replaceTarget) return;
    setReplaceSubmitting(true);
    setReplaceError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { campaign_lead_id } = await replaceBouncedLead(session.access_token, replaceTarget.campaignLeadId, input);
      setReplaceTarget(null);
      toast.success("Contact corrected — writing their email now");
      await loadData();
      // Same row as before (in-place correction) — reopen it so the new draft
      // is what the user lands on to certify.
      handleOpenInOutbox(campaign_lead_id);
    } catch (e) {
      // Stays open with the message — most failures here are fixable in place
      // (address already a lead, held by a colleague, company unsubscribed).
      setReplaceError((e as Error).message);
    } finally {
      setReplaceSubmitting(false);
    }
  }

  const checkedSendCount = campaignLeads.filter(
    (cl) => checkedIds.has(cl.id) && sendReadyLeads.some((s) => s.id === cl.id)
  ).length;

  const primaryAction =
    checkedSendCount > 0
      ? { mode: "send" as const, count: checkedSendCount }
      : certifiedCount > 0
        ? { mode: "sendAll" as const, count: certifiedCount }
        : { mode: "none" as const, count: 0 };

  const primaryBusy = sending;
  const primaryLabel = primaryBusy
    ? "Sending…"
    : primaryAction.mode === "send"
      ? `Send (${primaryAction.count})`
      : primaryAction.mode === "sendAll"
        ? `Send all (${primaryAction.count})`
        : "Send all (0)";

  // Counts come from the UNFILTERED set, so a chip never reports a number that
  // shrinks the moment you click it.
  const deliveryCounts = campaignLeads.reduce((acc, cl) => {
    const b = deliveryBucket(cl);
    acc[b] = (acc[b] ?? 0) + 1;
    return acc;
  }, {} as Partial<Record<DeliveryBucket, number>>);
  const followupDueCount = campaignLeads.filter((cl) => hasUpcomingFollowup(cl, campaignSteps)).length;
  const followupSentCount = campaignLeads.filter(hasReceivedFollowup).length;

  // One { sent, due } pair per configured follow-up step, so the dropdown can say
  // "Follow-up 1 sent (86)" instead of lumping every step into one number.
  // Counted through matchesDeliveryFilter, the same function the list filters
  // with, so a count can never disagree with the rows it produces.
  const followupStepCounts = sequenceFollowUpSteps(campaignSteps).map((step) => ({
    stepOrder: step.step_order,
    label: `Follow-up ${sequenceDisplayStep(step.step_order)}`,
    sent: campaignLeads.filter((cl) =>
      matchesDeliveryFilter(cl, `followup_sent_${step.step_order}`, campaignSteps)).length,
    due: campaignLeads.filter((cl) =>
      matchesDeliveryFilter(cl, `followup_${step.step_order}`, campaignSteps)).length,
  }));

  // Applied before the split into list/kanban so BOTH views honour the filter.
  const sortedCampaignLeads = sortCampaignLeads(campaignLeads, leadsSort)
    .filter((cl) => matchesDeliveryFilter(cl, leadsDelivery, campaignSteps));

  const filteredLeads = sortedCampaignLeads.filter((cl) => {
    if (!leadsSearch) return true;
    const name = [cl.leads?.first_name, cl.leads?.last_name].filter(Boolean).join(" ").toLowerCase();
    const email = (cl.leads?.email ?? "").toLowerCase();
    const q = leadsSearch.toLowerCase();
    return name.includes(q) || email.includes(q);
  });

  const selectedThread = threads.find((t) => t.campaign_lead_id === selectedId) ?? null;

  // A bounce that has already been answered. Its email was never read, so the
  // Outbox shows the handoff to the replacement instead of a thread nobody can
  // act on — the dead mail stays one click away, not deleted.
  const isReplacedBounce = !!selected && !!selected.replaced_by_lead_id && deliveryBucket(selected) === "bounced";
  const selectedReplacement = selected ? replacementFor(selected) : null;
  const selectedOriginal = selected ? originalFor(selected) : null;

  const outboxReplyName = selected
    ? [selected.leads?.first_name, selected.leads?.last_name].filter(Boolean).join(" ") || selectedThread?.lead_email || "Unknown"
    : "Unknown";

  type OutboxMessageItem = {
    id: string;
    sender: string;
    to: string;
    cc: string;
    /** Inbound message from someone other than the lead (joined via CC). */
    fromThirdParty: boolean;
    /** Instantly id of the inbound message a reply from here would thread off
     *  — itself when this item IS inbound, otherwise the nearest earlier
     *  inbound message (see replyTargetFor). Null only when nothing inbound
     *  exists yet at this point in the thread. */
    replyTargetId: string | null;
    /** Who that reply will actually address — for the button label, since an
     *  outbound item's own sender ("You") is never the right name to show. */
    replyTargetName: string | null;
    isUnanswered: boolean;
    /** Sender of the message this reply answered, for our own sent mail. */
    inReplyToLabel: string | null;
    /** Third participant not yet a lead — the address to promote. */
    promotableEmail: string | null;
    /** "Opening email" / "Follow-up 1" for a sequence send; null for a manual reply. */
    stepLabel: string | null;
    timestamp: string | null;
    bodyHtml: string | null;
    bodyText: string | null;
  };

  // Falls back to the lead's own record when there is no reply-thread row at
  // all for this lead (getCampaignReplyThreads deliberately skips never-replied
  // leads — see its own comment — so selectedThread is routinely null here).
  const outboxLeadAddress = parseAddressList(selectedThread?.lead_email ?? selected?.leads?.email ?? null)[0] ?? null;
  /** The lead's name only when the message really is from the lead — otherwise
   *  the raw address. The Outbox used to label every inbound message with the
   *  lead's name, so a CC'd third party's reply was indistinguishable from the
   *  prospect's own. */
  const outboxSenderName = (fromEmail: string | null): { name: string; thirdParty: boolean } => {
    const from = parseAddressList(fromEmail)[0] ?? null;
    if (!from) return { name: outboxReplyName, thirdParty: false };
    if (outboxLeadAddress && from === outboxLeadAddress) return { name: outboxReplyName, thirdParty: false };
    return { name: from, thirdParty: true };
  };

  // What the sequence actually sent — the opening email AND every follow-up —
  // straight from the mirrored mail. Needed up here (not just for rendering
  // below) so it can join the unified participant list next.
  const outboxSequenceSends = selected?.sequence_messages ?? [];

  // Participant view of the thread, shared with the Unibox so both surfaces
  // agree on who is owed a reply. Includes sequence sends too (not just
  // inbound + manual replies) so a cold-outreach thread the lead has never
  // answered still has a valid reply target: itself (see replyTargetFor).
  // Sequence sends are included unconditionally, not gated on selectedThread
  // existing — a lead who has never replied has no reply-thread row at all in
  // some states, but their sequence sends are still real, replyable messages.
  const outboxParticipantMessages = [
    ...(selectedThread?.messages ?? []).map((m) => ({
      instantly_email_id: m.instantly_email_id,
      direction: "received",
      from_email: m.from_email,
      to_emails: m.to_emails,
      cc_emails: m.cc_emails,
      timestamp_email: m.received_at,
    })),
    ...(selectedThread?.sent_messages ?? []).map((m) => ({
      instantly_email_id: m.instantly_email_id,
      direction: "sent_manual",
      from_email: m.from_email,
      to_emails: m.to_emails,
      cc_emails: m.cc_emails,
      timestamp_email: m.sent_at,
    })),
    ...outboxSequenceSends
      .filter((m): m is typeof m & { instantly_email_id: string; timestamp_email: string } => !!m.instantly_email_id && !!m.timestamp_email)
      .map((m) => ({
        instantly_email_id: m.instantly_email_id,
        direction: "sent_campaign",
        from_email: m.from_email,
        to_emails: m.to_emails,
        cc_emails: m.cc_emails,
        timestamp_email: m.timestamp_email,
      })),
  ];
  // Same fallback as the lead address: a never-replied lead has no
  // selectedThread, but their own sequence sends still know which mailbox
  // sent them.
  const outboxFallbackEaccount = outboxSequenceSends.find((m) => !!m.eaccount)?.eaccount ?? null;
  const outboxFallbackThreadId = outboxSequenceSends.find((m) => !!m.thread_id)?.thread_id ?? null;
  const outboxOurEmails = ourAddresses(outboxParticipantMessages, [selectedThread?.eaccount ?? outboxFallbackEaccount]);
  const outboxUnansweredIds = new Set(
    unansweredInbound(outboxParticipantMessages, outboxOurEmails).map((m) => m.instantly_email_id),
  );
  // The message the composer answers — an explicit pick (which may itself be
  // one of our own outbound sends now, see resolveOutboxReplyTarget below),
  // else the thread's newest message run through replyTargetFor so the
  // default "Reply" button works even on a pure cold-outreach thread.
  const outboxExplicitTarget = outboxReplyTargetId
    ? outboxParticipantMessages.find((m) => m.instantly_email_id === outboxReplyTargetId) ?? null
    : null;
  const outboxNewestMessage = outboxParticipantMessages.length > 0
    ? [...outboxParticipantMessages].sort((a, b) => a.timestamp_email.localeCompare(b.timestamp_email))[outboxParticipantMessages.length - 1]
    : null;
  const outboxActiveTarget = outboxExplicitTarget
    ?? (outboxNewestMessage ? replyTargetFor(outboxNewestMessage, outboxParticipantMessages) : null);
  const outboxActiveTargetId = outboxActiveTarget?.instantly_email_id ?? null;
  // Sender of each message, so a sent reply can name what it answered.
  async function handleOutboxConfirmAddLead(firstName: string, lastName: string) {
    if (!outboxAddLeadFor || !selectedThread) return;
    setOutboxSavingLead(true);
    try {
      await addThreadParticipantAsLead(appSession?.access_token ?? "", selectedThread.thread_key, {
        email: outboxAddLeadFor,
        first_name: firstName,
        last_name: lastName || undefined,
      });
      toast.success(`${firstName} added as a lead`);
      setOutboxAddLeadFor(null);
      void loadReplies();
    } catch (e) {
      const err = e as Error & { code?: string };
      toast.error(err.code === "DUPLICATE" ? "This person is already a lead" : err.message);
    } finally {
      setOutboxSavingLead(false);
    }
  }

  const outboxKnownLeadSet = new Set(
    (selectedThread?.known_lead_emails ?? []).map((e) => e.trim().toLowerCase()),
  );
  const outboxSenderByEmailId = new Map<string, string>(
    outboxParticipantMessages
      .map((m) => [m.instantly_email_id, parseAddressList(m.from_email)[0]] as const)
      .filter((pair): pair is readonly [string, string] => !!pair[1]),
  );

  // Lets an outbound row (a sequence send or one of our own manual replies)
  // start a reply too, Gmail-style — resolves via replyTargetFor against the
  // full unified message list, so a cold-outreach row with nobody to answer
  // yet falls back to itself (a real, usable Instantly id) rather than null.
  function resolveOutboxReplyTarget(
    candidate: {
      instantly_email_id: string;
      direction: string;
      from_email: string | null;
      to_emails: string | null;
      cc_emails: string | null;
      timestamp_email: string;
    } | null,
  ): { id: string; name: string } | null {
    if (!candidate) return null;
    const target = replyTargetFor(candidate, outboxParticipantMessages);
    // An inbound target is who this actually answers. An outbound one (only
    // reachable when nobody has replied at all) still addresses the lead in
    // practice — see replyRecipients — so it must be labeled as such, not
    // with our own sending address.
    if (!isInbound(target)) return { id: target.instantly_email_id, name: outboxReplyName };
    const from = parseAddressList(target.from_email)[0] ?? null;
    const name = from ? (from === outboxLeadAddress ? outboxReplyName : from) : "Unknown sender";
    return { id: target.instantly_email_id, name };
  }

  const outboxMessageItems: OutboxMessageItem[] = [];
  // What the sequence actually sent — the opening email AND every follow-up —
  // straight from the mirrored mail. This is the real record of what left; the
  // draft below is only what we composed.
  for (const m of outboxSequenceSends) {
    const seqReplyTarget = resolveOutboxReplyTarget(
      m.instantly_email_id && m.timestamp_email
        ? {
            instantly_email_id: m.instantly_email_id,
            direction: "sent_campaign",
            from_email: m.from_email,
            to_emails: m.to_emails,
            cc_emails: m.cc_emails,
            timestamp_email: m.timestamp_email,
          }
        : null,
    );
    outboxMessageItems.push({
      id: `seq-${m.id}`,
      sender: "You",
      to: parseAddressList(m.to_emails).join(", ") || (selectedThread?.lead_email ?? outboxReplyName),
      cc: parseAddressList(m.cc_emails).join(", "),
      fromThirdParty: false,
      replyTargetId: seqReplyTarget?.id ?? null,
      replyTargetName: seqReplyTarget?.name ?? null,
      isUnanswered: false,
      inReplyToLabel: null,
      promotableEmail: null,
      stepLabel: sequenceStepLabel(m.step),
      timestamp: m.timestamp_email,
      bodyHtml: m.body_html,
      bodyText: m.body_text,
    });
  }
  // Fallback for the opening email only: the Unibox sync runs on a schedule, so
  // a just-sent lead has no mirrored copy yet. Never both — that would show the
  // same email twice.
  if (outboxSequenceSends.length === 0 && selected?.email_drafts?.status === "sent") {
    // This row is a draft record, not a real Instantly email — it has no
    // instantly_email_id of its own, so unlike the cases below it can never
    // fall back to itself. Only resolve if a real inbound message exists.
    const initialReplyTarget = ((): { id: string; name: string } | null => {
      const createdAt = selected.email_drafts.created_at;
      if (!createdAt) return null;
      const synthetic = {
        instantly_email_id: "__draft__",
        direction: "sent_manual",
        from_email: null,
        to_emails: null,
        cc_emails: null,
        timestamp_email: createdAt,
      };
      const target = replyTargetFor(synthetic, outboxParticipantMessages);
      if (target.instantly_email_id === "__draft__") return null;
      const from = parseAddressList(target.from_email)[0] ?? null;
      const name = from ? (from === outboxLeadAddress ? outboxReplyName : from) : "Unknown sender";
      return { id: target.instantly_email_id, name };
    })();
    outboxMessageItems.push({
      id: `initial-${selected.email_drafts.id}`,
      sender: "You",
      to: selectedThread?.lead_email ?? outboxReplyName,
      cc: "",
      fromThirdParty: false,
      replyTargetId: initialReplyTarget?.id ?? null,
      replyTargetName: initialReplyTarget?.name ?? null,
      isUnanswered: false,
      inReplyToLabel: null,
      promotableEmail: null,
      stepLabel: "Opening email",
      timestamp: selected.email_drafts.created_at ?? null,
      bodyHtml: selectedThread?.original_email?.body ?? selected.email_drafts.body ?? "",
      bodyText: null,
    });
  }
  if (selectedThread) {
    for (const msg of selectedThread.messages) {
      const { name, thirdParty } = outboxSenderName(msg.from_email);
      const from = parseAddressList(msg.from_email)[0] ?? null;
      outboxMessageItems.push({
        id: msg.id,
        sender: name,
        to: parseAddressList(msg.to_emails).join(", "),
        cc: parseAddressList(msg.cc_emails).join(", "),
        fromThirdParty: thirdParty,
        replyTargetId: msg.instantly_email_id,
        replyTargetName: name,
        isUnanswered: outboxUnansweredIds.has(msg.instantly_email_id),
        inReplyToLabel: null,
        promotableEmail:
          thirdParty && from && !outboxKnownLeadSet.has(from) && !outboxOurEmails.has(from) ? from : null,
        stepLabel: null,
        timestamp: msg.received_at,
        bodyHtml: null,
        bodyText: stripQuotedLines(msg.reply_body) ?? "",
      });
    }
    // Sent replies come from the mirrored mail, not from reply_drafts: a draft
    // records what we wrote, only the sent message records who received it —
    // and Instantly addresses a reply to the sender of the message it answers,
    // which is frequently NOT the lead.
    for (const sent of selectedThread.sent_messages) {
      // Prefer the exact message this reply answered (recorded at send time)
      // over the nearest-by-timestamp guess — more precise when available.
      const repliedToInbound = sent.in_reply_to_email_id
        && outboxParticipantMessages.some((m) => m.direction === "received" && m.instantly_email_id === sent.in_reply_to_email_id)
        ? sent.in_reply_to_email_id
        : null;
      const sentReplyTarget = repliedToInbound
        ? { id: repliedToInbound, name: outboxSenderByEmailId.get(repliedToInbound) ?? "Unknown sender" }
        : resolveOutboxReplyTarget({
            instantly_email_id: sent.instantly_email_id,
            direction: "sent_manual",
            from_email: sent.from_email,
            to_emails: sent.to_emails,
            cc_emails: sent.cc_emails,
            timestamp_email: sent.sent_at,
          });
      outboxMessageItems.push({
        id: `sent-${sent.id}`,
        sender: sent.sent_by_name ?? "You",
        to: parseAddressList(sent.to_emails).join(", "),
        cc: parseAddressList(sent.cc_emails).join(", "),
        fromThirdParty: false,
        replyTargetId: sentReplyTarget?.id ?? null,
        replyTargetName: sentReplyTarget?.name ?? null,
        isUnanswered: false,
        inReplyToLabel: sent.in_reply_to_email_id
          ? outboxSenderByEmailId.get(sent.in_reply_to_email_id) ?? null
          : null,
        promotableEmail: null,
        stepLabel: null, // a manual reply is not a sequence step
        timestamp: sent.sent_at,
        bodyHtml: sent.body_html,
        bodyText: sent.body_text,
      });
    }
  }
  // Outside the thread block: a lead who never replied has no thread at all, but
  // now still has sequence sends to order.
  outboxMessageItems.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  const outboxLastItemId = outboxMessageItems.length > 0 ? outboxMessageItems[outboxMessageItems.length - 1].id : null;

  const TEMP_BADGE: Record<string, { label: string; cls: string; icon?: React.ReactNode }> = {
    hot:          { label: "HOT",          cls: "bg-red-500/15 text-red-400 border-red-500/30",     icon: <Flame className="size-3" /> },
    warm:         { label: "WARM",         cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
    cold:         { label: "COLD",         cls: "bg-sky-500/15 text-sky-400 border-sky-500/30",     icon: <Snowflake className="size-3" /> },
    neutral:      { label: "NEUTRAL",      cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
    ooo:          { label: "OUT OF OFFICE",cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    unsubscribed: { label: "UNSUBSCRIBED", cls: "bg-zinc-700/40 text-zinc-500 border-zinc-600/30" },
  };

  const pendingReplyDrafts = threads.reduce(
    (count, t) => count + t.messages.filter((m) => m.reply_drafts.some((d) => d.status === "draft")).length,
    0
  );

  const outboxActionableCount = draftReadyLeads.length + threads.filter((t) => {
    const latestMsg = t.messages[t.messages.length - 1];
    return latestMsg?.reply_drafts[latestMsg.reply_drafts.length - 1]?.status === "draft";
  }).length;

  const outboxThreadByLeadId = new Map(threads.filter((t) => t.campaign_lead_id).map((t) => [t.campaign_lead_id as string, t]));

  // ── Analytics tab derived data ──────────────────────────────────────────
  // Prefer the scoped report + loaded campaignLeads (already filtered to the
  // caller's assigned leads for employees). campaign.leads/sent/hot are only a
  // fallback before the first load — never show campaign-wide totals once we
  // have the employee's own rows.
  const scopedStats = computeCampaignStats(campaignLeads);
  const analyticsTotalLeads = report?.totals.leads ?? (!loading ? scopedStats.total_leads : (campaign.leads ?? 0));
  const analyticsSent = report?.totals.sent ?? (!loading ? scopedStats.sent_count : (campaign.sent ?? 0));
  const analyticsReplied = report?.totals.replied ?? (!loading ? scopedStats.replied_count : (campaign.replied ?? 0));
  const analyticsBounced = report?.totals.bounced ?? (!loading ? scopedStats.bounced_count : (campaign.bounced ?? 0));
  const analyticsHot = !loading ? scopedStats.hot_count : (campaign.hot ?? 0);
  const analyticsCold = !loading ? scopedStats.cold_count : (campaign.cold ?? 0);
  // Reply rate divides by DELIVERED, not by the SENT tile — a reply proves the
  // mail arrived, so it belongs in the base even though it left the tile.
  const analyticsDelivered = report?.totals.delivered
    ?? (!loading ? scopedStats.delivered_count : (campaign.delivered ?? 0));
  const analyticsReplyRate = report?.rates.replyRate
    ?? (analyticsDelivered > 0 ? Math.round((analyticsReplied / analyticsDelivered) * 100) : 0);

  // NOTE: --primary/--muted-foreground already hold a complete `hsl(...)` string
  // (set dynamically in lib/branding.ts), so wrapping them again in `hsl(var(...))`
  // is invalid CSS and silently falls back to black — use the var directly.
  // Colors are solid (no opacity shading) and keyed by stage id, not array
  // position, since stageDistribution only includes non-empty stages and their
  // order/count shifts per campaign. Stage ids are DeliveryBucket values (see
  // app/api/v1/campaigns/[id]/report/route.ts) — the same "sent excludes
  // replied/bounced" definition used everywhere else on this tab, so this
  // donut can no longer disagree with the Sent/Replied/Bounced tiles above it.
  const PIPELINE_STAGE_STYLE: Record<string, { fill: string; opacity: number }> = {
    not_queued:  { fill: "var(--muted-foreground)", opacity: 0.35 },
    sending:     { fill: "var(--muted-foreground)", opacity: 0.6 },
    sent:        { fill: "var(--primary)", opacity: 1 },
    replied:     { fill: "#22c55e", opacity: 1 },
    bounced:     { fill: "var(--destructive)", opacity: 1 },
    send_failed: { fill: "var(--destructive)", opacity: 0.5 },
  };
  // "Sent" reads as the delivered TOTAL on the tile row above (matches
  // DELIVERY_BUCKET_LABELS everywhere else, e.g. the Leads/Outbox filter
  // dropdowns) — but here it's specifically the leftover slice with no reply
  // or bounce yet, so it needs its own name or it'd look like a second,
  // smaller "Sent" number right next to the real one.
  const PIPELINE_STAGE_NAME_OVERRIDE: Record<string, string> = {
    sent: "No reply yet",
  };
  const pipelineData = report && report.stageDistribution.length > 0
    ? report.stageDistribution.map((s) => ({
        name: PIPELINE_STAGE_NAME_OVERRIDE[s.stage] ?? s.label,
        value: s.count,
        ...(PIPELINE_STAGE_STYLE[s.stage] ?? { fill: "var(--primary)", opacity: 1 }),
      }))
    : [{ name: "No data", value: 1, fill: "var(--muted)", opacity: 1 }];

  const funnelData = report ? [
    { name: "Leads",  v: report.totals.leads,           fill: "var(--primary)", opacity: 1 },
    { name: "Gen",    v: report.totals.draftsGenerated, fill: "var(--primary)", opacity: 1 },
    { name: "Cert",   v: report.totals.certified,       fill: "var(--primary)", opacity: 1 },
    { name: "Sent",   v: report.totals.sent,            fill: "var(--primary)", opacity: 1 },
    { name: "Failed", v: report.totals.failed,          fill: "#ef4444",        opacity: 1 },
  ] : [];

  const analyticsNeutral = Math.max(0, analyticsTotalLeads - analyticsHot - analyticsCold);
  const tempData = [
    { name: "Hot",     value: analyticsHot,     fill: "#ef4444",             opacity: 1 },
    { name: "Cold",    value: analyticsCold,     fill: "#0ea5e9",             opacity: 1 },
    { name: "Neutral", value: analyticsNeutral,  fill: "var(--muted-foreground)", opacity: 0.35 },
  ].filter((d) => d.value > 0);
  if (tempData.length === 0) tempData.push({ name: "No data", value: 1, fill: "var(--muted)", opacity: 1 });

  // Real delivery per step (confirmed by Instantly's own send webhook) — NOT
  // email_drafts.status="sent", which only means Instantly accepted the draft
  // into its queue. Deliberately simple: exact sent count/percent per step,
  // plus how many of those bounced (bounced_step === this step) — a bounce
  // still counts as "sent" (the mail left, the mailbox rejected it), so it's
  // shown as a marker inside the sent portion, not a separate bucket.
  const analyticsTotalSteps = 1 + sequenceFollowUpSteps(campaignSteps).filter((s) => s.subject.trim() || s.body.trim()).length;
  const stepDeliveryPct = campaignSteps.length === 0 ? [] : Array.from({ length: analyticsTotalSteps }, (_, i) => i + 1).map((step) => {
    const total = campaignLeads.length;
    const sent = campaignLeads.filter((cl) => effectiveLastStep(cl) >= step).length;
    const bounced = campaignLeads.filter((cl) => (cl.bounced_step ?? 0) === step).length;
    return {
      step,
      name: step === 1 ? "Opening email" : `Follow-up ${step - 1}`,
      sent,
      bounced,
      total,
      pct: total > 0 ? Math.round((sent / total) * 100) : 0,
    };
  });

  // Small tile row above the step-performance panel — cheap aggregates over
  // stepDeliveryPct/campaignLeads, no new fetches.
  const followupsSentTotal = campaignLeads.filter((cl) => effectiveLastStep(cl) >= 2).length;
  const followupsDueTotal = campaignLeads.filter((cl) => hasUpcomingFollowup(cl, campaignSteps)).length;
  const followupsStoppedTotal = campaignLeads.filter((cl) => {
    const b = deliveryBucket(cl);
    return b === "replied" || b === "bounced";
  }).length;

  const OUTBOX_FILTERS: Array<{ id: typeof outboxFilter; label: string }> = [
    { id: "all",       label: "All" },
    { id: "action",    label: "Needs action" },
    { id: "certified", label: "Certified" },
    { id: "sending",   label: "Sending" },
    // Not "Sent" — deliveryBucket's "sent" excludes anyone who has since
    // replied or bounced, so sitting right above "Follow-up sent" (which
    // counts across ALL outcomes, replied/bounced included) made it read as
    // a delivered total it isn't and made Follow-up sent look impossibly
    // larger. Same distinction the Analytics tab makes with "No reply yet".
    { id: "sent",      label: "No reply yet" },
    { id: "followup_sent", label: "Follow-up sent" },
    { id: "followup",  label: "Follow-up due" },
    { id: "replied",   label: "Replied" },
    { id: "bounced",   label: "Bounced" },
  ];

  function matchesOutboxFilter(
    cl: CampaignLead,
    filter: typeof outboxFilter,
  ): boolean {
    if (filter === "all") return true;
    const thread = outboxThreadByLeadId.get(cl.id) ?? null;
    const delivery = deliveryBucket(cl);
    // Delivery filters share the same buckets as the Leads tab so Sent never
    // swallows Bounced / Replied (draft status stays "sent" after those outcomes).
    if (filter === "sending") return delivery === "sending";
    if (filter === "sent") return delivery === "sent";
    if (filter === "followup") return hasUpcomingFollowup(cl, campaignSteps);
    if (filter === "followup_sent") return hasReceivedFollowup(cl);
    if (filter === "bounced") return delivery === "bounced";
    if (filter === "replied") return delivery === "replied" || !!thread;
    if (filter === "action") {
      if (thread) {
        const latestMsg = thread.messages[thread.messages.length - 1];
        return latestMsg?.reply_drafts[latestMsg.reply_drafts.length - 1]?.status === "draft";
      }
      return cl.email_drafts?.status === "draft";
    }
    if (filter === "certified") return cl.email_drafts?.status === "approved";
    return true;
  }

  // Counts from the full outbox set so chip numbers stay stable while filtering.
  const outboxFilterCounts = OUTBOX_FILTERS.reduce((acc, { id }) => {
    acc[id] = id === "all"
      ? campaignLeads.length
      : campaignLeads.filter((cl) => matchesOutboxFilter(cl, id)).length;
    return acc;
  }, {} as Record<typeof outboxFilter, number>);

  const outboxFilteredLeads = sortCampaignLeads(
    campaignLeads.filter((cl) => matchesOutboxFilter(cl, outboxFilter)),
    leadsSort,
  );

  const outboxSelectableFilteredLeads = outboxFilteredLeads.filter((cl) => {
    if (outboxThreadByLeadId.get(cl.id)) return false;
    return (cl.email_drafts?.status ?? "none") !== "sent";
  });

  const outboxCheckedCount = outboxSelectableFilteredLeads.filter((cl) => checkedIds.has(cl.id)).length;
  const outboxCheckedDraftIds = outboxSelectableFilteredLeads
    .filter((cl) => checkedIds.has(cl.id) && cl.email_drafts?.status === "draft")
    .map((cl) => cl.email_drafts!.id);
  const outboxFilteredDraftIds = outboxFilteredLeads
    .filter((cl) => !outboxThreadByLeadId.get(cl.id) && cl.email_drafts?.status === "draft")
    .map((cl) => cl.email_drafts!.id);
  const outboxCertifyDraftIds = outboxCheckedDraftIds.length > 0 ? outboxCheckedDraftIds : outboxFilteredDraftIds;

  // Bulk-regenerable = a live draft still in 'draft' or 'failed' (certified and
  // sent are protected). A lead with a reply thread is excluded: its outbox row
  // shows the REPLY draft's status, and replies have their own regenerate — the
  // initial email is already sent, so the server would skip it anyway.
  //
  // Two counts, mirroring the Certify pair: the header regenerates the whole
  // campaign, the toolbar only what you ticked. Both are just hints for the
  // modal — the server re-resolves targets under the caller's scope, so an
  // employee can never widen either one to a co-worker's lead.
  const isBulkRegenerable = (cl: CampaignLead) =>
    !outboxThreadByLeadId.get(cl.id) &&
    (cl.email_drafts?.status === "draft" || cl.email_drafts?.status === "failed");
  const campaignRegenerableCount = campaignLeads.filter(isBulkRegenerable).length;
  const outboxCheckedRegenIds = outboxSelectableFilteredLeads
    .filter((cl) => checkedIds.has(cl.id) && isBulkRegenerable(cl))
    .map((cl) => cl.id);
  const regenJobActive = !!regenJob?.active;

  const campaignTabs = [
    { value: "analytics" as const, label: "Analytics", icon: BarChart2 },
    { value: "leads" as const,     label: "Leads",     icon: List,   count: analyticsTotalLeads },
    { value: "outbox" as const,    label: "Outbox",    icon: Send,   count: outboxActionableCount || undefined },
    { value: "sequences" as const, label: "Sequences", icon: Layers },
    { value: "options" as const,   label: "Options",   icon: Gauge },
    { value: "discussion" as const, label: "Discussion", icon: MessageSquare, count: comments.length },
  ];

  // Computed for sequences tab (follow-up steps only)
  const seqFollowUpSteps = sequenceFollowUpSteps(campaignSteps);
  const activeSeqStep =
    seqFollowUpSteps.find((s) => s.step_order === selectedSequenceStep) ??
    seqFollowUpSteps[0] ??
    null;

  // ── Sequences tab: the leads in the selected follow-up step ────────────────
  //
  // Sorted soonest-first, because the whole point of the list is "what goes out
  // next". A lead already sent is ordered newest-first instead: looking back,
  // the most recent is the one worth seeing.
  const seqStepOrder = activeSeqStep?.step_order ?? 2;

  const seqLeadRows = campaignLeads
    .map((cl) => {
      // A lead who answered, or whose address bounced, is OUT of the sequence —
      // Instantly stopped it and will never send them another step. They still
      // appear (hiding them makes a 100-lead campaign look like 86 and invites
      // "where did the rest go?"), but they must not be counted as work
      // outstanding. The client read "86 sent, 14 remaining" and reasonably
      // concluded 14 emails were stuck, when those 14 were finished.
      const finished: "replied" | "bounced" | null =
        cl.crm_status === "replied" ? "replied"
        : cl.crm_status === "failed" ? "bounced"
        : null;
      // Read from all_drafts, not email_drafts: the latter has been flattened to
      // the opening email by loadData and would never contain a follow-up.
      const draft = (cl.all_drafts ?? []).find((d) => d.step_number === seqStepOrder) ?? null;
      const sent = hasReceivedFollowupStep(cl, seqStepOrder);
      const due = hasUpcomingFollowupStep(cl, seqStepOrder, campaignSteps);
      // Lead-LEVEL facts only. A single AI/Template badge on the row would be
      // wrong half the time: one lead can have follow-up 1 written by the model
      // and follow-up 3 fall back to the template. Those badges belong on the
      // cards, where they are true of exactly one email. What IS true of the
      // lead is how far through the sequence they got, and whether any template
      // has actually reached them.
      const followupSteps = campaignSteps.filter((st) => st.step_order > 1);
      const sentCount = followupSteps.filter((st) => hasReceivedFollowupStep(cl, st.step_order)).length;
      const anyTemplateSent = followupSteps.some((st) =>
        hasReceivedFollowupStep(cl, st.step_order)
        && (cl.all_drafts ?? []).find((d) => d.step_number === st.step_order)?.source === "template",
      );

      return {
        cl, draft, finished,
        // Nothing is due or outstanding for a lead whose sequence has ended.
        sent, due: due && !finished,
        written: !!draft?.body,
        isTemplate: draft?.source === "template",
        sentCount, totalSteps: followupSteps.length, anyTemplateSent,
      };
    })
    .filter((r) => {
      if (seqLeadFilter === "sent") return r.sent;
      if (seqLeadFilter === "due") return r.due && !r.sent;
      // "Not written" means work still to do, so a finished lead is not one:
      // nobody will ever write a follow-up for someone who already replied.
      if (seqLeadFilter === "unwritten") return !r.written && !r.sent && !r.finished;
      return true;
    })
    .filter((r) => {
      const q = seqLeadSearch.trim().toLowerCase();
      if (!q) return true;
      const lead = r.cl.leads;
      return `${lead?.first_name ?? ""} ${lead?.last_name ?? ""} ${lead?.company_name ?? ""}`
        .toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (seqLeadFilter === "sent") {
        return (b.draft?.created_at ?? "").localeCompare(a.draft?.created_at ?? "");
      }
      return (a.cl.first_sent_at ?? "￿").localeCompare(b.cl.first_sent_at ?? "￿");
    });

  // Counts describe WORK, so a lead whose sequence has ended is excluded from
  // every bucket except `all` and its own `finished` tally. Counting them made
  // the tab report outstanding work that did not exist.
  const seqFinished = campaignLeads.filter(
    (cl) => cl.crm_status === "replied" || cl.crm_status === "failed",
  );
  const seqLive = campaignLeads.filter(
    (cl) => cl.crm_status !== "replied" && cl.crm_status !== "failed",
  );
  const seqCounts = {
    due: seqLive.filter((cl) =>
      hasUpcomingFollowupStep(cl, seqStepOrder, campaignSteps)
      && !hasReceivedFollowupStep(cl, seqStepOrder)).length,
    sent: campaignLeads.filter((cl) => hasReceivedFollowupStep(cl, seqStepOrder)).length,
    unwritten: seqLive.filter((cl) =>
      !(cl.all_drafts ?? []).find((d) => d.step_number === seqStepOrder)?.body
      && !hasReceivedFollowupStep(cl, seqStepOrder)).length,
    finished: seqFinished.length,
    replied: campaignLeads.filter((cl) => cl.crm_status === "replied").length,
    bounced: campaignLeads.filter((cl) => cl.crm_status === "failed").length,
    all: campaignLeads.length,
  };

  /** How this step's follow-ups were written — the accountability number. The
   *  client bought "a personalised email per company"; without this they cannot
   *  tell how many they actually got, and a silent template looks identical to
   *  a real one. */
  const seqQuality = (() => {
    let ai = 0, template = 0;
    const reasons = new Map<string, number>();
    for (const cl of seqLive) {
      const d = (cl.all_drafts ?? []).find((x) => x.step_number === seqStepOrder);
      if (!d?.body) continue;
      if (d.source === "template") {
        template++;
        const why = d.fallback_reason ?? "Reason not recorded";
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
      } else ai++;
    }
    return { ai, template, reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]) };
  })();

  const seqActiveLeadRow =
    seqLeadRows.find((r) => r.cl.id === seqLeadId) ?? seqLeadRows[0] ?? null;

  /**
   * Every follow-up for the selected lead, one row per step.
   *
   * The tab used to answer "who is getting step 3?", which meant checking on one
   * person took a visit to every step in turn. The question people actually
   * have is "what is this lead getting?" — so the lead is the subject and the
   * steps are the list, matching how Outbox already works.
   */
  /** The day each edited step lands on. Delays stack, so the number typed in is
   *  not the day it sends — showing the running total is what keeps the two
   *  from being confused (it is what put the client's follow-up 2 on day 21). */
  const seqStepEditDays = cumulativeDays(seqStepEdits);

  // Seed the editor from the campaign's real steps. Keyed on the delays
  // themselves rather than a load flag, so a save elsewhere (Options) shows up
  // here too, while typing in this pane does not re-seed and wipe the edit.
  const seqStepSignature = campaignSteps.map((s) => `${s.step_order}:${s.delay}`).join(",");
  useEffect(() => {
    const waits = extractFollowupWaitsFromSteps(campaignSteps);
    const followUps = campaignSteps.filter((st) => st.step_order > 1);
    setSeqStepEdits(waits.map((w, i) => ({ ...w, ai_instruction: followUps[i]?.ai_instruction ?? null })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature stands in for the array
  }, [seqStepSignature]);

  /** How far ahead of its due date a follow-up is written. Mirrors
   *  FOLLOWUP_LEAD_TIME_DAYS in lib/services/followup-schedule.ts — the writer
   *  is the authority, this only reports what it will do. */
  const FOLLOWUP_LEAD_TIME_DAYS = 1;

  const seqLeadTimeline = (() => {
    const cl = seqActiveLeadRow?.cl;
    if (!cl) return [];
    return campaignSteps
      .filter((st) => st.step_order > 1)
      .map((st) => {
        const draft = (cl.all_drafts ?? []).find((d) => d.step_number === st.step_order) ?? null;
        const sent = hasReceivedFollowupStep(cl, st.step_order);
        // Cumulative, because a step's delay is the wait AFTER it — the same
        // arithmetic the writer and Instantly both use.
        const daysFromOpening = campaignSteps
          .filter((p) => p.step_order < st.step_order)
          .reduce((sum, p) => sum + (p.delay ?? 0), 0);
        const dueAt = cl.first_sent_at
          ? new Date(new Date(cl.first_sent_at).getTime() + daysFromOpening * 864e5)
          : null;
        // When the writer will reach this one. Due date minus the lead time it
        // already works to — shown as a real date because "you can still change
        // this" is only useful if it says until when.
        const writesAt = dueAt ? new Date(dueAt.getTime() - FOLLOWUP_LEAD_TIME_DAYS * 864e5) : null;
        return {
          step: st, draft, sent, dueAt, writesAt, daysFromOpening,
          written: !!draft?.body && !isInstantlyPlaceholder(draft.body),
          isTemplate: draft?.source === "template",
        };
      });
  })();

  /** Same reasoning as versionsSpanOneDay: a row of identical date chips is
   *  useless, so show the clock time while history sits inside one day. */
  const seqVersionsSpanOneDay =
    seqVersions.length > 0 &&
    new Set(seqVersions.map((v) => new Date(v.created_at).toDateString())).size === 1;

  // Switching lead or step must not carry the previous lead's history across —
  // otherwise the panel shows one person's old drafts under another person's
  // name, and "Restore" would write them onto the wrong lead. Keyed on the two
  // pieces of state a user can change rather than on the derived row, so it
  // fires once per switch instead of on every recompute.
  useEffect(() => {
    setSeqHistoryOpen(null);
    setSeqVersions([]);
    setSeqPreviewVersion(null);
  }, [seqLeadId, seqStepOrder]);


  // Status badge info for analytics tab
  const statusBadge = (() => {
    switch (campaign.status) {
      case "Live":      return { label: "Active",    cls: "bg-green-500/15 text-green-500 border-green-500/30" };
      case "Paused":    return { label: "Paused",    cls: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30" };
      case "Scheduled": return { label: "Scheduled", cls: "bg-blue-500/15 text-blue-500 border-blue-500/30" };
      default:          return { label: "Draft",     cls: "bg-muted text-muted-foreground border-border" };
    }
  })();

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 bg-background border-b border-border flex items-center justify-between gap-4 px-6 h-14">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            className="size-8 text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowLeft className="size-4" />
          </Button>
          {editingName ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <Input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveName();
                  if (e.key === "Escape") { setEditingName(false); setNameDraft(campaignName); }
                }}
                className="h-7 w-56 bg-background text-sm font-semibold"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={savingName}
                onClick={() => void handleSaveName()}
                aria-label="Save campaign name"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {savingName ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={savingName}
                onClick={() => { setEditingName(false); setNameDraft(campaignName); }}
                aria-label="Cancel"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0 group/name">
              <h1 className="font-display text-sm font-semibold text-foreground truncate min-w-0">{campaignName}</h1>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => { setNameDraft(campaignName); setEditingName(true); }}
                aria-label="Edit campaign name"
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </Button>
            </div>
          )}
        </div>

        {viewTab === "outbox" && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {campaignRegenerableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={bulkRegenOpening || regenJobActive}
                title={regenJobActive
                  ? "A regeneration is already running for this campaign"
                  : "Regenerate every un-certified draft in this campaign"}
                onClick={() => void openBulkRegenerate()}
              >
                {bulkRegenOpening
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <RotateCcw className="size-3.5" />}
                Regenerate all ({campaignRegenerableCount})
              </Button>
            )}
            {draftReadyLeads.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={certifying || regenJobActive}
                title={regenJobActive ? "A regeneration is running — certifying is paused until it finishes" : undefined}
                onClick={handleCertifyAll}
              >
                {certifying ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                Certify all ({draftReadyLeads.length})
              </Button>
            )}
            <Button
              size="sm"
              disabled={primaryBusy || certifying || sending || primaryAction.mode === "none"}
              onClick={() => void handlePrimaryAction()}
            >
              {primaryBusy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
              {primaryLabel}
            </Button>
          </div>
        )}
      </div>

      {/* Drafts stalling on a dead API key is felt HERE first — an employee
          watching their own campaign sit at "No draft" is the person most
          likely to notice and the least able to explain it. The banner renders
          nothing when healthy, so empty:hidden collapses the spacing away. */}
      <div className="shrink-0 px-6 pt-4 empty:hidden">
        <ServiceHealthBanner />
      </div>

      {/* ── Section tabs — horizontal, directly under the campaign name ── */}
      <div className="shrink-0 border-b border-border px-6 pt-5 pb-3">
        <SegmentedTabs
          value={viewTab}
          onValueChange={setViewTab}
          size="lg"
          options={campaignTabs}
        />
      </div>

      {/* ── Section content ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

      {/* ── Analytics ─────────────────────────────────────────────────────── */}
      {viewTab === "analytics" && (
        <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
          {progress && progress.failed > 0 && (
            <div className="px-6 pt-3 pb-2 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 border-red-500/30 text-red-400 hover:text-red-300"
                disabled={retryingAll}
                onClick={() => void handleRetryAllFailed()}
              >
                {retryingAll ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                Retry ({progress.failed})
              </Button>
            </div>
          )}

          {
            /* ── Analytics view ── */
            <div className="px-6 pb-4 flex flex-col gap-3 flex-1 min-h-0">
              {/* Stat cards */}
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                {[
                  { label: "Leads",      value: analyticsTotalLeads, icon: Users,          accent: "" },
                  // Sent (delivered total) splits into exactly one of No reply
                  // yet / Replied / Bounced — those three always sum back to
                  // Sent, so nothing is double-counted or hidden inside another
                  // tile the way the old "Sent = delivered minus everything
                  // else" framing did.
                  { label: "Sent",         value: analyticsDelivered, icon: Send,          accent: "", sub: "reached an inbox" },
                  { label: "No reply yet", value: analyticsSent,      icon: Clock,          accent: "", sub: "delivered, nothing back yet" },
                  { label: "Replied",      value: analyticsReplied,   icon: MessageSquare, accent: "", sub: `${analyticsReplyRate}% reply rate` },
                  { label: "Bounced",      value: analyticsBounced,   icon: AlertTriangle, accent: "red" },
                  { label: "Certified",  value: report?.totals.certified ?? 0, icon: CheckCircle2, accent: "", sub: report ? `${report.rates.certifyRate}% of drafts` : undefined },
                  { label: "Hot",        value: analyticsHot,        icon: Flame,          accent: "red" },
                  { label: "Cold",       value: analyticsCold,       icon: Snowflake,      accent: "sky" },
                ].map(({ label, value, icon: Icon, accent, sub }) => (
                  <StatTile
                    key={label}
                    label={label}
                    value={value}
                    icon={Icon}
                    sub={sub}
                    tone={accent === "red" ? "red" : accent === "sky" ? "sky" : "neutral"}
                  />
                ))}
              </div>

              {/* Chart grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {/* Pipeline donut + legend */}
                <div className="swatch-bar-top rounded-xl border border-border bg-field dark:bg-card p-4">
                  <p className="eyebrow mb-2">Pipeline</p>
                  <div className="flex items-center gap-3">
                    <ResponsiveContainer width="45%" height={140}>
                      <PieChart>
                        <Pie data={pipelineData} cx="50%" cy="50%" innerRadius={36} outerRadius={58} paddingAngle={2} dataKey="value" stroke="none">
                          {pipelineData.map((s, i) => <Cell key={i} fill={s.fill} fillOpacity={s.opacity} />)}
                        </Pie>
                        <Tooltip
                          content={({ active, payload }) =>
                            active && payload?.length ? (
                              <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                                <span className="font-semibold">{payload[0].name}: </span>
                                <span>{payload[0].value}</span>
                              </div>
                            ) : null
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex-1 space-y-1.5 min-w-0">
                      {pipelineData.map((s) => (
                        <div key={s.name} className="flex items-center justify-between text-xs gap-2">
                          <span className="flex items-center gap-1.5 text-muted-foreground truncate">
                            <span className="size-2 rounded-full shrink-0" style={{ background: s.fill, opacity: s.opacity }} />
                            <span className="truncate">{s.name}</span>
                          </span>
                          <span className="font-mono font-semibold tabular-nums shrink-0">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Draft funnel bar chart */}
                <div className="swatch-bar-top rounded-xl border border-border bg-field dark:bg-card p-4">
                  <p className="eyebrow mb-2">Draft funnel</p>
                  {report ? (
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={funnelData} margin={{ top: 8, right: 4, left: -28, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip
                          content={({ active, payload, label }) =>
                            active && payload?.length ? (
                              <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                                <span className="font-semibold">{label}: </span>
                                <span>{payload[0].value}</span>
                              </div>
                            ) : null
                          }
                        />
                        <Bar dataKey="v" radius={[3, 3, 0, 0]}>
                          {funnelData.map((d, i) => <Cell key={i} fill={d.fill} fillOpacity={d.opacity} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-[140px] flex items-center justify-center">
                      {reportLoading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : (
                        <p className="text-xs text-muted-foreground">No data yet</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Lead temperature donut + legend */}
                <div className="swatch-bar-top rounded-xl border border-border bg-field dark:bg-card p-4">
                  <p className="eyebrow mb-2">Lead temperature</p>
                  <div className="flex items-center gap-3">
                    <ResponsiveContainer width="45%" height={140}>
                      <PieChart>
                        <Pie data={tempData} cx="50%" cy="50%" innerRadius={36} outerRadius={58} paddingAngle={2} dataKey="value" stroke="none">
                          {tempData.map((s, i) => <Cell key={i} fill={s.fill} fillOpacity={s.opacity} />)}
                        </Pie>
                        <Tooltip
                          content={({ active, payload }) =>
                            active && payload?.length ? (
                              <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                                <span className="font-semibold">{payload[0].name}: </span>
                                <span>{payload[0].value}</span>
                              </div>
                            ) : null
                          }
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex-1 space-y-1.5 min-w-0">
                      {tempData.map((s) => (
                        <div key={s.name} className="flex items-center justify-between text-xs gap-2">
                          <span className="flex items-center gap-1.5 text-muted-foreground truncate">
                            <span className="size-2 rounded-full shrink-0" style={{ background: s.fill, opacity: s.opacity }} />
                            <span className="truncate">{s.name}</span>
                          </span>
                          <span className="font-mono font-semibold tabular-nums shrink-0">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Follow-up summary tiles — cheap aggregates over the same data
                  the step-performance panel below already computes. No due
                  DATES are tracked anywhere in this app (only which step was
                  last confirmed), so these are honestly "how many still have
                  more sequence ahead of them", not "how many are due today". */}
              {stepDeliveryPct.length > 1 && (
                <div className="grid grid-cols-3 gap-3">
                  <StatTile label="Follow-ups sent" value={followupsSentTotal} icon={Send} sub="at least one, all-time" />
                  <StatTile label="Follow-ups pending" value={followupsDueTotal} icon={Clock} tone={followupsDueTotal > 0 ? "amber" : "neutral"} sub="still have more steps queued" />
                  <StatTile label="Stopped" value={followupsStoppedTotal} icon={AlertTriangle} sub="replied or bounced — sequence ends" />
                </div>
              )}

              {/* Sequence step performance + Replied vs Sent */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {stepDeliveryPct.length > 0 && (
                  <div className="rounded-xl border border-border bg-field dark:bg-card p-4 lg:col-span-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Sequence step performance</p>
                      <InfoTip
                        side="right"
                        text="Each row is one email in this campaign's sequence — Opening email is the initial outreach, Follow-up 1 is the first follow-up, and so on. Sent = actually delivered, confirmed by Instantly's own send webhook (not just handed to Instantly's queue). A bounce still counts as sent — the mail left, the mailbox rejected it — so the red marker sits inside the sent portion, showing how many of that step's sends bounced."
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3">% of leads actually delivered each email in the sequence</p>
                    <div className="space-y-3">
                      {stepDeliveryPct.map((s) => (
                        <div key={s.name}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-medium">{s.name}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {s.sent}/{s.total} sent · {s.pct}%
                              {s.bounced > 0 && <span className="ml-1.5 text-destructive">· {s.bounced} bounced</span>}
                            </span>
                          </div>
                          <div className="h-2.5 rounded-full bg-muted overflow-hidden relative">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${s.pct}%`, background: "var(--primary)" }}
                            />
                            {s.bounced > 0 && s.total > 0 && (
                              <div
                                className="absolute top-0 h-full w-[2px] bg-destructive"
                                style={{ left: `${Math.max(0, (s.sent - s.bounced) / s.total * 100)}%` }}
                                title={`${s.bounced} bounced at this step`}
                              />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Replied vs Sent */}
                <div className="rounded-xl border border-border bg-field dark:bg-card p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">Replied vs. delivered</p>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    {analyticsReplyRate}% of delivered emails on this campaign got a reply
                  </p>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart
                      data={[
                        { name: "Delivered", v: analyticsDelivered, fill: "var(--primary)", opacity: 1 },
                        { name: "Replied",   v: analyticsReplied,   fill: "#22c55e",        opacity: 1 },
                      ]}
                      margin={{ top: 8, right: 4, left: -28, bottom: 0 }}
                    >
                      <XAxis dataKey="name" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip
                        content={({ active, payload, label }) =>
                          active && payload?.length ? (
                            <div className="rounded border border-border bg-card px-2 py-1 text-xs shadow-lg">
                              <span className="font-semibold">{label}: </span>
                              <span>{payload[0].value}</span>
                            </div>
                          ) : null
                        }
                      />
                      <Bar dataKey="v" radius={[3, 3, 0, 0]}>
                        {[
                          { fill: "var(--primary)", opacity: 1 },
                          { fill: "#22c55e",         opacity: 1 },
                        ].map((d, i) => <Cell key={i} fill={d.fill} fillOpacity={d.opacity} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          }
        </div>
      )}

      {/* ── Leads ─────────────────────────────────────────────────────────── */}
      {viewTab === "leads" && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Header row */}
          <div className="px-6 py-3 border-b border-border shrink-0 flex items-center gap-3 flex-wrap">
            {/* Search */}
            <SearchInput
              value={leadsSearch}
              onChange={setLeadsSearch}
              placeholder="Search leads…"
              size="sm"
              wrapperClassName="flex-1 min-w-36 max-w-xs"
            />

            {/* Delivery filter — dropdown right next to search, matching the
                Leads table pattern. "Not queued" and "Send failed" are left
                out of the picker entirely (not meaningful filters day-to-day);
                the remaining buckets only show up once they're non-empty. */}
            <Select value={leadsDelivery} onValueChange={(v) => setLeadsDelivery(v as DeliveryBucket | "all" | "followup" | "followup_sent")}>
              <SelectTrigger className="h-8 w-36 gap-2 rounded-md px-3 text-xs shadow-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-36">
                <SelectItem value="all">All ({campaignLeads.length})</SelectItem>
                {(["sending", "sent", "replied", "bounced"] as const)
                  .filter((b) => (deliveryCounts[b] ?? 0) > 0)
                  .map((b) => (
                    <SelectItem key={b} value={b}>
                      {/* Sitting right next to "Follow-up sent" invites reading
                          this as the delivered total, but deliveryBucket's
                          "sent" excludes anyone who has since replied or
                          bounced — same distinction the Analytics tab makes
                          with "No reply yet" vs "Sent". Only overridden here;
                          DELIVERY_BUCKET_LABELS.sent stays "Sent" for the
                          per-lead badge, where it reads fine standing alone. */}
                      {b === "sent" ? "No reply yet" : DELIVERY_BUCKET_LABELS[b]} ({deliveryCounts[b] ?? 0})
                    </SelectItem>
                  ))}
                {/* Per step, so "sent" and "due" say WHICH follow-up. Empty
                    buckets are hidden, same rule the delivery buckets follow. */}
                {followupStepCounts.map((f) => (
                  <Fragment key={f.stepOrder}>
                    {f.sent > 0 && (
                      <SelectItem value={`followup_sent_${f.stepOrder}`}>
                        {f.label} sent ({f.sent})
                      </SelectItem>
                    )}
                    {f.due > 0 && (
                      <SelectItem value={`followup_${f.stepOrder}`}>
                        {f.label} due ({f.due})
                      </SelectItem>
                    )}
                  </Fragment>
                ))}
              </SelectContent>
            </Select>

            {/* Sort pills */}
            <SegmentedTabs
              size="sm"
              value={leadsSort}
              onValueChange={setLeadsSort}
              options={[
                { value: "az", label: "A–Z" },
                { value: "newest", label: "Newest" },
              ]}
            />

            {/* List/Kanban toggle */}
            <SegmentedTabs
              size="sm"
              className="ml-auto"
              value={leadsViewMode}
              onValueChange={setLeadsViewMode}
              options={[
                { value: "list", label: "List", icon: List },
                { value: "kanban", label: "Kanban", icon: LayoutGrid },
              ]}
            />
          </div>

          {leadsViewMode === "kanban" ? (
            /* ── Kanban view ── */
            <div className="flex flex-col flex-1 min-h-0 bg-card/30">
              <CampaignKanban
                leads={filteredLeads}
                selectedId={selectedId}
                onSelect={handleKanbanSelect}
                onRetry={handleRetryOne}
                retryingId={retryingId}
              />
              {error && <p className="text-sm text-destructive px-4 pb-3">{error}</p>}
            </div>
          ) : (
          /* Table */
          <div className="flex-1 min-h-0 overflow-y-auto bg-secondary/20 px-6 py-4">
              {loading ? (
                <div className="rounded-xl border border-border bg-field dark:bg-card shadow-sm overflow-hidden animate-pulse">
                  <div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-secondary/30">
                    <div className="size-4 rounded bg-secondary" />
                    <div className="h-3 w-24 bg-secondary rounded" />
                    <div className="h-3 w-32 bg-secondary rounded" />
                    <div className="h-3 w-20 bg-secondary rounded ml-auto" />
                  </div>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4 px-4 py-3.5 border-b border-border last:border-0">
                      <div className="size-4 rounded bg-secondary" />
                      <div className="size-8 rounded-full bg-secondary" />
                      <div className="h-3.5 w-28 bg-secondary rounded" />
                      <div className="h-3 w-36 bg-secondary/60 rounded" />
                      <div className="h-5 w-16 bg-secondary rounded-full ml-auto" />
                    </div>
                  ))}
                </div>
              ) : filteredLeads.length === 0 ? (
                <EmptyState message={leadsSearch ? "No leads match your search." : "No leads yet."} />
              ) : (
                <div className="block w-full rounded-xl border border-border bg-field dark:bg-card shadow-sm overflow-x-auto overflow-y-hidden">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-secondary/60 backdrop-blur-sm">
                    <tr className="border-b border-border">
                      <th className="w-8 px-6 py-2.5 text-left eyebrow border-r border-border">#</th>
                      <th className="px-6 py-2.5 text-left eyebrow border-r border-border">Name</th>
                      <th className="px-6 py-2.5 text-left eyebrow border-r border-border">Email</th>
                      <th className="px-6 py-2.5 text-left eyebrow border-r border-border">Job Title</th>
                      <th className="px-6 py-2.5 text-left eyebrow border-r border-border">Status</th>
                      <th className="px-6 py-2.5 text-left eyebrow">Company</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredLeads.map((cl, index) => {
                      const lead = cl.leads;
                      const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unknown";
                      return (
                        <tr
                          key={cl.id}
                          onClick={() => handleOpenInOutbox(cl.id)}
                          className="group cursor-pointer transition-colors hover:bg-secondary/40"
                        >
                          <td className="w-8 px-6 py-3 font-mono text-xs text-muted-foreground tabular-nums border-r border-border">{index + 1}</td>
                          <td className="px-6 py-3 border-r border-border">
                            <div className="flex items-center gap-2">
                              <Avatar name={name} size="sm" />
                              <span className="font-medium truncate max-w-[140px]">{name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-3 font-mono text-xs text-muted-foreground border-r border-border">
                            <span className="whitespace-nowrap">{lead?.email}</span>
                          </td>
                          <td className="px-6 py-3 text-xs text-muted-foreground border-r border-border">
                            <span className="truncate block max-w-[120px]">{lead?.title}</span>
                          </td>
                          <td className="px-6 py-3 border-r border-border">
                            <div className="flex flex-wrap gap-1">
                              {(() => {
                                const activity = getDraftActivity(cl);
                                const ds = cl.email_drafts?.status;
                                const pills: { label: string; cls: string }[] = [];

                                // Draft pill — an in-flight generation/regeneration
                                // outranks the stored status, which is still the
                                // superseded version until the new one lands.
                                if (activity) {
                                  pills.push({ label: `${DRAFT_ACTIVITY_LABEL[activity]}…`, cls: "bg-blue-500/15 text-blue-500 border border-blue-500/30" });
                                } else if (ds === "draft") {
                                  pills.push({ label: "Draft", cls: "bg-amber-500/15 text-amber-600 border border-amber-500/30" });
                                } else if (ds === "generating") {
                                  pills.push({ label: "Generating…", cls: "bg-blue-500/15 text-blue-500 border border-blue-500/30" });
                                } else if (ds === "failed") {
                                  pills.push({ label: "Failed", cls: "bg-red-500/15 text-red-500 border border-red-500/30" });
                                } else if (ds === "approved") {
                                  pills.push({ label: "Certified", cls: "bg-primary/15 text-primary border border-primary/30" });
                                }

                                // Delivery pill — exactly one, straight off the shared
                                // bucket so this and the filter chips can never disagree.
                                // 'not_queued' has no pill of its own: the draft pill
                                // above already says where such a lead stands.
                                const delivery = deliveryBucket(cl);
                                if (delivery !== "not_queued") {
                                  pills.push({ label: deliveryLabel(cl), cls: DELIVERY_PILL_CLS[delivery] });
                                }

                                // Fallback if nothing matched
                                if (pills.length === 0) {
                                  pills.push({ label: "Pending", cls: "bg-muted text-muted-foreground border border-border" });
                                }

                                return pills.map(({ label, cls }) => (
                                  <span key={label} className={cn("inline-flex items-center px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap", cls)}>
                                    {label}
                                  </span>
                                ));
                              })()}
                              {/* Where this contact came from — otherwise a
                                  person nobody imported just appears inside a
                                  running campaign. */}
                              {cl.leads?.replaces_lead_id && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); openOriginalOf(cl); }}
                                  title={`${replacesTooltip(cl)} — open them`}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-secondary border border-border font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                                >
                                  <CornerDownRight className="size-3" />
                                  Replacement
                                </button>
                              )}
                              {/* The only action a bounce allows: try another
                                  address at the same company — until someone
                                  has, at which point it reads as handled so the
                                  next person doesn't do it twice. */}
                              {deliveryBucket(cl) === "bounced" && (
                                cl.replaced_by_lead_id ? (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); openReplacementOf(cl); }}
                                    title={`${replacedTooltip(cl)} — open them`}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-500/15 border border-green-500/30 font-mono text-[10px] font-semibold uppercase tracking-wide text-green-600 transition-colors hover:bg-green-500/25"
                                  >
                                    <Check className="size-3" />
                                    Replaced
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); openReplace(cl); }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-border bg-field font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                                    title="Add another contact at this company"
                                  >
                                    <UserPlus className="size-3" />
                                    Replace
                                  </button>
                                )
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-3 text-xs text-muted-foreground">
                            <span className="truncate block max-w-[120px]">{lead?.company_name}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
          </div>
          )}
        </div>
      )}

      {/* ── Outbox ────────────────────────────────────────────────────────── */}
      {viewTab === "outbox" && (
        <div className="flex flex-1 min-h-0">
          {/* Left: unified lead list */}
          <div className="w-[266px] h-full shrink-0 border-r border-border flex flex-col">
            {/* Header */}
            <div className="border-b border-border shrink-0">
              <div className="px-3 pt-2 flex items-center gap-1.5">
                <Select value={outboxFilter} onValueChange={(v) => setOutboxFilter(v as typeof outboxFilter)}>
                  <SelectTrigger className="h-7 flex-1 min-w-0 gap-1.5 rounded-md border-border px-2 py-0 text-[11px] font-medium text-foreground [&>svg]:size-3 [&>svg]:opacity-70">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OUTBOX_FILTERS.map(({ id, label }) => (
                      <SelectItem key={id} value={id} className="text-[11px]">
                        {label} ({outboxFilterCounts[id]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={leadsSort} onValueChange={(v) => setLeadsSort(v as CampaignLeadsSort)}>
                  <SelectTrigger className="h-7 w-auto shrink-0 gap-1.5 rounded-md border-border px-2 py-0 text-[11px] font-medium text-foreground [&>svg]:size-3 [&>svg]:opacity-70">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="az" className="text-[11px]">A–Z</SelectItem>
                    <SelectItem value="newest" className="text-[11px]">Newest</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  disabled={syncingReplies}
                  title="Sync replies"
                  onClick={() => void runSyncReplies()}
                  className="size-7 shrink-0 bg-field hover:bg-field text-muted-foreground hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", syncingReplies && "animate-spin")} />
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="icon"
                  title="Open in Unibox"
                  className="size-7 shrink-0 bg-field hover:bg-field text-muted-foreground hover:text-primary"
                >
                  <a href={`/unibox?campaign_id=${campaign.id}`}>
                    <ExternalLink className="size-3" />
                  </a>
                </Button>
              </div>
              {/* Wraps rather than collides: this panel is ~265px wide, and the
                  label plus the action buttons do not fit on one line. Both
                  groups are shrink-0 so the actions wrap to their own row
                  instead of squeezing "Deselect all" and the selected count
                  down to clipped stubs. */}
              <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
                <div className="flex items-center gap-2 shrink-0">
                  {outboxSelectableFilteredLeads.length > 0 && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => {
                        const selectableLeads = outboxSelectableFilteredLeads;
                        const ids = selectableLeads.map((cl) => cl.id);
                        const allSelected = selectableLeads.every((cl) => checkedIds.has(cl.id));
                        if (allSelected) {
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            for (const id of ids) next.delete(id);
                            return next;
                          });
                        } else {
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            for (const id of ids) next.add(id);
                            return next;
                          });
                        }
                      }}
                      className="h-auto p-0 text-[11px] text-muted-foreground hover:text-primary shrink-0"
                    >
                      {outboxSelectableFilteredLeads.every((cl) => checkedIds.has(cl.id))
                        ? "Deselect all"
                        : `Select all (${outboxSelectableFilteredLeads.length})`}
                    </Button>
                  )}
                  {outboxCheckedCount > 0 && (
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {outboxCheckedCount} selected
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Selection-scoped only. "Regenerate all" lives in the header,
                      so with nothing ticked this button stays out of the way
                      instead of showing the same count twice. */}
                  {outboxCheckedRegenIds.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                      disabled={bulkRegenOpening || regenJobActive}
                      title={regenJobActive
                        ? "A regeneration is already running for this campaign"
                        : "Regenerate the selected drafts"}
                      onClick={() => void openBulkRegenerate(outboxCheckedRegenIds)}
                    >
                      {bulkRegenOpening
                        ? <Loader2 className="size-3 animate-spin" />
                        : <RotateCcw className="size-3" />}
                      Regenerate ({outboxCheckedRegenIds.length})
                    </Button>
                  )}
                  {outboxCertifyDraftIds.length > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      disabled={certifying || regenJobActive}
                      title={regenJobActive ? "A regeneration is running — certifying is paused until it finishes" : undefined}
                      onClick={() => void handleBulkCertify(outboxCertifyDraftIds)}
                    >
                      {certifying ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
                      Certify ({outboxCertifyDraftIds.length})
                    </Button>
                  )}
                </div>
              </div>
              {regenJobActive && regenJob && (
                <div className="px-3 pb-2.5 pt-0.5 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="eyebrow truncate">Regenerating drafts</p>
                    <p className="font-mono tabular-nums text-[11px] text-muted-foreground shrink-0">
                      {regenJob.processed} / {regenJob.total}
                    </p>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${regenJob.total > 0 ? Math.round((regenJob.processed / regenJob.total) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground truncate">
                      {regenJob.failed > 0 && (
                        <span className="text-destructive">{regenJob.failed} failed · </span>
                      )}
                      Safe to close this window.
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={cancellingJob}
                      onClick={() => void handleCancelRegenJob()}
                      className="h-6 shrink-0 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                    >
                      {cancellingJob ? <Loader2 className="size-3 animate-spin" /> : "Cancel"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto space-y-1.5 p-2">
              {outboxFilteredLeads.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">
                  {campaignLeads.length === 0 ? "No leads yet." : "No leads match this filter."}
                </p>
              ) : outboxFilteredLeads.map((cl) => {
                const lead = cl.leads;
                const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unknown";
                const isActive = selectedId === cl.id;
                const isChecked = checkedIds.has(cl.id);
                const thread = outboxThreadByLeadId.get(cl.id) ?? null;

                if (thread) {
                  const latestMsg = thread.messages[thread.messages.length - 1];
                  const replyDraftStatus = latestMsg?.reply_drafts[latestMsg.reply_drafts.length - 1]?.status;
                  const statusConfig: Record<string, { label: string; cls: string }> = {
                    generating: { label: "Generating", cls: "bg-yellow-500/15 text-yellow-500 border-yellow-500/25" },
                    draft:      { label: "Draft",       cls: "bg-primary/15 text-primary border-primary/25" },
                    approved:   { label: "Certified",   cls: "bg-green-500/15 text-green-500 border-green-500/25" },
                    sent:       { label: "Sent",        cls: "bg-muted text-muted-foreground border-border" },
                    failed:     { label: "Failed",      cls: "bg-destructive/15 text-destructive border-destructive/25" },
                  };
                  const sc = replyDraftStatus ? statusConfig[replyDraftStatus] : null;
                  return (
                    <Button
                      key={cl.id}
                      type="button"
                      variant="ghost"
                      onClick={() => setSelectedId(cl.id)}
                      className={cn(
                        "h-auto w-full block justify-start text-left font-normal rounded-lg border px-3 py-2.5",
                        isActive ? "border-primary bg-primary/8 hover:bg-primary/8" : "border-border bg-field hover:bg-field hover:border-muted-foreground/40",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Avatar name={name} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-xs font-medium truncate", isActive ? "text-primary" : "text-foreground")}>{name}</p>
                          <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                            <span className="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-blue-500/15 text-blue-600 border-blue-500/25">
                              Reply received
                            </span>
                            {sc && (
                              <span className={cn("inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold", sc.cls)}>
                                {sc.label}
                              </span>
                            )}
                          </div>
                        </div>
                        {thread.messages.length > 1 && (
                          <span className="text-[10px] text-muted-foreground/70 shrink-0">({thread.messages.length})</span>
                        )}
                      </div>
                    </Button>
                  );
                }

                const activity = getDraftActivity(cl);
                const status = cl.email_drafts?.status ?? "none";
                const delivery = deliveryBucket(cl);
                const inFlightCls = "bg-yellow-500/15 text-yellow-500 border-yellow-500/25";
                const statusConfig: Record<string, { label: string; cls: string }> = {
                  generating: { label: "Generating", cls: inFlightCls },
                  draft:      { label: "Draft",       cls: "bg-primary/15 text-primary border-primary/25" },
                  approved:   { label: "Certified",   cls: "bg-green-500/15 text-green-500 border-green-500/25" },
                  sent:       { label: "Sent",        cls: "bg-muted text-muted-foreground border-border" },
                  failed:     { label: "Failed",      cls: "bg-destructive/15 text-destructive border-destructive/25" },
                  none:       { label: "No draft",    cls: "bg-muted text-muted-foreground border-border" },
                };
                // An in-flight row wins over whatever draft_id still resolves to:
                // during a regeneration that's the superseded ('rejected') version,
                // which has no entry here and would otherwise fall through to
                // "No draft" — exactly the blink this is meant to remove.
                // Once mail has a delivery outcome, prefer that pill (Bounced /
                // Sending / Sent / Replied) over draft status — drafts stay
                // "sent" after a bounce, which hid the red Bounced pill here.
                const sc = activity
                  ? { label: DRAFT_ACTIVITY_LABEL[activity], cls: inFlightCls }
                  : delivery !== "not_queued"
                    ? { label: deliveryLabel(cl), cls: DELIVERY_PILL_CLS[delivery] }
                    : statusConfig[status] ?? statusConfig.none;
                const showCheckbox = status !== "sent" && delivery === "not_queued";
                const canCheck = showCheckbox;
                return (
                  <div
                    key={cl.id}
                    className={cn(
                      "flex items-center cursor-pointer rounded-lg border transition-colors",
                      isActive ? "border-primary bg-primary/10" : "border-border bg-field hover:bg-field hover:border-muted-foreground/40",
                    )}
                    onClick={() => setSelectedId(cl.id)}
                  >
                    {showCheckbox && (
                      <div
                        className="w-9 shrink-0 py-2.5 pl-2.5 flex items-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canCheck) return;
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(cl.id)) next.delete(cl.id); else next.add(cl.id);
                            return next;
                          });
                        }}
                      >
                        <AppCheckbox
                          checked={isChecked && canCheck}
                          disabled={!canCheck}
                        />
                      </div>
                    )}
                    <div className={cn("flex items-center gap-2 flex-1 min-w-0 py-2.5 pr-3", showCheckbox ? "pl-1" : "pl-3")}>
                      <Avatar name={name} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-xs font-medium truncate", isActive ? "text-primary" : "text-foreground")}>{name}</p>
                        <span className={cn("mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold", sc.cls)}>
                          {activity && <Loader2 className="size-2.5 animate-spin" />}
                          {sc.label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: unified thread view */}
          <div className="flex-1 overflow-y-auto bg-secondary/10">
            {!selected ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a lead to view their outbox
              </div>
            ) : (
              <div className="w-full max-w-[1400px] mx-auto p-6 space-y-4">
                {/* Lead + org cards — half width each; click opens Lead / Org drawers */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-field px-4 py-3 shadow-sm transition-colors hover:border-primary/40 hover:bg-field">
                    <button
                      type="button"
                      onClick={() => setDrawerLead(campaignLeadToDrawerLead(selected))}
                      className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title="Open lead details"
                      aria-label="Open lead details"
                    >
                      <Avatar name={[selected.leads?.first_name, selected.leads?.last_name].filter(Boolean).join(" ") || "?"} size="sm" />
                    </button>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setDrawerLead(campaignLeadToDrawerLead(selected))}
                        className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                        title="Open lead details"
                      >
                        <p className="eyebrow text-muted-foreground">Lead</p>
                        <p className="font-display text-sm font-semibold text-foreground truncate">
                          {[selected.leads?.first_name, selected.leads?.last_name].filter(Boolean).join(" ") || "Unknown"}
                        </p>
                      </button>
                      {selected.leads?.email ? (
                        <a
                          href={`mailto:${selected.leads.email}`}
                          className="font-mono text-xs text-blue-500 hover:text-blue-600 hover:underline truncate block max-w-full"
                          title={`Email ${selected.leads.email}`}
                        >
                          {selected.leads.email}
                        </a>
                      ) : (
                        <p className="font-mono text-xs text-muted-foreground truncate">No email</p>
                      )}
                      {selected.leads?.title && (
                        <p className="text-xs text-muted-foreground truncate">{selected.leads.title}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setDrawerLead(campaignLeadToDrawerLead(selected))}
                      className="flex shrink-0 flex-col items-end gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      title="Open lead details"
                    >
                      {(selected.email_drafts || getDraftActivity(selected)) && (
                        <DraftStatusBadge
                          label={getDisplayStatus(selected)}
                          styleClass={getStatusStyle(selected)}
                        />
                      )}
                      {selectedThread && (() => {
                        const temp = selectedThread.latest_temperature ?? "neutral";
                        const badge = TEMP_BADGE[temp] ?? TEMP_BADGE.neutral;
                        return (
                          <span className={cn("font-mono text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md border inline-flex items-center gap-1", badge.cls)}>
                            {badge.icon}{badge.label}
                          </span>
                        );
                      })()}
                    </button>
                    {selected.leads?.replaces_lead_id && (
                      <span
                        title={replacesTooltip(selected)}
                        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary border border-border font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        <UserPlus className="size-3.5" />
                        Replacement
                      </span>
                    )}
                    {/* Sits outside the card's open-lead button so the click
                        opens the replace dialog, not the lead drawer. */}
                    {deliveryBucket(selected) === "bounced" && (
                      selected.replaced_by_lead_id ? (
                        <button
                          type="button"
                          onClick={() => {
                            const r = replacementFor(selected);
                            if (r) handleOpenInOutbox(r.id);
                          }}
                          title={`${replacedTooltip(selected)} — open them`}
                          className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-green-500/15 border border-green-500/30 font-mono text-[10px] font-semibold uppercase tracking-wider text-green-600 transition-colors hover:bg-green-500/25"
                        >
                          <Check className="size-3.5" />
                          Replaced
                        </button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 gap-1.5"
                          onClick={() => openReplace(selected)}
                          title="Add another contact at this company"
                        >
                          <UserPlus className="size-3.5" />
                          Replace
                        </Button>
                      )
                    )}
                  </div>

                  {selected.leads?.org_id ? (
                    (() => {
                      const org = selected.leads!;
                      const websiteRaw = (org.company_website || org.company_domain || "").trim();
                      const websiteHref = websiteRaw
                        ? (/^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`)
                        : null;
                      const websiteLabel = websiteRaw.replace(/^https?:\/\//i, "").replace(/\/$/, "") || null;
                      const location = [org.company_city, org.company_country].filter(Boolean).join(", ");
                      return (
                        <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-field px-4 py-3 shadow-sm transition-colors hover:border-primary/40 hover:bg-field">
                          <button
                            type="button"
                            onClick={() => setDrawerOrgId(org.org_id!)}
                            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title="Open organization details"
                            aria-label="Open organization details"
                          >
                            <Building2 className="size-4" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => setDrawerOrgId(org.org_id!)}
                              className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                              title="Open organization details"
                            >
                              <p className="eyebrow text-muted-foreground">Organization</p>
                              <p className="font-display text-sm font-semibold text-foreground truncate">
                                {org.company_name || "Untitled organization"}
                              </p>
                            </button>
                            {websiteHref && websiteLabel && (
                              <a
                                href={websiteHref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-xs text-blue-500 hover:text-blue-600 hover:underline truncate block max-w-full"
                                title={websiteHref}
                              >
                                {websiteLabel}
                              </a>
                            )}
                            {location ? (
                              <p className="flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                                <MapPin className="size-3 shrink-0" aria-hidden />
                                <span className="truncate">{location}</span>
                              </p>
                            ) : !websiteHref ? (
                              <p className="font-mono text-xs text-muted-foreground truncate">No website</p>
                            ) : null}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div className="flex w-full items-center gap-3 rounded-xl border border-dashed border-border bg-field/60 px-4 py-3 text-left shadow-sm">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground" aria-hidden>
                        <Building2 className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="eyebrow text-muted-foreground">Organization</p>
                        <p className="text-sm text-muted-foreground italic">
                          {selected.leads?.company_name || "No organization linked"}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* A replacement carries its origin wherever it is opened —
                    otherwise a contact nobody imported just appears in a
                    running campaign with no explanation. */}
                {selectedOriginal && (
                  <div className="max-w-2xl mx-auto w-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-foreground/70">
                      Replacement for
                    </span>
                    <button
                      type="button"
                      onClick={() => handleOpenInOutbox(selectedOriginal.id)}
                      className="font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      {[selectedOriginal.leads?.first_name, selectedOriginal.leads?.last_name].filter(Boolean).join(" ") || "the bounced contact"}
                    </button>
                    {selectedOriginal.leads?.email && (
                      <span className="font-mono text-[11px] line-through opacity-70">{selectedOriginal.leads.email}</span>
                    )}
                    <span>
                      bounced{selectedOriginal.bounced_at ? ` ${format(new Date(selectedOriginal.bounced_at), "d MMM")}` : ""}
                    </span>
                  </div>
                )}

                {/* The handoff: what a replaced bounce shows instead of a dead
                    thread. What happened, who covers it now, who decided that. */}
                {isReplacedBounce && !bouncedThreadOpen && (
                  <div className="max-w-2xl mx-auto w-full rounded-xl border border-border bg-card p-6 flex flex-col items-center gap-4 text-center">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-500/15 border border-red-500/30 font-mono text-[10px] font-semibold uppercase tracking-wide text-red-500">
                      Bounced{selected.bounced_at ? ` ${format(new Date(selected.bounced_at), "d MMM yyyy")}` : ""}
                    </span>
                    <div className="space-y-1.5">
                      <p className="font-display text-sm font-semibold text-foreground">This mailbox rejected our email.</p>
                      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                        The message was never read, so there is nothing here to review or send.
                        {" "}Outreach to {selected.leads?.company_name || "this company"} continues with the contact below.
                      </p>
                    </div>

                    {selectedReplacement ? (
                      <button
                        type="button"
                        onClick={() => handleOpenInOutbox(selectedReplacement.id)}
                        className="w-full max-w-sm flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-primary/10"
                      >
                        <Avatar
                          name={[selectedReplacement.leads?.first_name, selectedReplacement.leads?.last_name].filter(Boolean).join(" ") || "?"}
                          size="sm"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-foreground truncate">
                            {[selectedReplacement.leads?.first_name, selectedReplacement.leads?.last_name].filter(Boolean).join(" ") || "Replacement contact"}
                          </span>
                          <span className="block font-mono text-[11px] text-muted-foreground truncate">
                            {selectedReplacement.leads?.email}
                          </span>
                        </span>
                        <ArrowRight className="ml-auto size-4 shrink-0 text-primary" />
                      </button>
                    ) : (
                      // The replacement exists but isn't on this screen — a
                      // co-worker owns it, so an employee can't see it.
                      <p className="text-xs text-muted-foreground">A replacement contact was added at this company.</p>
                    )}
                    {selectedReplacement && (
                      <p className="text-[11px] text-muted-foreground">Opens their email, ready to certify</p>
                    )}

                    <div className="w-full border-t border-border pt-3 text-[11px] text-muted-foreground">
                      {selected.replaced_by_user_name && (
                        <>
                          Added by {selected.replaced_by_user_name}
                          {selected.replaced_at ? ` on ${format(new Date(selected.replaced_at), "d MMM")}` : ""}
                          {" · "}
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setBouncedThreadOpen(true)}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        View the email that bounced
                      </button>
                    </div>
                  </div>
                )}

                {isReplacedBounce && bouncedThreadOpen && (
                  <div className="max-w-2xl mx-auto w-full flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      This email bounced and was never read — kept only as a record.
                    </p>
                    <Button size="sm" variant="ghost" className="shrink-0 text-xs" onClick={() => setBouncedThreadOpen(false)}>
                      Hide
                    </Button>
                  </div>
                )}

                {/* Initial email — editor while pending, bubble once sent */}
                {(!isReplacedBounce || bouncedThreadOpen) && (<>
                {selected.email_drafts?.status === "generating" || regenerating || getDraftActivity(selected) ? (
                  <div className="max-w-2xl mx-auto rounded-xl border border-border bg-card p-6 space-y-4 animate-pulse">
                    <div className="flex items-center gap-2 mb-2">
                      <Loader2 className="size-4 text-muted-foreground animate-spin" />
                      <p className="text-xs text-muted-foreground">
                        {getDraftActivity(selected) === "regenerating" || regenerating
                          ? "Regenerating personalised email…"
                          : "Generating personalised email…"}
                      </p>
                    </div>
                    <div className="h-4 w-48 bg-secondary rounded" />
                    <div className="space-y-2">
                      <div className="h-3 w-full bg-secondary rounded" />
                      <div className="h-3 w-full bg-secondary rounded" />
                      <div className="h-3 w-3/4 bg-secondary rounded" />
                    </div>
                    <div className="space-y-2 pt-2">
                      <div className="h-3 w-full bg-secondary rounded" />
                      <div className="h-3 w-5/6 bg-secondary rounded" />
                      <div className="h-3 w-2/3 bg-secondary rounded" />
                    </div>
                  </div>
                ) : selected.email_drafts && selected.email_drafts.status !== "sent" ? (
                  <div className="max-w-2xl mx-auto rounded-xl border border-border bg-card p-5 space-y-4">
                    <div className="space-y-1.5">
                      <Label className="eyebrow">Subject</Label>
                      <Input
                        value={editSubject}
                        onChange={(e) => setEditSubject(e.target.value)}
                        disabled={isPreviewingHistory || selected.email_drafts.status === "approved"}
                        className="font-medium"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="eyebrow">Body</Label>
                      <RichTextEditor
                        value={editBody}
                        onChange={setEditBody}
                        disabled={isPreviewingHistory || selected.email_drafts.status === "approved"}
                        minHeight={360}
                      />
                    </div>

                    {/* Attachment (delivered as a hosted download link — Instantly cannot send real attachments) */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        ref={attachInputRef}
                        type="file"
                        className="hidden"
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleLeadAttachmentUpload(f); }}
                      />
                      {selected.attachment?.effective ? (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-border bg-secondary/50 text-foreground max-w-full">
                          <Paperclip className="size-3 shrink-0" />
                          {selected.attachment.effective.url ? (
                            <a href={selected.attachment.effective.url} target="_blank" rel="noopener" className="truncate underline underline-offset-2 hover:text-primary">
                              {selected.attachment.effective.name}
                            </a>
                          ) : (
                            <span className="truncate">{selected.attachment.effective.name}</span>
                          )}
                          <span className="text-muted-foreground">
                            ({selected.attachment.effective.source === "lead" ? "this lead" : "campaign default"} · sent as link)
                          </span>
                          {selected.attachment.effective.source === "lead" && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={attaching}
                              onClick={() => void handleLeadAttachmentRemove()}
                              className="size-5 text-muted-foreground hover:text-red-400"
                              title="Remove per-lead attachment"
                            >
                              <X className="size-3" />
                            </Button>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                          <Paperclip className="size-3" /> No attachment — the email will not mention a brochure
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={attaching}
                        onClick={() => attachInputRef.current?.click()}
                        className="h-6 px-2 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
                      >
                        {attaching ? <Loader2 className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
                        {selected.attachment?.effective ? "Replace for this lead" : "Add for this lead"}
                      </Button>
                    </div>

                    {/* Action buttons */}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {selected.email_drafts.status === "draft" && !isPreviewingHistory && (
                        <>
                          <Button variant="outline" className="gap-1.5" disabled={saving} onClick={handleSaveEdit}>
                            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                            Save edits
                          </Button>
                          <Button className="gap-1.5" disabled={certifying || regenJobActive} title={regenJobActive ? "A regeneration is running — certifying is paused until it finishes" : undefined} onClick={() => handleCertifyOne(selected.email_drafts!.id)}>
                            {certifying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                            Certify
                          </Button>
                        </>
                      )}
                      {isPromptStaleForSelected && !isPreviewingHistory && (
                        <Button
                          variant="outline"
                          className="gap-1.5 border-amber-500/50 text-amber-500 hover:bg-amber-500/10 hover:text-amber-500"
                          disabled={regenerating}
                          onClick={handleRegenerateWithNewPrompt}
                          title="The system prompt was updated after this draft was generated"
                        >
                          {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                          Regenerate using new system prompt
                        </Button>
                      )}
                      {selected.email_drafts.status === "approved" && !isPreviewingHistory && (
                        <>
                          <p className="text-sm text-green-400 flex items-center gap-1.5 mr-1">
                            <CheckCircle2 className="size-4" /> Certified. Ready to send.
                          </p>
                          <Button variant="outline" className="gap-1.5" disabled={certifying} onClick={handleReopen}>
                            <RotateCcw className="size-3.5" /> Reopen for editing
                          </Button>
                        </>
                      )}
                      {/* Available for any lead not yet sent — draft, approved (certified), failed, or rejected —
                          so a fresh draft can be regenerated against the current prompt without an extra
                          reopen step, matching what the regenerate API already allows. */}
                      {["draft", "approved", "failed", "rejected"].includes(selected.email_drafts.status) && !isPreviewingHistory && (
                        <Button
                          variant="outline"
                          className={cn("gap-1.5", regenOpen && "border-primary text-primary bg-primary/5 hover:bg-primary/10 hover:text-primary")}
                          onClick={() => setRegenOpen((o) => !o)}
                        >
                          <RotateCcw className="size-3.5" /> Regenerate
                          <ChevronDown className={cn("size-3.5 transition-transform", regenOpen && "rotate-180")} />
                        </Button>
                      )}
                      {versions.length > 1 && (
                        <Button
                          variant="outline"
                          className={cn("gap-1.5", historyOpen && "border-primary text-primary bg-primary/5 hover:bg-primary/10 hover:text-primary")}
                          onClick={() => setHistoryOpen((o) => !o)}
                        >
                          <History className="size-3.5" />
                          Version history
                          <ChevronDown className={cn("size-3.5 transition-transform", historyOpen && "rotate-180")} />
                        </Button>
                      )}
                    </div>

                    {/* Version history */}
                    {historyOpen && versions.length > 1 && (
                      <div ref={historyPanelRef} className="enter space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
                        <div className="flex flex-wrap gap-2">
                          {versions.map((v) => (
                            <Button
                              key={v.id}
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => loadVersionPreview(v)}
                              className={cn(
                                "font-mono text-xs h-auto px-2.5 py-1.5",
                                (previewVersionId === v.id || (!previewVersionId && v.id === selected.email_drafts?.id))
                                  ? "border-primary bg-primary/10 text-primary hover:bg-primary/10"
                                  : "border-border bg-secondary/30 text-muted-foreground hover:border-muted-foreground",
                              )}
                            >
                              v{v.version} · {format(new Date(v.created_at), versionsSpanOneDay ? "HH:mm" : "MMM d, HH:mm")}
                            </Button>
                          ))}
                        </div>
                        {isPreviewingHistory && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-xs text-amber-400">Viewing historical version (read-only)</p>
                            <Button size="sm" variant="outline" disabled={restoring} onClick={() => handleRestoreVersion(previewVersionId!)}>
                              {restoring ? <Loader2 className="size-3 animate-spin" /> : "Restore this version"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => {
                              setPreviewVersionId(null);
                              setEditSubject(selected.email_drafts?.subject ?? "");
                              setEditBody(selected.email_drafts?.body ?? "");
                            }}>
                              Back to current
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Regenerate panel */}
                    {regenOpen && (
                      <div ref={regenPanelRef} className="enter swatch-bar-top rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2">
                        {/* A multi-line instruction is normal here — people paste a block of
                            bullets and say "remove this". An <input> cannot hold newlines: the
                            browser strips them on paste and joins them onto one line, and Enter
                            submitted instead of breaking the line. Ctrl/Cmd+Enter still sends. */}
                        <Textarea
                          ref={regenTextareaRef}
                          value={regenQuery}
                          onChange={(e) => setRegenQuery(e.target.value)}
                          rows={4}
                          className="text-sm resize-y bg-field"
                          placeholder='Describe the change — multiple lines are fine, e.g. paste a block and say "remove this"'
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRegenerate(); }}
                        />
                        <Button size="sm" onClick={handleRegenerate} disabled={regenerating || !regenQuery.trim()} className="gap-1.5">
                          {regenerating ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Regenerate
                        </Button>
                        {!regenQuery.trim() && (
                          <p className="text-[11px] text-muted-foreground">
                            Describe what to change — regenerating without an instruction would rewrite the email from scratch.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : outboxMessageItems.length > 0 ? (
                  <div className="rounded-xl border border-border bg-field dark:bg-card overflow-hidden">
                    <AddParticipantLeadDialog
                      open={!!outboxAddLeadFor}
                      email={outboxAddLeadFor}
                      organizationName={selectedThread?.lead_organization_name ?? null}
                      ownerName={selectedThread?.lead_owner_name ?? null}
                      saving={outboxSavingLead}
                      onCancel={() => setOutboxAddLeadFor(null)}
                      onConfirm={(f, l) => void handleOutboxConfirmAddLead(f, l)}
                    />
                    {outboxMessageItems.map((item) => (
                      <OutboxMessageRow
                        key={item.id}
                        senderName={item.sender}
                        toLabel={item.to}
                        ccLabel={item.cc}
                        fromThirdParty={item.fromThirdParty}
                        isUnanswered={item.isUnanswered}
                        isReplyTarget={outboxReplyOpen && !!item.replyTargetId && item.replyTargetId === outboxActiveTargetId}
                        inReplyToLabel={item.inReplyToLabel}
                        replyTargetName={item.replyTargetName}
                        stepLabel={item.stepLabel}
                        addingLead={outboxSavingLead && outboxAddLeadFor === item.promotableEmail}
                        onAddAsLead={item.promotableEmail
                          ? () => setOutboxAddLeadFor(item.promotableEmail)
                          : null}
                        onReplyTo={item.replyTargetId
                          ? () => {
                              setOutboxReplyTargetId(item.replyTargetId);
                              setOutboxReplyAll(false);
                              setOutboxReplyOpen(true);
                            }
                          : null}
                        onReplyAll={item.replyTargetId
                          ? () => {
                              setOutboxReplyTargetId(item.replyTargetId);
                              setOutboxReplyAll(true);
                              setOutboxReplyOpen(true);
                            }
                          : null}
                        timestamp={item.timestamp}
                        bodyHtml={item.bodyHtml}
                        bodyText={item.bodyText}
                        expanded={(item.id === outboxLastItemId) !== outboxExpandOverrides.has(item.id)}
                        onToggle={() => setOutboxExpandOverrides((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                          return next;
                        })}
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState message="No draft available for this lead." className="max-w-2xl mx-auto" />
                )}
                </>)}

                {/* Reply to the latest inbound message. Opens a plain composer;
                    the AI only writes a draft when "AI draft" is pressed.
                    Works even with no selectedThread at all (a never-replied
                    lead: getCampaignReplyThreads deliberately skips those, see
                    its own comment) as long as we at least have a thread id to
                    reply into, from this lead's own sequence sends. */}
                {(selectedThread || outboxFallbackThreadId) && (() => {
                  const outboxThreadId = selectedThread?.thread_key ?? outboxFallbackThreadId!;
                  // No inbound message at all (a pure cold-outreach thread) is
                  // fine — there is simply no AI reply draft to prefill, and the
                  // composer falls straight to a manual reply against our own
                  // sent message (see outboxActiveTarget/replyTargetFor).
                  const lastMsg = selectedThread?.messages[selectedThread.messages.length - 1] ?? null;
                  const latestDraft = lastMsg?.reply_drafts[lastMsg.reply_drafts.length - 1] ?? null;
                  const hasDraftReady = !!latestDraft && latestDraft.status !== "generating" && latestDraft.status !== "sent" && latestDraft.status !== "rejected";
                  const isGenerating = latestDraft?.status === "generating" || outboxNewReplyLoading;
                  // AI drafting is only wired to a real reply-thread row — a
                  // never-replied lead still gets the plain manual composer.
                  const campaignLeadId = selectedThread?.campaign_lead_id ?? null;

                  // Same participant model as the Unibox: reply-all by default,
                  // recipients shown literally, and the target chosen per
                  // message. Without this the composer answers whoever spoke
                  // last and silently drops everyone else, the lead included.
                  const outboxParticipants = threadParticipants(outboxParticipantMessages, {
                    ourEmails: outboxOurEmails,
                    leadEmail: outboxLeadAddress,
                  });
                  // Reply all puts every participant in To (Instantly's
                  // additional_recipients); plain Reply addresses only the
                  // sender of the message being answered.
                  const outboxTo = replyRecipients(outboxActiveTarget, outboxParticipants, outboxLeadAddress);
                  const outboxRecipientsCtx: ReplyRecipientContext = {
                    to: outboxReplyAll ? [...outboxTo.to, ...outboxTo.cc] : outboxTo.to,
                    lockedTo: outboxTo.to[0] ?? null,
                    participants: outboxParticipants.map((p) => p.email),
                    leadEmail: outboxLeadAddress,
                    leadName: outboxReplyName,
                    replyToUuid: outboxActiveTargetId,
                  };

                  function handleReplyClick() {
                    if (outboxReplyOpen) {
                      setOutboxReplyOpen(false);
                      return;
                    }
                    setOutboxReplyOpen(true);
                    // Prefill saved drafts; only start blank for a new reply after send, or empty drafts
                    const hasContent = !!(
                      latestDraft?.subject?.trim() ||
                      (latestDraft?.body ?? "").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").trim()
                    );
                    setOutboxReplyStartBlank(
                      !latestDraft || latestDraft.status === "sent" || latestDraft.status === "rejected" || !hasContent,
                    );
                  }

                  function handleAiDraftClick() {
                    if (!campaignLeadId) return;
                    setOutboxReplyOpen(true);
                    setOutboxReplyStartBlank(false);
                    void handleGenerateOutboxReply(campaignLeadId);
                  }

                  return (
                    <div className="pt-2 w-full">
                      <Button
                        size="sm"
                        onClick={handleReplyClick}
                        className="gap-1.5 rounded-full px-4"
                      >
                        <Reply className="size-3.5" />
                        Reply
                        <ChevronDown className={cn("size-3.5 transition-transform", outboxReplyOpen && "rotate-180")} />
                      </Button>

                      {outboxReplyOpen && (
                        <div className="mt-3">
                          {isGenerating && !hasDraftReady ? (
                            <div className="flex items-center gap-2.5 text-sm text-muted-foreground py-4 justify-center w-full">
                              <Loader2 className="size-4 animate-spin" /> Writing reply draft…
                            </div>
                          ) : hasDraftReady ? (
                            <ReplyDraftBox
                              key={latestDraft!.id}
                              draft={latestDraft!}
                              token={appSession?.access_token ?? ""}
                              onChanged={() => void loadReplies()}
                              startBlank={outboxReplyStartBlank && !replyDraftHasContent(latestDraft)}
                              onNewAiDraft={campaignLeadId ? handleAiDraftClick : undefined}
                              newAiDraftPending={isGenerating}
                              recipients={outboxRecipientsCtx}
                            />
                          ) : (
                            <ManualReplyBox
                              threadId={outboxThreadId}
                              token={appSession?.access_token ?? ""}
                              replyToSubject={selectedThread?.original_email?.subject ?? null}
                              onSent={() => { setOutboxReplyOpen(false); void loadReplies(); }}
                              onCancel={() => setOutboxReplyOpen(false)}
                              onNewAiDraft={campaignLeadId ? handleAiDraftClick : undefined}
                              newAiDraftPending={isGenerating}
                              recipients={outboxRecipientsCtx}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Sequences ─────────────────────────────────────────────────────── */}
      {viewTab === "sequences" && (
        <div className="flex flex-1 min-h-0">
          {/* Left: the leads, laid out exactly like Outbox.
              This tab used to lead with the STEPS, so answering "what is this
              lead getting?" meant visiting every step in turn. The lead is the
              subject people actually have in mind, so it is the subject here —
              and matching Outbox leaves one layout to learn instead of two. */}
          <div className="w-[266px] h-full shrink-0 border-r border-border flex flex-col">
            <div className="border-b border-border shrink-0">
              <div className="px-3 pt-2 pb-2 space-y-2">
                <SearchInput
                  value={seqLeadSearch}
                  onChange={setSeqLeadSearch}
                  placeholder="Search name or company"
                  className="h-7 text-[11px]"
                />
                <Select value={seqLeadFilter} onValueChange={(v) => { setSeqLeadFilter(v as typeof seqLeadFilter); setSeqLeadId(null); }}>
                  <SelectTrigger className="h-7 w-full gap-1.5 rounded-md border-border px-2 py-0 text-[11px] font-medium text-foreground [&>svg]:size-3 [&>svg]:opacity-70">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="due" className="text-[11px]">To be sent ({seqCounts.due})</SelectItem>
                    <SelectItem value="sent" className="text-[11px]">Already sent ({seqCounts.sent})</SelectItem>
                    <SelectItem value="unwritten" className="text-[11px]">Not written ({seqCounts.unwritten})</SelectItem>
                    <SelectItem value="all" className="text-[11px]">All ({seqCounts.all})</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* How this step was written. The client bought a personalised
                  email per company; without this number a template is
                  indistinguishable from the real thing. */}
              {(seqQuality.ai > 0 || seqQuality.template > 0) && (
                <div className="px-3 pb-2 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-mono tabular-nums font-semibold">{seqQuality.ai}</span>
                    <span className="text-muted-foreground">personalised</span>
                    {seqQuality.template > 0 && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="font-mono tabular-nums font-semibold text-amber-600">{seqQuality.template}</span>
                        <span className="text-muted-foreground">template</span>
                      </>
                    )}
                  </div>
                  {seqQuality.reasons.map(([why, n]) => (
                    <p key={why} className="text-[10px] leading-snug text-muted-foreground">
                      <span className="font-mono tabular-nums">{n}</span> · {why}
                    </p>
                  ))}
                </div>
              )}
              {seqCounts.finished > 0 && (
                <div className="px-3 pb-2">
                  <p className="text-[10px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{seqCounts.finished}</span> out of sequence
                    {seqCounts.replied > 0 ? ` · ${seqCounts.replied} replied` : ""}
                    {seqCounts.bounced > 0 ? ` · ${seqCounts.bounced} bounced` : ""}
                  </p>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-1.5 p-2">
              {seqLeadRows.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">
                  {seqLeadFilter === "due" ? "No follow-ups waiting to go out." : "No leads match this filter."}
                </p>
              ) : seqLeadRows.map(({ cl, finished, sentCount, totalSteps, anyTemplateSent }) => {
                const lead = cl.leads;
                const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unknown";
                const isActive = seqActiveLeadRow?.cl.id === cl.id;
                return (
                  <Button
                    key={cl.id}
                    type="button"
                    variant="ghost"
                    onClick={() => setSeqLeadId(cl.id)}
                    className={cn(
                      "h-auto w-full block justify-start text-left font-normal rounded-lg border px-3 py-2.5",
                      isActive
                        ? "border-primary bg-primary/8 hover:bg-primary/8"
                        : "border-border bg-field hover:bg-field hover:border-muted-foreground/40",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Avatar name={name} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-xs font-medium truncate", isActive ? "text-primary" : "text-foreground")}>{name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{lead?.company_name ?? ""}</p>
                        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                          {finished ? (
                            <span className="inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-muted text-muted-foreground border-border capitalize">
                              {finished}
                            </span>
                          ) : (
                            <>
                              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                                {sentCount} of {totalSteps} sent
                              </span>
                              {/* A template actually REACHED this person. Worth a
                                  mark at lead level because it is the one thing
                                  here the client would want to chase; which step
                                  it was is on the card. */}
                              {anyTemplateSent && (
                                <span
                                  title="A template was sent to this lead"
                                  className="inline-block size-1.5 rounded-full bg-amber-500"
                                />
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Right: everything this ONE lead is getting, step by step. */}
          <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto space-y-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-display text-sm font-semibold truncate">
                    {seqActiveLeadRow
                      ? [seqActiveLeadRow.cl.leads?.first_name, seqActiveLeadRow.cl.leads?.last_name].filter(Boolean).join(" ") || "Lead"
                      : "No lead selected"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {seqActiveLeadRow?.cl.leads?.title ? `${seqActiveLeadRow.cl.leads.title} · ` : ""}
                    {seqActiveLeadRow?.cl.leads?.company_name ?? ""}
                  </p>
                </div>
                <SegmentedTabs
                  size="sm"
                  value={seqPane}
                  onValueChange={(v) => setSeqPane(v as "lead" | "template")}
                  options={[
                    { value: "lead", label: "This lead" },
                    { value: "template", label: "Steps" },
                  ]}
                />
              </div>

              {seqPane === "lead" ? (
                !seqActiveLeadRow ? (
                  <p className="text-sm text-muted-foreground py-10 text-center">
                    Pick a lead to read every follow-up written for them.
                  </p>
                ) : seqActiveLeadRow.finished ? (
                  <div className="rounded-lg border border-border bg-field p-6 text-center space-y-2">
                    <p className="text-sm font-medium capitalize">{seqActiveLeadRow.finished}</p>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                      {seqActiveLeadRow.finished === "replied"
                        ? "They answered, so Instantly stopped the sequence here. No further follow-up will be sent."
                        : "Their address rejected our email, so the sequence stopped here."}
                    </p>
                  </div>
                ) : seqLeadTimeline.length === 0 ? (
                  <EmptyState message="This campaign has no follow-up steps yet." />
                ) : (
                  <div className="space-y-3">
                    {seqLeadTimeline.map((row) => (
                      <div key={row.step.step_order} className="rounded-lg border border-border bg-field p-4 space-y-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                            Follow-up {sequenceDisplayStep(row.step.step_order)}
                          </span>
                          {/* The landing day, not the raw delay. Delays stack, so
                              the number typed into the step is not the day it
                              goes out — showing the total is what stops that
                              being misread. */}
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            day {row.daysFromOpening}
                          </span>
                          {row.dueAt && (
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                              {row.sent ? "sent" : "due"} {format(row.dueAt, "MMM d")}
                            </span>
                          )}
                          {row.sent && (
                            <Pill shape="sm" className="bg-emerald-500/15 text-emerald-600 border-transparent">Sent</Pill>
                          )}
                          {row.written && (
                            row.isTemplate
                              ? <Pill shape="sm" className="bg-amber-500/15 text-amber-600 border-transparent">Template</Pill>
                              : <Pill shape="sm" className="bg-primary/15 text-primary border-transparent">AI written</Pill>
                          )}
                        </div>

                        {row.isTemplate && row.draft?.fallback_reason && (
                          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                            {row.draft.fallback_reason}
                          </p>
                        )}

                        {row.written ? (
                          seqEditingDraftId === row.draft?.id ? (
                            <RichTextEditor value={seqEditBody} onChange={setSeqEditBody} />
                          ) : (
                            <div
                              className="text-sm leading-relaxed [&_p]:mb-2"
                              dangerouslySetInnerHTML={{ __html: row.draft?.body ?? "" }}
                            />
                          )
                        ) : (
                          /* Not written yet — so this is the window where an
                             instruction still changes the outcome. Saying WHEN it
                             closes is the whole point; "the day before it is due"
                             is not something anyone can act on. */
                          <p className="text-xs text-muted-foreground">
                            {row.writesAt
                              ? <>Written automatically on <span className="font-medium text-foreground">{format(row.writesAt, "d MMM")}</span>. Anything added to this step&rsquo;s instruction before then will be used.</>
                              : "Written automatically once the opening email has gone out."}
                          </p>
                        )}

                        {!row.sent && row.written && canEditSettings && (
                          <div className="pt-3 border-t border-border flex items-center gap-2 flex-wrap">
                            {seqEditingDraftId === row.draft?.id ? (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={seqEditSaving}
                                  onClick={() => void handleSaveFollowupEdit(row.draft!.id)}
                                  className="h-7 gap-1.5 px-3 text-xs [&_svg]:size-3"
                                >
                                  {seqEditSaving ? <Loader2 className="animate-spin" /> : <Save />}
                                  Save
                                </Button>
                                <Button
                                  type="button" size="sm" variant="ghost"
                                  onClick={() => setSeqEditingDraftId(null)}
                                  className="h-7 px-3 text-xs"
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => { setSeqEditingDraftId(row.draft!.id); setSeqEditBody(row.draft!.body ?? ""); }}
                                className="h-7 gap-1.5 px-3 text-xs [&_svg]:size-3"
                              >
                                <Pencil />
                                Edit
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={seqLeadRegenerating === seqActiveLeadRow.cl.id}
                              onClick={() => {
                                setSeqRegenOpenFor((cur) => (cur === row.draft!.id ? null : row.draft!.id));
                                setSeqRegenQuery("");
                              }}
                              className={cn(
                                "h-7 gap-1.5 px-3 text-xs [&_svg]:size-3",
                                seqRegenOpenFor === row.draft?.id && "border-primary text-primary bg-primary/5",
                              )}
                            >
                              {seqLeadRegenerating === seqActiveLeadRow.cl.id
                                ? <Loader2 className="animate-spin" />
                                : <RotateCcw />}
                              Regenerate
                              <ChevronDown className={cn("transition-transform", seqRegenOpenFor === row.draft?.id && "rotate-180")} />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void toggleSeqHistory(row.draft!.id)}
                              className={cn(
                                "h-7 gap-1.5 px-3 text-xs [&_svg]:size-3",
                                seqHistoryOpen === row.draft!.id && "border-primary text-primary bg-primary/5",
                              )}
                            >
                              <History />
                              Version history
                              <ChevronDown className={cn("transition-transform", seqHistoryOpen === row.draft!.id && "rotate-180")} />
                            </Button>
                            <span className="text-[11px] text-muted-foreground">Saved automatically</span>
                          </div>
                        )}

                        {/* Ask before spending the credit. Firing straight away
                            replaced the email with no chance to say what was
                            wrong with it — and a blind reroll is rarely what
                            someone means when they press Regenerate. */}
                        {seqRegenOpenFor === row.draft?.id && (
                          <div className="enter rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                            <Textarea
                              value={seqRegenQuery}
                              onChange={(e) => setSeqRegenQuery(e.target.value)}
                              rows={3}
                              className="text-sm resize-y bg-field"
                              placeholder="What should change? Leave empty to simply write it again."
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                  void handleRegenerateLeadFollowup(seqActiveLeadRow.cl.id, row.draft!.id, seqRegenQuery);
                                }
                              }}
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                type="button" size="sm"
                                disabled={seqLeadRegenerating === seqActiveLeadRow.cl.id}
                                onClick={() => void handleRegenerateLeadFollowup(seqActiveLeadRow.cl.id, row.draft!.id, seqRegenQuery)}
                                className="h-7 gap-1.5 px-3 text-xs [&_svg]:size-3"
                              >
                                {seqLeadRegenerating === seqActiveLeadRow.cl.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                                {seqRegenQuery.trim() ? "Apply this change" : "Write it again"}
                              </Button>
                              <Button type="button" size="sm" variant="ghost"
                                onClick={() => setSeqRegenOpenFor(null)} className="h-7 px-3 text-xs">
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Regenerating is cheap enough that people do it a few
                            times and then decide the second attempt was best. */}
                        {seqHistoryOpen === row.draft?.id && (
                          <div className="enter space-y-2 rounded-lg border border-border bg-secondary/30 p-3">
                            {seqHistoryLoading ? (
                              <p className="text-xs text-muted-foreground flex items-center gap-2">
                                <Loader2 className="size-3 animate-spin" /> Loading versions…
                              </p>
                            ) : seqVersions.length < 2 ? (
                              <p className="text-xs text-muted-foreground">
                                Only one version so far. Regenerate and the earlier text shows up here.
                              </p>
                            ) : (
                              <>
                                <div className="flex flex-wrap gap-2">
                                  {seqVersions.map((v) => {
                                    const isCurrent = v.id === row.draft!.id;
                                    const isShown = seqPreviewVersion ? seqPreviewVersion.id === v.id : isCurrent;
                                    return (
                                      <Button
                                        key={v.id}
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setSeqPreviewVersion(isCurrent ? null : v)}
                                        className={cn(
                                          "font-mono text-xs h-auto px-2.5 py-1.5",
                                          isShown
                                            ? "border-primary bg-primary/10 text-primary hover:bg-primary/10"
                                            : "border-border bg-secondary/30 text-muted-foreground hover:border-muted-foreground",
                                        )}
                                      >
                                        v{v.version} · {format(new Date(v.created_at), seqVersionsSpanOneDay ? "HH:mm" : "MMM d, HH:mm")}
                                      </Button>
                                    );
                                  })}
                                </div>
                                {seqPreviewVersion && (
                                  <>
                                    <div
                                      className="rounded-md border border-border bg-field p-3 text-sm leading-relaxed [&_p]:mb-2"
                                      dangerouslySetInnerHTML={{ __html: seqPreviewVersion.body ?? "" }}
                                    />
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <p className="text-xs text-amber-400">Viewing an older version (read-only)</p>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={seqRestoring}
                                        onClick={() => void handleRestoreSeqVersion(seqPreviewVersion.id)}
                                      >
                                        {seqRestoring ? <Loader2 className="size-3 animate-spin" /> : "Restore this version"}
                                      </Button>
                                      <Button size="sm" variant="ghost" onClick={() => setSeqPreviewVersion(null)}>
                                        Back to current
                                      </Button>
                                    </div>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {row.sent && (
                          <p className="pt-3 border-t border-border text-[11px] text-muted-foreground">
                            Already sent, so it can no longer be changed.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )
              ) : (
                /* Steps pane: the timing of every step, and adding one. This
                   lived in Options, two tabs from where you are standing when
                   you decide another step is needed. */
                <div className="space-y-3">
                  {/* Said plainly, because the pane sits under a lead's name and
                      everything in it is campaign-wide. Editing here changes the
                      schedule for everyone, not for the person on screen. */}
                  <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
                    <p className="text-xs font-medium">{campaign.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Timing and instructions for all {campaignLeads.length} leads in this campaign — not just this one.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="eyebrow">Applies to every follow-up</Label>
                    <Textarea
                      value={seqCampaignInstruction}
                      disabled={!canEditSettings}
                      onChange={(e) => setSeqCampaignInstruction(e.target.value)}
                      placeholder="e.g. Mention that we now hold stock in a Dubai warehouse, so Gulf customers get two-week delivery."
                      className="text-sm min-h-16"
                    />
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Each wait is counted from the previous email, so they add up — the day
                    shown is when that follow-up actually goes out.
                  </p>
                  {seqStepEdits.map((st, idx) => (
                    <div key={idx} className="rounded-lg border border-border bg-field px-3 py-2 space-y-2">
                      <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-24 shrink-0">
                        Follow-up {idx + 1} after
                      </span>
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        value={st.delay}
                        disabled={!canEditSettings}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(365, Number(e.target.value) || 1));
                          setSeqStepEdits((prev) => prev.map((x, i) => (i === idx ? { ...x, delay: v } : x)));
                        }}
                        className="h-7 w-14 px-1 py-0 text-center text-sm font-mono tabular-nums"
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground ml-auto shrink-0">
                        {dayLabel(seqStepEditDays[idx] ?? 0)}
                      </span>
                      {canEditSettings && seqStepEdits.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setSeqStepEdits((prev) => prev.filter((_, i) => i !== idx))}
                          className="h-auto p-0 text-xs text-muted-foreground hover:text-destructive hover:bg-transparent shrink-0"
                        >
                          Remove
                        </Button>
                      )}
                      </div>
                      {/* Adds to the campaign-wide box above rather than
                          replacing it: "mention the warehouse" belongs on every
                          follow-up while "ask for a call" belongs only on the
                          last, and that last step usually wants both.
                          
                          Closed once nobody is left to receive it. An
                          instruction only reaches a follow-up that has not been
                          written yet, so on a step every lead has already had,
                          the box is a promise the system cannot keep — and
                          typing into it and pressing Save changes nothing, with
                          nothing on screen to say why. */}
                      {(() => {
                        const stepOrder = idx + 2;
                        const stillToWrite = seqLive.filter((cl) =>
                          !hasReceivedFollowupStep(cl, stepOrder)
                          && !(cl.all_drafts ?? []).some((d) => d.step_number === stepOrder && d.body),
                        ).length;
                        const alreadySent = campaignLeads.filter((cl) => hasReceivedFollowupStep(cl, stepOrder)).length;

                        if (stillToWrite === 0) {
                          return (
                            <p className="text-[11px] text-muted-foreground">
                              {alreadySent > 0
                                ? <>Already written for everyone{alreadySent > 0 ? ` (${alreadySent} sent)` : ""} — an instruction here would not change any of them. Use Regenerate on the step or on a lead instead.</>
                                : "Already written for every lead. Use Regenerate to change them."}
                            </p>
                          );
                        }
                        return (
                          <>
                            <Textarea
                              value={st.ai_instruction ?? ""}
                              disabled={!canEditSettings}
                              onChange={(e) => setSeqStepEdits((prev) => prev.map((x, i) => (i === idx ? { ...x, ai_instruction: e.target.value } : x)))}
                              placeholder={`Extra instruction for follow-up ${idx + 1} only (optional)`}
                              className="text-xs min-h-12"
                            />
                            <p className="text-[10px] text-muted-foreground">
                              Will be used for {stillToWrite} lead{stillToWrite === 1 ? "" : "s"} not yet written
                              {alreadySent > 0 ? ` · ${alreadySent} already sent and unaffected` : ""}.
                            </p>
                          </>
                        );
                      })()}
                    </div>
                  ))}
                  {canEditSettings && (
                    <div className="flex items-center gap-3">
                      {seqStepEdits.length < 8 && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          onClick={() => setSeqStepEdits((prev) => [
                            ...prev,
                            // Repeat the previous gap rather than adding to it —
                            // adding is what made a 35-day sequence run 104 days.
                            { delay: prev[prev.length - 1]?.delay ?? 7, delay_unit: "days" as const },
                          ])}
                          className="h-auto p-0 text-xs font-medium"
                        >
                          + Add follow-up step
                        </Button>
                      )}
                      {/* Rewrites every LEAD's follow-up for a step — a
                          different thing from editing the timing above it, and
                          the natural next move after changing the instructions. */}
                      {campaignSteps.filter((st) => st.step_order > 1).map((st) => {
                        const n = seqLeadRows.filter((r) => {
                          const d = (r.cl.all_drafts ?? []).find((x) => x.step_number === st.step_order);
                          return !!d?.body && !hasReceivedFollowupStep(r.cl, st.step_order) && !r.finished;
                        }).length;
                        if (n === 0) return null;
                        return (
                          <Button
                            key={st.step_order}
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={bulkRegenOpening}
                            title="Rewrite every lead's follow-up for this step. Already-sent ones are left alone."
                            onClick={() => void openBulkRegenerate(undefined, st.step_order)}
                            className="h-7 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3"
                          >
                            {bulkRegenOpening ? <Loader2 className="animate-spin" /> : <Users />}
                            Regenerate all · FU{sequenceDisplayStep(st.step_order)} ({n})
                          </Button>
                        );
                      })}
                      <Button
                        type="button"
                        size="sm"
                        disabled={seqStepSaving}
                        onClick={() => void handleSaveSeqSteps()}
                        className="h-7 gap-1.5 px-3 text-xs [&_svg]:size-3 ml-auto"
                      >
                        {seqStepSaving ? <Loader2 className="animate-spin" /> : <Save />}
                        Save steps
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Options ───────────────────────────────────────────────────────── */}
      {viewTab === "options" && (
        <div className="flex-1 overflow-y-auto px-8 py-8">
          <EditCampaignForm
            variant="page"
            campaign={campaign}
            readOnly={!canEditSettings}
            onSaved={() => {
              if (appSession?.access_token) void loadCampaigns(appSession.access_token);
            }}
          />
        </div>
      )}

      {/* ── Discussion ────────────────────────────────────────────────────── */}
      {viewTab === "discussion" && (
        <div className="flex-1 min-h-0 flex flex-col bg-secondary/20">
          <div className="flex-1 overflow-y-auto">
            <div className="w-full max-w-3xl mx-auto px-6 py-6">
              {loadingComments ? (
                <div className="min-h-[320px] animate-pulse space-y-4 pt-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`flex gap-2.5 ${i % 2 === 0 ? "" : "flex-row-reverse"}`}>
                      <div className="size-7 rounded-full bg-secondary shrink-0" />
                      <div className="space-y-1.5 max-w-[65%]">
                        <div className="h-3 w-16 bg-secondary rounded" />
                        <div className="h-12 w-48 bg-secondary rounded-xl" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : comments.length === 0 ? (
                <div className="min-h-[320px] flex flex-col items-center justify-center text-center px-5">
                  <div className="size-11 rounded-full border border-border bg-field flex items-center justify-center text-primary mb-3">
                    <MessageSquare className="size-5" />
                  </div>
                  <p className="text-sm font-semibold">Start the campaign discussion</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm leading-relaxed">
                    Notes here are visible to managers and employees who can access this campaign.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {comments.map((comment, index) => {
                    const own = comment.author_id === appSession?.user.id;
                    const showDate = startsNewChatDay(
                      comment.created_at,
                      comments[index - 1]?.created_at,
                    );
                    return (
                      <div key={comment.id} className="space-y-3">
                        {showDate && (
                          <div className="flex items-center justify-center py-1">
                            <span className="rounded-full border border-border bg-field px-3 py-1 text-[10px] leading-none font-medium text-muted-foreground shadow-sm">
                              <span className="translate-y-px inline-block">{formatChatDate(comment.created_at)}</span>
                            </span>
                          </div>
                        )}
                        <DiscussionComment
                          comment={comment}
                          isOwn={own}
                          currentUserId={appSession?.user.id ?? ""}
                          onToggleReaction={(emoji) => handleToggleCommentReaction(comment.id, emoji)}
                        />
                      </div>
                    );
                  })}
                  <div ref={commentsEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Floating composer — no full-width bar, the input is its own card. */}
          <div className="shrink-0 w-full max-w-3xl mx-auto px-6 pb-6 pt-2">
            <div className="rounded-2xl border border-border bg-field shadow-lg shadow-black/5">
              <Textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void handleSendComment();
                  }
                }}
                maxLength={2000}
                rows={3}
                placeholder="Write a message to the campaign team…"
                className="min-h-[76px] resize-none border-0 bg-transparent text-sm shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 px-4 pt-3"
              />
              <div className="flex items-center justify-between gap-2 px-4 pb-3">
                <span className="text-[10px] text-muted-foreground">
                  Ctrl/⌘ + Enter to send
                </span>
                <Button
                  type="button"
                  size="icon"
                  onClick={() => void handleSendComment()}
                  disabled={!commentBody.trim() || sendingComment}
                  aria-label="Send message"
                  title="Send message"
                  className="size-8 rounded-full"
                >
                  {sendingComment
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <ArrowUp className="size-4" strokeWidth={2.5} />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      </div>

      {/* ── Shared modals ─────────────────────────────────────────────────── */}

      {bulkRegenPreview && (
        <RegenerateDraftsModal
          counts={bulkRegenPreview.counts}
          skipped={bulkRegenPreview.skipped}
          isSubset={bulkRegenPreview.isSubset}
          submitting={bulkRegenSubmitting}
          onConfirm={(instruction) => void submitBulkRegenerate(instruction)}
          onCancel={() => setBulkRegenPreview(null)}
        />
      )}

      {replaceTarget && (
        <ReplaceLeadModal
          target={replaceTarget}
          submitting={replaceSubmitting}
          error={replaceError}
          onConfirm={(input) => void handleReplaceConfirm(input)}
          onCancel={() => { setReplaceTarget(null); setReplaceError(""); }}
        />
      )}

      {/* Lead detail drawer — opened when name card is clicked */}
      <LeadDrawer
        lead={drawerLead}
        onClose={() => setDrawerLead(null)}
        onOrgClick={(id) => { setDrawerLead(null); setDrawerOrgId(id); }}
      />
      <OrgDrawer
        orgId={drawerOrgId}
        onClose={() => setDrawerOrgId(null)}
        onLeadClick={(leadId) => {
          setDrawerOrgId(null);
          setDrawerLead({ id: leadId, firstName: "", lastName: "", email: "", company: "", domain: "", domainSource: null, phone: "", jobTitle: "", country: "", status: "Enriched", score: "—", source: "Apollo", campaign: "", campaigns: [], createdAt: new Date().toISOString(), orgId: null, enrichmentStage: null, companyDescription: null, sellsTo: null, lastError: null, hasScraped: false, importId: null, batchLabel: null, batchColor: null, assignedTo: null, orgShared: null });
        }}
      />
    </div>
  );
}

/** @deprecated Use CampaignDetail inline in page — kept for backwards compat */
export function CampaignDrawer({
  campaign,
  onClose,
}: {
  campaign: Campaign | null;
  onClose: () => void;
}) {
  if (!campaign) return null;
  return (
    <div className="fixed inset-0 z-40 bg-background">
      <CampaignDetail campaign={campaign} onBack={onClose} />
    </div>
  );
}
