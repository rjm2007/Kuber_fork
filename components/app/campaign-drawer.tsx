"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Megaphone, Users, Send, MessageSquare, Clock, Gauge, ArrowUp,
  Globe, Calendar, ExternalLink, Loader2, CheckCircle2, RotateCcw, RefreshCw, Check, Save, History, ChevronDown, ArrowLeft,
  List, LayoutGrid, BarChart2, Flame, Snowflake, ThumbsDown, Layers, Paperclip, X, Sparkles, Pencil, Reply, AlertTriangle,
  Building2, MapPin, ReplyAll, CornerDownRight, UserPlus,
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
  latestInboundMessage,
  ourAddresses,
  parseAddressList,
  replyRecipients,
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
  computeCampaignStats, deliveryBucket, DELIVERY_BUCKET_LABELS,
  type DeliveryBucket,
} from "@/lib/campaign-status";

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
  } | null;
  email_drafts: { id: string; subject: string | null; body: string | null; status: string; step_number?: number | null; created_at?: string } | null;
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
  /** Set once someone answered this bounce by adding another contact at the same
   *  company. The row stays bounced (and still counts as one) — this only marks
   *  it as dealt with, so nobody redoes the work. */
  replaced_by_lead_id?: string | null;
  attachment?: AttachmentInfo;
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

function findSampleDraftForStep(leads: CampaignLead[], stepNumber: number): EmailDraftRow | null {
  for (const cl of leads) {
    const d = getLeadDraftForStep(cl, stepNumber);
    if (d?.body) return d;
  }
  return null;
}

/** Old sequences-tab default that looked like a second initial email — never treat as real content. */
const LEGACY_MISLEADING_FOLLOWUP_SUBJECT =
  "Introduction: Kuber Polyplast | Masterbatch Solutions for Packaging Manufacturers";

const GENERIC_FOLLOWUP_BODY =
  "Hi {{firstName}},\n\nJust following up on my previous note — would love your thoughts.\n\nBest regards";

function sequenceStepSubtitle(
  step: { step_order: number; subject: string; body: string },
  leads: CampaignLead[],
): string | null {
  const displayStep = step.step_order - 1;
  const draft = findSampleDraftForStep(leads, step.step_order);
  const subject = (draft?.subject ?? step.subject)?.trim();
  if (subject && !isInstantlyPlaceholder(subject) && subject !== LEGACY_MISLEADING_FOLLOWUP_SUBJECT) {
    return subject;
  }
  if (draft?.body) return `Step ${displayStep}`;
  return `Step ${displayStep} (threaded reply)`;
}

/** Campaign steps shown in the Sequences tab (initial email is edited under Drafts). */
function sequenceFollowUpSteps(
  steps: Array<{ step_order: number; subject: string; body: string; delay: number; delay_unit: string }>,
) {
  return steps.filter((s) => s.step_order > 1);
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
  /** Set for inbound messages that can be answered directly. */
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
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        className="h-auto w-full justify-start gap-3 px-4 py-2.5 text-left font-normal rounded-none border-b border-border/60 last:border-b-0 hover:bg-secondary/40"
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
        {/* Same reason as the Unibox: the collapsed row is the glanceable one. */}
        {isUnanswered && (
          <Badge variant="outline" className="shrink-0 rounded font-mono text-[9px] px-1.5 py-0 border-amber-500/40 text-amber-500">
            Not answered
          </Badge>
        )}
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
          {snippet || "(empty message)"}
        </span>
        {timestamp && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
            {format(new Date(timestamp), "MMM d")}
          </span>
        )}
      </Button>
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
              Reply to {senderName}
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
  const [leadsDelivery, setLeadsDelivery] = useState<DeliveryBucket | "all">("all");
  const [leadsViewMode, setLeadsViewMode] = useState<"list" | "kanban">("list");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: string; subject: string | null; body: string | null; status: string; version: number; created_at: string }>>([]);
  const [campaignSteps, setCampaignSteps] = useState<CampaignStepInput[]>([]);
  const [stepPerformance, setStepPerformance] = useState<Array<{ step: number; sent: number; failed: number; total: number }>>([]);
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [viewTab, setViewTab] = useState<CampaignViewTab>("analytics");
  const [report, setReport] = useState<CampaignReportData | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [drawerLead, setDrawerLead] = useState<Lead | null>(null);
  const [drawerOrgId, setDrawerOrgId] = useState<string | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<ReplaceLeadTarget | null>(null);
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);
  const [replaceError, setReplaceError] = useState("");
  const [threads, setThreads] = useState<CampaignReplyThread[]>([]);
  const [outboxFilter, setOutboxFilter] = useState<
    "all" | "action" | "certified" | "sending" | "sent" | "replied" | "bounced"
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
  const [sequencesLoading, setSequencesLoading] = useState(false);
  // seq edit state — initialized when selectedSequenceStep changes
  const [seqSubjectEdit, setSeqSubjectEdit] = useState("");
  const [seqBodyEdit, setSeqBodyEdit] = useState("");
  const [seqHasContent, setSeqHasContent] = useState(false);
  const [seqRegenOpen, setSeqRegenOpen] = useState(false);
  const [seqRegenQuery, setSeqRegenQuery] = useState("");
  const [seqRegenerating, setSeqRegenerating] = useState(false);
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

    const stepMap = new Map<number, { sent: number; failed: number; total: number }>();
    for (const cl of rawLeads) {
      for (const d of getLeadDrafts(cl)) {
        const step = d.step_number ?? 1;
        const entry = stepMap.get(step) ?? { sent: 0, failed: 0, total: 0 };
        entry.total++;
        if (d.status === "sent") entry.sent++;
        if (d.status === "failed") entry.failed++;
        stepMap.set(step, entry);
      }
    }
    setStepPerformance([...stepMap.entries()].sort((a, b) => a[0] - b[0]).map(([step, v]) => ({ step, ...v })));

    const leads = rawLeads.map((cl) => {
      const step1Draft = getLeadDraftForStep(cl, 1);
      return step1Draft ? { ...cl, email_drafts: step1Draft } : { ...cl, email_drafts: null };
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

  useEffect(() => {
    if (viewTab !== "sequences") return;
    let cancelled = false;
    setSequencesLoading(true);
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      try {
        const { steps } = await fetchCampaignSteps(session.access_token, campaign.id);
        if (!cancelled) {
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
      } finally {
        if (!cancelled) setSequencesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [viewTab, campaign.id]);

  // Initialize sequence step edit state (follow-up steps only — initial email lives under Drafts).
  useEffect(() => {
    if (viewTab !== "sequences") return;
    const followUps = sequenceFollowUpSteps(campaignSteps);
    const step = followUps.find((s) => s.step_order === selectedSequenceStep) ?? followUps[0];
    if (!step) return;

    const rawBody = step.body ?? "";
    const rawSubject = step.subject ?? "";
    const isPlaceholder = isInstantlyPlaceholder(rawBody);
    const subject = rawSubject && rawSubject !== LEGACY_MISLEADING_FOLLOWUP_SUBJECT ? rawSubject : "";
    const body = isPlaceholder || !rawBody ? GENERIC_FOLLOWUP_BODY : rawBody;
    setSeqSubjectEdit(subject);
    setSeqBodyEdit(body);
    setSeqHasContent(true);
    setSeqStepSaving(false);
    setSeqRegenOpen(false);
    setSeqRegenQuery("");
  }, [viewTab, selectedSequenceStep, campaignSteps]);

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
    if (delivery !== "not_queued") return DELIVERY_BUCKET_LABELS[delivery];
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
  async function openBulkRegenerate(campaignLeadIds?: string[]) {
    setBulkRegenOpening(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const preview = await previewRegeneration(session.access_token, campaign.id, campaignLeadIds);
      if (preview.eligible === 0) {
        toast.info("No drafts are eligible — certified and sent emails are not regenerated in bulk.");
        return;
      }
      setBulkRegenPreview({
        counts: preview.by_status,
        skipped: preview.skipped,
        isSubset: !!campaignLeadIds?.length,
        campaignLeadIds,
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

  async function handleSaveSeqDraft() {
    if (!activeSeqStep || !canEditSettings) return;
    setSeqStepSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const stepNum = activeSeqStep.step_order;
      const subject =
        seqSubjectEdit.trim() === LEGACY_MISLEADING_FOLLOWUP_SUBJECT ? "" : seqSubjectEdit;
      const updatedSteps = campaignSteps.map((s) =>
        s.step_order === stepNum
          ? { ...s, subject, body: seqBodyEdit }
          : s,
      );
      await saveCampaignSteps(session.access_token, campaign.id, updatedSteps);
      setCampaignSteps(updatedSteps);
      toast.success("Saved");
    } catch (e) {
      toast.error("Failed to save: " + (e as Error).message);
    } finally {
      setSeqStepSaving(false);
    }
  }

  async function handleRegenerateSeqDraft() {
    if (!activeSeqStep || !canEditSettings) return;
    setSeqRegenerating(true);
    setSeqRegenOpen(false);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const { body } = await regenerateFollowUpStepTemplate(
        session.access_token,
        campaign.id,
        activeSeqStep.step_order,
        seqBodyEdit,
        seqRegenQuery || undefined,
      );
      setSeqBodyEdit(body);
      setSeqRegenQuery("");
      toast.success("Follow-up regenerated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSeqRegenerating(false);
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
      toast.success("Replacement added — writing their email now");
      await loadData();
      // Land the user on the new contact: their draft is what needs certifying.
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

  // Applied before the split into list/kanban so BOTH views honour the filter.
  const sortedCampaignLeads = sortCampaignLeads(campaignLeads, leadsSort)
    .filter((cl) => leadsDelivery === "all" || deliveryBucket(cl) === leadsDelivery);

  const filteredLeads = sortedCampaignLeads.filter((cl) => {
    if (!leadsSearch) return true;
    const name = [cl.leads?.first_name, cl.leads?.last_name].filter(Boolean).join(" ").toLowerCase();
    const email = (cl.leads?.email ?? "").toLowerCase();
    const q = leadsSearch.toLowerCase();
    return name.includes(q) || email.includes(q);
  });

  const selectedThread = threads.find((t) => t.campaign_lead_id === selectedId) ?? null;

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
    /** Instantly id — set only for inbound messages, which alone can be answered. */
    replyTargetId: string | null;
    isUnanswered: boolean;
    /** Sender of the message this reply answered, for our own sent mail. */
    inReplyToLabel: string | null;
    /** Third participant not yet a lead — the address to promote. */
    promotableEmail: string | null;
    timestamp: string | null;
    bodyHtml: string | null;
    bodyText: string | null;
  };

  const outboxLeadAddress = parseAddressList(selectedThread?.lead_email ?? null)[0] ?? null;
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

  // Participant view of the thread, shared with the Unibox so both surfaces
  // agree on who is owed a reply.
  const outboxParticipantMessages = selectedThread
    ? [
        ...selectedThread.messages.map((m) => ({
          instantly_email_id: m.instantly_email_id,
          direction: "received",
          from_email: m.from_email,
          to_emails: m.to_emails,
          cc_emails: m.cc_emails,
          timestamp_email: m.received_at,
        })),
        ...selectedThread.sent_messages.map((m) => ({
          instantly_email_id: m.instantly_email_id,
          direction: "sent_manual",
          from_email: m.from_email,
          to_emails: m.to_emails,
          cc_emails: m.cc_emails,
          timestamp_email: m.sent_at,
        })),
      ]
    : [];
  const outboxOurEmails = ourAddresses(outboxParticipantMessages, [selectedThread?.eaccount ?? null]);
  const outboxUnansweredIds = new Set(
    unansweredInbound(outboxParticipantMessages, outboxOurEmails).map((m) => m.instantly_email_id),
  );
  // The message the composer answers — an explicit pick, else the newest
  // inbound one. Restricted to inbound: replying to our own sent mail would
  // address it straight back at us.
  const outboxActiveTarget =
    outboxParticipantMessages.find(
      (m) => m.direction === "received" && m.instantly_email_id === outboxReplyTargetId,
    ) ?? latestInboundMessage(outboxParticipantMessages);
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

  const outboxMessageItems: OutboxMessageItem[] = [];
  if (selected?.email_drafts?.status === "sent") {
    outboxMessageItems.push({
      id: `initial-${selected.email_drafts.id}`,
      sender: "You",
      to: selectedThread?.lead_email ?? outboxReplyName,
      cc: "",
      fromThirdParty: false,
      replyTargetId: null,
      isUnanswered: false,
      inReplyToLabel: null,
      promotableEmail: null,
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
        isUnanswered: outboxUnansweredIds.has(msg.instantly_email_id),
        inReplyToLabel: null,
        promotableEmail:
          thirdParty && from && !outboxKnownLeadSet.has(from) && !outboxOurEmails.has(from) ? from : null,
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
      outboxMessageItems.push({
        id: `sent-${sent.id}`,
        sender: sent.sent_by_name ?? "You",
        to: parseAddressList(sent.to_emails).join(", "),
        cc: parseAddressList(sent.cc_emails).join(", "),
        fromThirdParty: false,
        replyTargetId: null,
        isUnanswered: false,
        inReplyToLabel: sent.in_reply_to_email_id
          ? outboxSenderByEmailId.get(sent.in_reply_to_email_id) ?? null
          : null,
        promotableEmail: null,
        timestamp: sent.sent_at,
        bodyHtml: sent.body_html,
        bodyText: sent.body_text,
      });
    }
    outboxMessageItems.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  }
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
  // order/count shifts per campaign.
  const PIPELINE_STAGE_STYLE: Record<string, { fill: string; opacity: number }> = {
    pending:  { fill: "var(--muted-foreground)", opacity: 0.35 },
    draft:    { fill: "var(--primary)", opacity: 1 },
    approved: { fill: "var(--primary)", opacity: 1 },
    sent:     { fill: "var(--primary)", opacity: 1 },
    replied:  { fill: "#22c55e", opacity: 1 },
  };
  const pipelineData = report && report.stageDistribution.length > 0
    ? report.stageDistribution.map((s) => ({ name: s.label, value: s.count, ...(PIPELINE_STAGE_STYLE[s.stage] ?? { fill: "var(--primary)", opacity: 1 }) }))
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

  const stepPerformancePct = stepPerformance.map((s) => ({
    name: `Email ${s.step}`,
    sent: s.sent,
    total: s.total,
    pct: s.total > 0 ? Math.round((s.sent / s.total) * 100) : 0,
  }));

  const OUTBOX_FILTERS: Array<{ id: typeof outboxFilter; label: string }> = [
    { id: "all",       label: "All" },
    { id: "action",    label: "Needs action" },
    { id: "certified", label: "Certified" },
    { id: "sending",   label: "Sending" },
    { id: "sent",      label: "Sent" },
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
                disabled={certifying}
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
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                {[
                  { label: "Leads",      value: analyticsTotalLeads, icon: Users,          accent: "" },
                  // Sent / Replied / Bounced are exclusive outcomes of the same
                  // delivered mail — they add up to the delivered total shown as
                  // Sent's sub-line, and no lead is counted in two of them.
                  { label: "Sent",       value: analyticsSent,       icon: Send,           accent: "", sub: `${analyticsDelivered} delivered` },
                  { label: "Replied",    value: analyticsReplied,    icon: MessageSquare,  accent: "", sub: `${analyticsReplyRate}% reply rate` },
                  { label: "Bounced",    value: analyticsBounced,    icon: AlertTriangle,  accent: "red" },
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
                <div className="swatch-bar-top rounded-xl border border-border bg-card p-4">
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
                <div className="swatch-bar-top rounded-xl border border-border bg-card p-4">
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
                <div className="swatch-bar-top rounded-xl border border-border bg-card p-4">
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

              {/* Sequence step performance + Replied vs Sent */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                {stepPerformancePct.length > 0 && (
                  <div className="rounded-xl border border-border bg-card p-4 lg:col-span-2">
                    <div className="flex items-center gap-1.5 mb-1">
                      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Sequence step performance</p>
                      <InfoTip
                        side="right"
                        text="Each row is one email in this campaign's sequence — Email 1 is the initial outreach, Email 2 is the first follow-up, and so on. The bar shows what percentage of leads at that step have been handed to Instantly. Instantly then drips the actual sends out at the campaign's daily limit, so this runs ahead of the Sent tile above."
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground mb-3">% of leads queued to Instantly, per email in the sequence</p>
                    <div className="space-y-3">
                      {stepPerformancePct.map((s) => (
                        <div key={s.name}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-medium">{s.name}</span>
                            <span className="text-muted-foreground tabular-nums">{s.sent}/{s.total} queued · {s.pct}%</span>
                          </div>
                          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${s.pct}%`, background: "var(--primary)" }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Replied vs Sent */}
                <div className="rounded-xl border border-border bg-card p-4">
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
            <Select value={leadsDelivery} onValueChange={(v) => setLeadsDelivery(v as DeliveryBucket | "all")}>
              <SelectTrigger className="h-8 w-36 gap-2 rounded-md px-3 text-xs shadow-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-36">
                <SelectItem value="all">All ({campaignLeads.length})</SelectItem>
                {(["sending", "sent", "replied", "bounced"] as const)
                  .filter((b) => (deliveryCounts[b] ?? 0) > 0)
                  .map((b) => (
                    <SelectItem key={b} value={b}>
                      {DELIVERY_BUCKET_LABELS[b]} ({deliveryCounts[b] ?? 0})
                    </SelectItem>
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
                                  pills.push({ label: DELIVERY_BUCKET_LABELS[delivery], cls: DELIVERY_PILL_CLS[delivery] });
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
                              {/* The only action a bounce allows: try another
                                  address at the same company — until someone
                                  has, at which point it reads as handled so the
                                  next person doesn't do it twice. */}
                              {deliveryBucket(cl) === "bounced" && (
                                cl.replaced_by_lead_id ? (
                                  <span
                                    title={replacedTooltip(cl)}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-500/15 border border-green-500/30 font-mono text-[10px] font-semibold uppercase tracking-wide text-green-600"
                                  >
                                    <Check className="size-3" />
                                    Replaced
                                  </span>
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
          <div className="w-[266px] shrink-0 border-r border-border bg-field dark:bg-card flex flex-col">
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
                  className="size-7 shrink-0 bg-secondary/30 text-muted-foreground hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3", syncingReplies && "animate-spin")} />
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="icon"
                  title="Open in Unibox"
                  className="size-7 shrink-0 bg-secondary/30 text-muted-foreground hover:text-primary"
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
                      disabled={certifying}
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
            <div className="flex-1 overflow-y-auto divide-y divide-border/40">
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
                        "h-auto w-full block justify-start text-left font-normal rounded-none pl-12 pr-4 py-3",
                        isActive ? "bg-primary/8 hover:bg-primary/8 border-l-2 border-l-primary" : "hover:bg-secondary/40 border-l-2 border-l-transparent",
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
                    ? { label: DELIVERY_BUCKET_LABELS[delivery], cls: DELIVERY_PILL_CLS[delivery] }
                    : statusConfig[status] ?? statusConfig.none;
                const showCheckbox = status !== "sent" && delivery === "not_queued";
                const canCheck = showCheckbox;
                return (
                  <div
                    key={cl.id}
                    className={cn(
                      "flex items-center cursor-pointer border-l-2 transition-colors",
                      isActive ? "bg-primary/10 border-primary" : "border-transparent hover:bg-secondary/40",
                    )}
                    onClick={() => setSelectedId(cl.id)}
                  >
                    <div
                      className="w-9 shrink-0 py-3 pl-4 flex items-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!canCheck || !showCheckbox) return;
                        setCheckedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(cl.id)) next.delete(cl.id); else next.add(cl.id);
                          return next;
                        });
                      }}
                    >
                      {showCheckbox ? (
                        <AppCheckbox
                          checked={isChecked && canCheck}
                          disabled={!canCheck}
                        />
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 flex-1 min-w-0 py-3 pl-3 pr-3">
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

                {/* Initial email — editor while pending, bubble once sent */}
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
                          <Button className="gap-1.5" disabled={certifying} onClick={() => handleCertifyOne(selected.email_drafts!.id)}>
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

                {/* Reply to the latest inbound message. Opens a plain composer;
                    the AI only writes a draft when "AI draft" is pressed. */}
                {selectedThread && (() => {
                  const lastMsg = selectedThread.messages[selectedThread.messages.length - 1] ?? null;
                  if (!lastMsg) return null;
                  const latestDraft = lastMsg.reply_drafts[lastMsg.reply_drafts.length - 1] ?? null;
                  const hasDraftReady = !!latestDraft && latestDraft.status !== "generating" && latestDraft.status !== "sent" && latestDraft.status !== "rejected";
                  const isGenerating = latestDraft?.status === "generating" || outboxNewReplyLoading;
                  const campaignLeadId = selectedThread.campaign_lead_id;

                  // Same participant model as the Unibox: reply-all by default,
                  // recipients shown literally, and the target chosen per
                  // message. Without this the composer answers whoever spoke
                  // last and silently drops everyone else, the lead included.
                  const outboxParticipants = threadParticipants(outboxParticipantMessages, {
                    ourEmails: outboxOurEmails,
                    leadEmail: selectedThread.lead_email,
                  });
                  // Reply all puts every participant in To (Instantly's
                  // additional_recipients); plain Reply addresses only the
                  // sender of the message being answered.
                  const outboxTo = replyRecipients(outboxActiveTarget, outboxParticipants);
                  const outboxRecipientsCtx: ReplyRecipientContext = {
                    to: outboxReplyAll ? [...outboxTo.to, ...outboxTo.cc] : outboxTo.to,
                    lockedTo: outboxTo.to[0] ?? null,
                    participants: outboxParticipants.map((p) => p.email),
                    leadEmail: selectedThread.lead_email,
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
                              threadId={selectedThread.thread_key}
                              token={appSession?.access_token ?? ""}
                              replyToSubject={selectedThread.original_email?.subject ?? null}
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
          {/* Left panel: step list */}
          <div className="w-72 shrink-0 border-r border-border flex flex-col overflow-y-auto p-4 gap-2">
            {sequencesLoading ? (
              <div className="space-y-2 animate-pulse">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="border border-border rounded-lg p-4 space-y-2">
                    <div className="h-3 w-16 bg-secondary rounded" />
                    <div className="h-3 w-32 bg-secondary/60 rounded" />
                  </div>
                ))}
              </div>
            ) : seqFollowUpSteps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No follow-up steps configured. Add them in Options.</p>
            ) : (
              seqFollowUpSteps.map((s) => {
                const isActive = selectedSequenceStep === s.step_order;
                const prevStep = campaignSteps.find((p) => p.step_order === s.step_order - 1);
                const subtitle = sequenceStepSubtitle(s, campaignLeads);
                const displayStep = sequenceDisplayStep(s.step_order);
                return (
                  <Button
                    key={s.step_order}
                    type="button"
                    variant="ghost"
                    onClick={() => setSelectedSequenceStep(s.step_order)}
                    className={cn(
                      "h-auto w-full block border rounded-lg p-4 text-left font-normal",
                      isActive
                        ? "swatch-bar border-primary bg-primary/10 hover:bg-primary/10"
                        : "border-border bg-field hover:bg-field hover:border-primary/40",
                    )}
                  >
                    <p className={cn("font-display text-sm font-semibold mb-0.5", isActive ? "text-primary" : "text-foreground")}>
                      Step {displayStep}
                    </p>
                    {subtitle && (
                      <p className={cn("text-xs truncate mb-1", isActive ? "text-primary/80" : "text-muted-foreground")}>{subtitle}</p>
                    )}
                    {prevStep && prevStep.delay > 0 && (
                      <p className={cn("font-mono text-[11px] tabular-nums", isActive ? "text-primary/60" : "text-muted-foreground/70")}>
                        Send {prevStep.delay} {prevStep.delay_unit} after previous
                      </p>
                    )}
                  </Button>
                );
              })
            )}
          </div>

          {/* Right panel: editable step email */}
          <div className="flex-1 overflow-y-auto p-6">
            {!activeSeqStep ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                Select a step to preview
              </div>
            ) : (
              <div className="max-w-2xl mx-auto space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold text-foreground">
                      Step {sequenceDisplayStep(activeSeqStep.step_order)}
                    </span>
                    {(() => {
                      const prev = campaignSteps.find((p) => p.step_order === activeSeqStep.step_order - 1);
                      return prev && prev.delay > 0 ? (
                        <span className="font-mono text-[10px] tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          Sends {prev.delay} {prev.delay_unit} after previous
                        </span>
                      ) : null;
                    })()}
                  </div>
                  {seqHasContent && canEditSettings && (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSeqRegenOpen((o) => !o)}
                        disabled={seqRegenerating}
                        className="h-7 gap-1.5 px-3 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3"
                      >
                        <RotateCcw />
                        Regenerate
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={seqStepSaving || seqRegenerating}
                        onClick={() => void handleSaveSeqDraft()}
                        className="h-7 gap-1.5 px-3 text-xs [&_svg]:size-3"
                      >
                        {seqStepSaving ? <Loader2 className="animate-spin" /> : <Save />}
                        Save
                      </Button>
                    </div>
                  )}
                </div>

                {seqHasContent ? (
                  <div className="rounded-xl border border-border bg-card p-6 space-y-4">
                    {seqRegenerating ? (
                      <div className="p-4 space-y-4 animate-pulse">
                        <div className="flex items-center gap-2">
                          <Loader2 className="size-4 text-muted-foreground animate-spin" />
                          <p className="text-xs text-muted-foreground">Regenerating follow-up…</p>
                        </div>
                        <div className="h-4 w-40 bg-secondary rounded" />
                        <div className="space-y-2">
                          <div className="h-3 w-full bg-secondary rounded" />
                          <div className="h-3 w-full bg-secondary rounded" />
                          <div className="h-3 w-2/3 bg-secondary rounded" />
                        </div>
                      </div>
                    ) : (
                      <>
                    <div className="space-y-1.5">
                      <Label className="eyebrow">Subject</Label>
                      <Input
                        value={seqSubjectEdit}
                        disabled={!canEditSettings}
                        onChange={(e) => setSeqSubjectEdit(e.target.value)}
                        placeholder="No subject (threaded reply)"
                        className="text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="eyebrow">Body</Label>
                      <RichTextEditor
                        value={seqBodyEdit}
                        onChange={setSeqBodyEdit}
                        disabled={!canEditSettings}
                        minHeight={280}
                        showTemplateVars
                      />
                    </div>
                    {seqRegenOpen && canEditSettings && (
                      <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2">
                        <Input
                          value={seqRegenQuery}
                          onChange={(e) => setSeqRegenQuery(e.target.value)}
                          placeholder="Optional instruction, e.g. Make it shorter…"
                          className="text-sm"
                          onKeyDown={(e) => { if (e.key === "Enter") void handleRegenerateSeqDraft(); }}
                        />
                        <Button size="sm" disabled={seqRegenerating} onClick={() => void handleRegenerateSeqDraft()} className="gap-1.5">
                          <RotateCcw className="size-3.5" /> Regenerate
                        </Button>
                      </div>
                    )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="rounded-xl border border-border bg-card p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {`No template set for step ${sequenceDisplayStep(activeSeqStep.step_order)}.`}
                    </p>
                  </div>
                )}

                <div className="border-t border-border pt-4">
                  <SharedSettingsNotice readOnly={!canEditSettings} />
                </div>
              </div>
            )}
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
