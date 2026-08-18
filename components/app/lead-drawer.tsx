"use client";

import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Building2, Globe2, Mail, Megaphone, Users, X,
  Loader2, RefreshCw, CheckCircle2, AlertCircle, Clock,
  RotateCcw, Zap, Bot, Settings, Pencil, Phone,
  MapPin, ChevronRight, UserCog, Check, MessageSquare,
  XCircle, Send, MailCheck, MailOpen, Reply, Sparkles, BellOff, ArrowUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatChatDate, startsNewChatDay } from "@/lib/chat-format";
import { useApp } from "@/lib/app-context";
import type { Lead, EnrichmentStage, LeadStatus } from "@/lib/leads";
import { Avatar, ScoreBadge, StatusBadge } from "@/components/leads/lead-ui";
import {
  fetchLead, fetchLeadActivity, fetchLeadComments, fetchUsers, patchLead, patchOrg,
  postLeadComment, toggleLeadCommentReaction, rescrapeOrg, fetchServiceHealth,
  type Profile, type LeadActivityEvent, type LeadComment,
} from "@/lib/api-client";
import { DiscussionComment } from "@/components/app/discussion-comment";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnrichLog {
  event: string;
  source: string;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

interface EnrichStatus {
  enrichment_stage: EnrichmentStage | null;
  enrichment_status: string | null;
  enrichment_attempts: number;
  company_description: string | null;
  sells_to: string | null;
  last_error: string | null;
  logs: EnrichLog[];
}

// ── Event label map ───────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  SCRAPE_QUEUED:               "Queued for enrichment",
  SCRAPE_BATCH_STARTED:        "Batch processing started",
  SCRAPE_STARTED:              "Website scrape started",
  SCRAPE_SUCCESS:              "Website scraped successfully",
  SCRAPE_EMPTY:                "Website returned no content",
  SCRAPE_FAILED:               "Website scrape failed",
  NO_DOMAIN:                   "No website address found",
  NO_EMAILED_LEADS:            "No lead here has a usable email — scrape skipped",
  LLM_EXTRACTION_STARTED:      "Extracting company info...",
  LLM_EXTRACTION_SUCCESS:      "Company info extracted",
  LLM_EXTRACTION_PARTIAL:      "Partial info extracted",
  LLM_EXTRACTION_FAILED:       "Extraction failed",
  ENRICHMENT_COMPLETE:         "Enrichment complete",
  ENRICHMENT_FAILED:           "Enrichment failed",
  ENRICHMENT_RETRY_QUEUED:     "Temporary failure — retrying automatically",
  ENRICHMENT_FAILED_PERMANENT: "Enrichment permanently failed",
  BATCH_COMPLETE:              "All orgs processed",
};

const SOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  firecrawl: Globe2,
  claude:    Bot,
  system:    Settings,
  apollo:    Zap,
};

// ── Sub-components ────────────────────────────────────────────────────────────

// ClickUp-style property row: muted label on the left, value on the right.
function FieldRow({
  icon: Icon, label, children, align = "center",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div className={cn(
      "flex gap-3 py-2.5 min-w-0 h-full",
      align === "start" ? "items-start" : "items-center",
    )}>
      <div className={cn(
        "flex items-center gap-2 w-32 shrink-0 text-muted-foreground",
        align === "start" && "mt-0.5",
      )}>
        <Icon className="size-3.5" />
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-sm">{children}</div>
    </div>
  );
}

// Notion/ClickUp-style inline editing: the value itself IS the control.
// Double-click swaps the static text for a bare input in place; Enter or
// blur commits, Escape reverts — no separate "edit mode" or Save button.
function InlineField({
  value, placeholder, onCommit, type = "text", className, variant = "block",
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<void>;
  type?: string;
  className?: string;
  variant?: "block" | "inline";
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft  ] = useState(value);
  const [saving,  setSaving ] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "").trim()) return;
    setSaving(true);
    try {
      await onCommit(next);
    } catch { /* toasted by caller; value stays unchanged so the text reverts */ }
    finally { setSaving(false); }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        placeholder={placeholder}
        size={variant === "inline" ? Math.max(draft.length, 3) + 1 : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={cn(
          "bg-transparent outline-none border-b border-primary/70 focus:border-primary px-0.5 -mx-0.5",
          variant === "block" ? "block w-full" : "inline-block",
          className,
        )}
      />
    );
  }

  return (
    <span
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
      className={cn(
        "rounded px-1 -mx-1 cursor-text hover:bg-secondary/60 transition-colors",
        variant === "block" ? "block truncate" : "inline-block",
        !value && "text-muted-foreground/50 italic",
        saving && "opacity-60",
        className,
      )}
    >
      {saving ? "Saving…" : (value || placeholder || "\u00A0")}
    </span>
  );
}

// Same inline-edit pattern as InlineField, but for longer free-text (company
// description, sells-to) — a growing textarea instead of a single-line input,
// and Enter inserts a newline instead of committing (blur / Escape only).
function InlineTextArea({
  value, placeholder, onCommit, className,
}: {
  value: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft  ] = useState(value);
  const [saving,  setSaving ] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.select();
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  function autoGrow(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setDraft(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${e.target.scrollHeight}px`;
  }

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next === (value ?? "").trim()) return;
    setSaving(true);
    try {
      await onCommit(next);
    } catch { /* toasted by caller; value stays unchanged so the text reverts */ }
    finally { setSaving(false); }
  }

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        value={draft}
        placeholder={placeholder}
        rows={3}
        onChange={autoGrow}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        className={cn(
          "w-full resize-none bg-transparent outline-none leading-relaxed",
          "border border-primary/60 focus:border-primary rounded-lg px-2 py-1.5 -mx-2 -my-1.5",
          className,
        )}
      />
    );
  }

  return (
    <p
      onDoubleClick={() => setEditing(true)}
      title="Double-click to edit"
      className={cn(
        "rounded-lg px-2 py-1.5 -mx-2 -my-1.5 cursor-text hover:bg-secondary/60 transition-colors leading-relaxed",
        !value && "text-muted-foreground/50 italic",
        saving && "opacity-60",
        className,
      )}
    >
      {saving ? "Saving…" : (value || placeholder || "\u00A0")}
    </p>
  );
}

// Campaign pill list — one pill per campaign with a colored status dot;
// collapses to 3 rows with a "+N more" toggle so 5–6 campaigns don't blow
// up the layout.
const CRM_STATUS_DOTS: Record<string, string> = {
  draft:      "bg-zinc-400",
  pending:    "bg-amber-400",
  generating: "bg-amber-400",
  approved:   "bg-blue-400",
  sent:       "bg-sky-400",
  replied:    "bg-green-400",
  failed:     "bg-red-400",
};

function CampaignPills({ campaigns, onOpen }: {
  campaigns: { id: string; name: string; crm_status: string; added_at?: string | null }[];
  onOpen: (campaignId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? campaigns : campaigns.slice(0, 3);
  const hidden = campaigns.length - 3;
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onOpen(c.id)}
          title={`Open campaign "${c.name}"`}
          className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 pl-2.5 pr-2 py-1.5 min-w-0 text-left cursor-pointer hover:border-muted-foreground/50 hover:bg-secondary/70 transition-colors"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1 min-w-0">
              <span className="truncate text-xs font-medium group-hover:text-blue-400 transition-colors">{c.name}</span>
              <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </span>
            {c.added_at && (
              <span className="block text-[10px] text-muted-foreground mt-0.5">
                Added {formatDate(c.added_at)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span className={cn("size-1.5 rounded-full", CRM_STATUS_DOTS[c.crm_status] ?? "bg-muted-foreground/50")} />
            <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              {c.crm_status}
            </span>
          </span>
        </button>
      ))}
      {campaigns.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Compact horizontal pipeline — replaces the tall vertical stepper so the
// whole modal fits on screen without scrolling.
const H_STAGES: LeadStatus[] = ["New", "Enriched"];

function HorizontalStepper({ currentStatus }: { currentStatus: LeadStatus }) {
  const mapped: LeadStatus =
    currentStatus === "Input Required" || currentStatus === "New" || currentStatus === "Enriching" ? "New" : "Enriched";
  const current = H_STAGES.indexOf(mapped);
  return (
    <div className="flex items-center gap-2 w-full">
      {H_STAGES.map((stage, i) => {
        const done = i <= current;
        const active = i === current;
        return (
          <Fragment key={stage}>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className={cn(
                "size-4.5 rounded-full border-2 flex items-center justify-center shrink-0",
                done ? "bg-primary border-primary" : "border-border",
              )}>
                {done
                  ? <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />
                  : <span className="text-[9px] font-bold text-muted-foreground/40">{i + 1}</span>}
              </div>
              <span className={cn(
                "font-display text-[11px] font-semibold uppercase tracking-wide",
                active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/40",
              )}>
                {stage}
              </span>
            </div>
            {i < H_STAGES.length - 1 && (
              <div className={cn("h-px flex-1 min-w-6", done && !active ? "bg-primary" : "bg-border")} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function EnrichStageBadge({ stage, hasData }: { stage: EnrichmentStage | null; hasData?: boolean }) {
  if (!stage) return null;
  const doneLabel = hasData ? "Enriched" : "Done (No Data)";
  const doneCls   = hasData
    ? "bg-green-500/10 text-green-400 border-green-500/20"
    : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  const configs: Record<EnrichmentStage, { label: string; cls: string }> = {
    queued:   { label: "In Queue",         cls: "bg-secondary text-muted-foreground border-border" },
    scraping: { label: "Enriching...",      cls: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
    done:     { label: doneLabel,           cls: doneCls },
    failed:   { label: "Enrichment Failed", cls: "bg-red-500/10 text-red-400 border-red-500/20" },
  };
  const c = configs[stage];
  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full font-mono text-[10px] leading-none uppercase tracking-wider border font-semibold", c.cls)}>
      {stage === "done"     && <CheckCircle2 className="size-2.5" />}
      {stage === "failed"   && <AlertCircle  className="size-2.5" />}
      {stage === "queued"   && <Clock        className="size-2.5" />}
      {stage === "scraping" && <Loader2      className="size-2.5 animate-spin" />}
      <span className="translate-y-px">{c.label}</span>
    </span>
  );
}

function TimelineItem({ log, isLast }: { log: EnrichLog; isLast: boolean }) {
  const Icon = SOURCE_ICONS[log.source] ?? Settings;
  const label = EVENT_LABELS[log.event] ?? log.event;
  const isError = !!log.error;
  const time = new Date(log.created_at).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  return (
    <div className="flex gap-2.5 text-xs">
      <div className="flex flex-col items-center shrink-0">
        <div className={cn(
          "size-5 rounded-full flex items-center justify-center border shrink-0",
          isError
            ? "bg-red-500/10 border-red-500/20 text-red-400"
            : "bg-secondary border-border text-muted-foreground",
        )}>
          <Icon className="size-2.5" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border/60 mt-1 min-h-[12px]" />}
      </div>
      <div className={cn("min-w-0", !isLast && "pb-3")}>
        <p className={cn("font-medium leading-snug", isError ? "text-red-400" : "text-foreground")}>
          {label}
        </p>
        <div className="flex items-center gap-2 mt-0.5 text-muted-foreground font-mono text-[10px] tabular-nums">
          <span>{time}</span>
          {log.duration_ms != null && <span>· {log.duration_ms}ms</span>}
        </div>
        {log.error && (
          <p className="mt-1 text-red-400/80 font-mono text-[10px] break-all leading-relaxed">
            {log.error}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Clean lead activity item (Problem 8) ───────────────────────────────────────

const ACTIVITY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  created: Zap,
  enriched: CheckCircle2,
  enrichment_failed: AlertCircle,
  assigned: UserCog,
  reassigned: UserCog,
  unassigned: UserCog,
  added_to_campaign: Megaphone,
  removed_from_campaign: Megaphone,
  draft_created: Pencil,
  draft_failed: AlertCircle,
  draft_approved: CheckCircle2,
  draft_rejected: XCircle,
  draft_edited: Pencil,
  draft_reopened: RotateCcw,
  draft_sent: Send,
  email_delivered: MailCheck,
  email_opened: MailOpen,
  email_bounced: AlertCircle,
  reply_received: Reply,
  interest_changed: Sparkles,
  unsubscribed: BellOff,
  status_changed: RefreshCw,
};

// Events that represent something going wrong — tinted amber in the timeline
// rather than silently reading like normal progress.
const BAD_ACTIVITY_EVENTS = new Set(["enrichment_failed", "draft_failed", "email_bounced", "unsubscribed"]);

// Activity is an audit trail, so entries carry a calendar-anchored timestamp
// ("yesterday at 05:42 PM") rather than an elapsed-only label ("1d ago") —
// elapsed labels lose the time of day, which is what you need when
// reconstructing the order things actually happened in.
function activityTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;

  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true,
  });

  // Compare calendar days in local time — a diff in hours would call 11pm
  // yesterday "today" when read at 1am.
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);

  if (dayDelta === 0) return `today at ${time}`;
  if (dayDelta === 1) return `yesterday at ${time}`;

  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${date} at ${time}`;
}

// Full timestamp for the hover tooltip, so an exact value is always reachable.
function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function ActivityItem({ event, isLast, onCampaignClick }: {
  event: LeadActivityEvent;
  isLast: boolean;
  onCampaignClick?: (campaignId: string) => void;
}) {
  const Icon = ACTIVITY_ICONS[event.event] ?? Clock;
  const isBad = BAD_ACTIVITY_EVENTS.has(event.event);

  // If the event references a campaign, render its name as a link — either
  // inline (when the detail text quotes the name) or appended after the text.
  const detailText = event.detail ?? event.event;
  const canLink = !!(event.campaign_id && event.campaign_name && onCampaignClick);
  const quoted = canLink ? `"${event.campaign_name}"` : "";
  const inline = canLink && detailText.includes(quoted);
  const [before, after] = inline ? detailText.split(quoted) : [detailText, ""];

  const campaignLink = canLink && (
    <button
      type="button"
      onClick={() => onCampaignClick!(event.campaign_id!)}
      className="text-blue-400 hover:underline font-medium"
      title={`Open campaign "${event.campaign_name}"`}
    >
      {inline ? quoted : event.campaign_name}
    </button>
  );

  return (
    <div className="flex gap-2.5 text-xs">
      <div className="flex flex-col items-center shrink-0">
        <div className={cn(
          "size-5 rounded-full flex items-center justify-center border shrink-0",
          isBad ? "bg-amber-500/10 border-amber-500/20 text-amber-400" : "bg-secondary border-border text-muted-foreground",
        )}>
          <Icon className="size-2.5" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border/60 mt-1 min-h-[12px]" />}
      </div>
      <div className={cn("min-w-0", !isLast && "pb-3")}>
        <p className="font-medium leading-snug text-foreground">
          {inline ? <>{before}{campaignLink}{after}</> : detailText}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-muted-foreground">
          <span title={fullTimestamp(event.created_at)}>{activityTimestamp(event.created_at)}</span>
          {event.actor_name && <span>· by {event.actor_name}</span>}
          {canLink && !inline && <span>· in {campaignLink}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton loading state ────────────────────────────────────────────────────

function Bone({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-secondary", className)} />;
}

function LeadDrawerSkeleton() {
  return (
    <>
      {/* Left column */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-10 pb-4 shrink-0">
          <Bone className="size-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Bone className="h-5 w-48" />
          </div>
        </div>

        {/* Property rows */}
        <div className="flex-1 px-6 pb-5 space-y-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-2 gap-x-12 border-b border-border/40 last:border-0">
              <div className="flex items-center gap-2 py-3">
                <Bone className="size-3.5 rounded shrink-0" />
                <Bone className="h-3 w-16" />
                <Bone className="h-4 w-28 ml-auto" />
              </div>
              <div className="flex items-center gap-2 py-3">
                <Bone className="size-3.5 rounded shrink-0" />
                <Bone className="h-3 w-16" />
                <Bone className="h-4 w-36 ml-auto" />
              </div>
            </div>
          ))}

          {/* Company enrichment skeleton */}
          <div className="border-t border-border pt-4 mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <Bone className="size-3 rounded" />
              <Bone className="h-3 w-32" />
              <Bone className="h-5 w-20 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Bone className="h-3 w-20" />
                <Bone className="h-4 w-full" />
                <Bone className="h-4 w-3/4" />
              </div>
              <div className="space-y-2">
                <Bone className="h-3 w-24" />
                <Bone className="h-4 w-full" />
                <Bone className="h-4 w-2/3" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right rail */}
      <div className="w-[340px] max-lg:w-[280px] max-sm:hidden shrink-0 border-l border-border bg-secondary/20 flex flex-col min-h-0">
        <div className="flex items-center px-3 py-2.5 border-b border-border shrink-0">
          <Bone className="h-7 w-48 rounded-lg" />
          <Bone className="size-7 rounded-lg ml-auto" />
        </div>
        <div className="flex-1 p-5 space-y-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-2.5">
              <Bone className="size-5 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Bone className="h-3.5 w-3/4" />
                <Bone className="h-2.5 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────

export function LeadDrawer({ lead, onClose, onLeadUpdated, onOrgClick }: {
  lead: Lead | null;
  onClose: () => void;
  onLeadUpdated?: (updated: Lead) => void;
  onOrgClick?: (orgId: string) => void;
}) {
  const { role, session } = useApp();
  const router = useRouter();
  const [freshLead,   setFreshLead  ] = useState<Lead | null>(null);
  const [loadingLead, setLoadingLead] = useState(false);
  const [enrichData,  setEnrichData ] = useState<EnrichStatus | null>(null);
  const [activity,    setActivity   ] = useState<LeadActivityEvent[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [railMode,    setRailMode   ] = useState<"activity" | "discussion">("activity");
  const [comments,    setComments   ] = useState<LeadComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [loadingComments, setLoadingComments] = useState(false);
  const [sendingComment,  setSendingComment ] = useState(false);
  const [retrying,    setRetrying   ] = useState(false);
  const [employees,   setEmployees  ] = useState<Profile[]>([]);
  const [reassigning, setReassigning] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement | null>(null);

  // Tracks the lead id the drawer is currently showing so in-flight fetches
  // can't update state / call onLeadUpdated after the user has closed it.
  const activeLeadIdRef = useRef<string | null>(null);
  activeLeadIdRef.current = lead?.id ?? null;

  const display = freshLead ?? lead;

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  const fetchFresh = useCallback(async (l: Lead) => {
    setLoadingLead(true);
    try {
      const tok = await getToken();
      if (!tok) return;
      const updated = await fetchLead(tok, l.id);
      if (activeLeadIdRef.current !== l.id) return;
      setFreshLead(updated);
      onLeadUpdated?.(updated);
    } catch { /* keep stale */ }
    finally {
      if (activeLeadIdRef.current === l.id) setLoadingLead(false);
    }
  }, [onLeadUpdated]);

  const fetchEnrichStatus = useCallback(async (orgId: string) => {
    try {
      const tok = await getToken();
      if (!tok) return;
      const res = await fetch(`/api/enrich/status?org_id=${orgId}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const json = await res.json() as { success: boolean; data?: EnrichStatus };
      if (activeLeadIdRef.current == null) return;
      if (json.success && json.data) setEnrichData(json.data);
    } catch { /* non-fatal */ }
  }, []);

  const fetchActivity = useCallback(async (leadId: string) => {
    setLoadingActivity(true);
    try {
      const tok = await getToken();
      if (!tok) return;
      const events = await fetchLeadActivity(tok, leadId);
      if (activeLeadIdRef.current !== leadId) return;
      setActivity(events);
    } catch { /* non-fatal */ }
    finally { if (activeLeadIdRef.current === leadId) setLoadingActivity(false); }
  }, []);

  const loadComments = useCallback(async (leadId: string, quiet = false) => {
    if (!quiet) setLoadingComments(true);
    try {
      const tok = await getToken();
      if (!tok) return;
      const next = await fetchLeadComments(tok, leadId);
      if (activeLeadIdRef.current !== leadId) return;
      setComments((current) => {
        if (!quiet) return next;
        const byId = new Map(current.map((comment) => [comment.id, comment]));
        for (const comment of next) byId.set(comment.id, comment);
        return [...byId.values()].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
      });
    } catch (error) {
      if (!quiet) toast.error((error as Error).message || "Could not load the discussion");
    } finally {
      if (!quiet && activeLeadIdRef.current === leadId) setLoadingComments(false);
    }
  }, []);

  async function handleSendComment() {
    if (!display || sendingComment || !commentBody.trim()) return;
    const body = commentBody.trim();
    setSendingComment(true);
    try {
      const tok = await getToken();
      const comment = await postLeadComment(tok, display.id, body);
      setComments((current) => [...current, comment]);
      setCommentBody("");
    } catch (error) {
      toast.error((error as Error).message || "Could not send the message");
    } finally {
      setSendingComment(false);
    }
  }

  async function handleToggleCommentReaction(commentId: string, emoji: string) {
    if (!display) return;
    try {
      const tok = await getToken();
      const reactions = await toggleLeadCommentReaction(tok, display.id, commentId, emoji);
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

  // Notion/ClickUp-style field save: each InlineField commits its own patch
  // the moment it loses focus, no separate "edit mode" or Save button.
  async function saveField(patch: Record<string, string>, label: string) {
    if (!display) return;
    try {
      const tok = await getToken();
      const updated = await patchLead(tok, display.id, patch);
      setFreshLead(updated);
      onLeadUpdated?.(updated);
    } catch (e) {
      toast.error((e as Error).message || `Couldn't update ${label}`);
      throw e;
    }
  }

  // Company description / sells-to belong to the organization, not the lead —
  // they're shared across every lead under that org (review §3.4), so the
  // edit is written to the org record and the enrichment panel re-synced from
  // there rather than patched onto this one lead.
  async function saveOrgField(patch: Record<string, string>, label: string) {
    if (!display?.orgId) return;
    try {
      const tok = await getToken();
      await patchOrg(tok, display.orgId, patch);
      await fetchEnrichStatus(display.orgId);
    } catch (e) {
      toast.error((e as Error).message || `Couldn't update ${label}`);
      throw e;
    }
  }

  // Single-lead reassignment (manager-only) — previously the only way to move
  // one lead was bulk-assign or a campaign-assign side effect (review §3.2).
  useEffect(() => {
    if (role !== "manager") return;
    getToken().then((tok) => fetchUsers(tok)).then((users) => {
      setEmployees(users.filter((u) => u.role === "employee" && u.is_active));
    }).catch(() => {});
  }, [role]);

  async function handleReassign(nextAssignee: string | null) {
    if (!display || reassigning) return;
    setReassigning(true);
    try {
      const tok = await getToken();
      const updated = await patchLead(tok, display.id, { assigned_to: nextAssignee });
      setFreshLead(updated);
      onLeadUpdated?.(updated);
      toast.success(nextAssignee ? "Lead reassigned" : "Lead returned to the pool");
      if (updated.manual_target_offline) {
        toast.warning("Heads up: that employee is currently marked offline (away).");
      }
    } catch (e) {
      toast.error((e as Error).message || "Failed to reassign lead");
    } finally {
      setReassigning(false);
    }
  }

  useEffect(() => {
    if (!lead) {
      setFreshLead(null);
      setEnrichData(null);
      setActivity([]);
      setComments([]);
      setCommentBody("");
      setRailMode("activity");
      return;
    }
    setFreshLead(null);
    setEnrichData(null);
    setActivity([]);
    setComments([]);
    setCommentBody("");
    setRailMode("activity");
    void fetchFresh(lead);
    void fetchActivity(lead.id);
    // Quiet prefetch so the Discussion tab / chat icon can show a message
    // count without the user having to open the tab first.
    void loadComments(lead.id, true);
    if (lead.orgId) void fetchEnrichStatus(lead.orgId);
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!lead || railMode !== "discussion") return;
    void loadComments(lead.id);
    const interval = window.setInterval(() => void loadComments(lead.id, true), 10000);
    return () => window.clearInterval(interval);
  }, [lead?.id, railMode, loadComments]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (railMode !== "discussion") return;
    commentsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [comments, railMode]);

  useEffect(() => {
    if (!lead) return;
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lead, onClose]);

  async function handleRetry() {
    if (!display?.orgId) return;
    setRetrying(true);
    try {
      const tok = await getToken();
      await rescrapeOrg(tok, display.orgId);
      setTimeout(async () => {
        if (display.orgId) await fetchEnrichStatus(display.orgId);
        if (lead) await fetchFresh(lead);
        // A retry that still fails is almost always billing, not a dead
        // website — surface the real upstream cause instead of letting the
        // generic "couldn't read website" copy mislead the manager again.
        fetchServiceHealth(tok)
          .then((issues) => {
            const openrouter = issues.find((i) => i.service === "OpenRouter");
            const firecrawl = issues.find((i) => i.service === "Firecrawl");
            if (openrouter) toast.error(openrouter.message);
            if (firecrawl) toast.error(firecrawl.message);
          })
          .catch(() => {});
      }, 800);
    } catch { /* non-fatal */ }
    finally { setRetrying(false); }
  }

  const open = lead !== null;
  const currentStage = enrichData?.enrichment_stage ?? display?.enrichmentStage ?? null;
  const attempts = enrichData?.enrichment_attempts ?? 0;
  const enrichHasData = !!((enrichData?.company_description || display?.companyDescription));

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />

      {/* Modal */}
      <div className={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        "w-[1240px] max-w-[96vw] h-[86vh] max-h-[880px]",
        "bg-card border border-border rounded-2xl shadow-2xl overflow-hidden",
        "flex transition-all duration-200 ease-out",
        open ? "opacity-100 scale-100" : "opacity-0 scale-95 pointer-events-none",
      )}>
        {!display && open && (
          <LeadDrawerSkeleton />
        )}
        {display && (
          <>
            {/* ── Left column: header + details ── */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">

            {/* Header — just the person */}
            <div className="swatch-bar-top flex items-center gap-3 px-6 pt-10 pb-4 shrink-0">
              <Avatar name={`${display.firstName} ${display.lastName}`} size="md" />
              <h2 className="flex-1 min-w-0 flex items-baseline gap-1.5 font-display text-xl font-semibold">
                <InlineField
                  value={display.firstName}
                  placeholder="First name"
                  variant="inline"
                  className="font-display text-xl font-semibold"
                  onCommit={(v) => saveField({ first_name: v }, "first name")}
                />
                <InlineField
                  value={display.lastName}
                  placeholder="Last name"
                  variant="inline"
                  className="font-display text-xl font-semibold"
                  onCommit={(v) => saveField({ last_name: v }, "last name")}
                />
              </h2>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setRailMode("discussion")}
                  className={cn(
                    "relative size-7 rounded-lg text-muted-foreground hover:text-foreground",
                    railMode === "discussion" && "bg-secondary text-foreground",
                  )}
                  title="Open lead discussion"
                  aria-label="Open lead discussion"
                >
                  <MessageSquare className="size-3.5" />
                  {comments.length > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] rounded-full bg-primary text-primary-foreground font-mono text-[9px] font-bold tabular-nums flex items-center justify-center px-0.5 leading-none">
                      {comments.length > 99 ? "99+" : comments.length}
                    </span>
                  )}
                </Button>
                {/* Close lives in the activity rail; this one only shows when
                    the rail is hidden on very small screens */}
                <Button
                  type="button" variant="ghost" size="icon" onClick={onClose}
                  className="size-7 rounded-lg text-muted-foreground hover:text-foreground sm:hidden"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            {/* Details — flex column sized to fit without scrolling;
                only the enrichment section scrolls internally if its text is long */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-y-auto px-6 pb-5 gap-4">

              {/* ── ClickUp/Notion-style property rows — every value below is
                  directly editable in place (double-click to edit, blur/Enter
                  to save), two columns with dividers aligned across both ── */}
              {(() => {
                const leftFields: React.ReactNode[] = [
                  <FieldRow key="status" icon={Zap} label="Status">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={display.status} />
                      {display.score !== "—" && <ScoreBadge score={display.score} />}
                    </div>
                  </FieldRow>,
                  <FieldRow key="pipeline" icon={Users} label="Pipeline">
                    <HorizontalStepper currentStatus={display.status} />
                  </FieldRow>,
                ];
                if (role === "manager") {
                  leftFields.push(
                    <FieldRow key="owner" icon={UserCog} label="Owner">
                      <Select
                        value={display.assignedTo ?? "unassigned"}
                        onValueChange={(v) => void handleReassign(v === "unassigned" ? null : v)}
                        disabled={reassigning}
                      >
                        <SelectTrigger className="bg-transparent border-0 shadow-none h-7 px-0 text-sm font-medium hover:text-foreground focus:ring-0 w-auto gap-1.5">
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Unassigned (pool)</SelectItem>
                          {employees.map((e) => (
                            <SelectItem key={e.id} value={e.id}>{e.full_name || e.email}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FieldRow>,
                  );
                }
                leftFields.push(
                  <FieldRow key="org" icon={Building2} label="Organization" align="start">
                    {display.company ? (
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => display.orgId && onOrgClick?.(display.orgId)}
                          disabled={!display.orgId || !onOrgClick}
                          className="group flex items-center gap-1 font-medium hover:text-blue-400 transition-colors disabled:hover:text-foreground max-w-full"
                        >
                          <span className="truncate">{display.company}</span>
                          {display.orgId && onOrgClick && (
                            <ChevronRight className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                          )}
                        </button>
                        {display.domain && (
                          <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                            <a href={/^https?:\/\//i.test(display.domain) ? display.domain : `https://${display.domain}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-400 hover:underline truncate">{display.domain}</a>
                            {display.domainSource === "email_inferred" && (
                              <span className="text-[9px] font-medium uppercase tracking-wide text-amber-500/80 border border-amber-500/30 rounded px-1 py-0.5 shrink-0">Inferred</span>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50 italic text-xs">No organization</span>
                    )}
                  </FieldRow>,
                  <FieldRow key="campaigns" icon={Megaphone} label="Campaigns" align="start">
                    {display.campaigns && display.campaigns.length > 0 ? (
                      <CampaignPills
                        campaigns={display.campaigns}
                        onOpen={(campaignId) => {
                          onClose();
                          router.push(`/campaigns/${campaignId}`);
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground/50 italic text-xs">Not in any campaign</span>
                    )}
                  </FieldRow>,
                );

                const rightFields: React.ReactNode[] = [
                  <FieldRow key="email" icon={Mail} label="Email">
                    <InlineField
                      value={display.email}
                      placeholder="Not yet enriched"
                      type="email"
                      className="font-mono text-xs"
                      onCommit={(v) => v ? saveField({ email: v }, "email") : Promise.resolve()}
                    />
                  </FieldRow>,
                  <FieldRow key="phone" icon={Phone} label="Phone">
                    <InlineField
                      value={display.phone}
                      placeholder="Add phone"
                      type="tel"
                      className="font-mono text-xs"
                      onCommit={(v) => saveField({ phone: v }, "phone")}
                    />
                  </FieldRow>,
                  <FieldRow key="title" icon={Pencil} label="Job title">
                    <InlineField
                      value={display.jobTitle}
                      placeholder="Add job title"
                      onCommit={(v) => saveField({ title: v }, "job title")}
                    />
                  </FieldRow>,
                  <FieldRow key="country" icon={MapPin} label="Country">
                    <InlineField
                      value={display.country}
                      placeholder="Add country"
                      onCommit={(v) => saveField({ country: v }, "country")}
                    />
                  </FieldRow>,
                  <FieldRow key="source" icon={Globe2} label="Source">
                    <span className="inline-flex items-center font-mono text-[10px] text-muted-foreground bg-secondary px-2 py-0.5 rounded-full border border-border">
                      {display.source}
                    </span>
                  </FieldRow>,
                  <FieldRow key="created" icon={Clock} label="Created">
                    {formatDate(display.createdAt)}
                  </FieldRow>,
                ];

                const rowCount = Math.max(leftFields.length, rightFields.length);
                return (
                  <div className="shrink-0">
                    {Array.from({ length: rowCount }).map((_, i) => (
                      <div key={i} className="grid grid-cols-2 gap-x-12 border-b border-border/40 last:border-0">
                        <div className="min-w-0">{leftFields[i]}</div>
                        <div className="min-w-0">{rightFields[i]}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* ── Company Enrichment — fills the rest of the modal; scrolls
                     internally only when descriptions are very long ── */}
              <div className="border-t border-border pt-4 flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between pb-3 shrink-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Building2 className="size-3 text-muted-foreground" />
                    <span className="eyebrow">Company Enrichment</span>
                    <EnrichStageBadge stage={currentStage} hasData={enrichHasData} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Rescraping spends credits — manager-only. Employees work
                        their leads as given; enrichment is the manager's job
                        (planning.md D8 / Q6). */}
                    {/* No attempts<3 gate: the 3-attempt cap is for the
                        automatic-retry loop only. A manually clicked retry
                        always gets a fresh budget server-side (see rescrape
                        route) — otherwise a permanently-failed org could
                        never be retried even after topping up credits. */}
                    {role === "manager" && (currentStage === "failed" || currentStage === "queued" || currentStage === null || (currentStage === "done" && !enrichHasData)) && (
                      <Button
                        size="sm" variant="outline"
                        className="h-6 px-2 text-[11px] gap-1"
                        onClick={handleRetry}
                        disabled={retrying}
                      >
                        <RotateCcw className={cn("size-3", retrying && "animate-spin")} />
                        {currentStage === "failed" || (currentStage === "done" && !enrichHasData) ? "Retry" : "Enrich"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (lead) void fetchFresh(lead);
                        if (display.orgId) void fetchEnrichStatus(display.orgId);
                      }}
                      disabled={loadingLead}
                      className="h-auto gap-1 p-0 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                    >
                      <RefreshCw className={cn("size-3", loadingLead && "animate-spin")} />
                      Refresh
                    </Button>
                  </div>
                </div>

                <div className="space-y-3 flex-1 min-h-0 overflow-y-auto pr-1">
                  {!!display.orgId && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="min-w-0">
                        <p className="eyebrow mb-1">What they do</p>
                        <InlineTextArea
                          value={enrichData?.company_description ?? display.companyDescription ?? ""}
                          placeholder="Add a description of what this company does"
                          className="text-sm text-muted-foreground"
                          onCommit={(v) => saveOrgField({ company_description: v }, "company description")}
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="eyebrow mb-1">Who they sell to</p>
                        <InlineTextArea
                          value={enrichData?.sells_to ?? display.sellsTo ?? ""}
                          placeholder="Add who this company sells to"
                          className="text-sm text-muted-foreground"
                          onCommit={(v) => saveOrgField({ sells_to: v }, "who they sell to")}
                        />
                      </div>
                    </div>
                  )}
                  {/* Friendly, non-technical status — the raw upstream error
                      (HTTP 402 dumps etc.) stays server-side in enrichment_logs.
                      Retry additionally toasts the real cause (see handleRetry)
                      when it's a billing issue, so this copy stays deliberately
                      vague rather than blaming the website. */}
                  {currentStage === "failed" && (
                    <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 rounded-lg p-3">
                      <AlertCircle className="size-3.5 shrink-0 mt-0.5 text-amber-400" />
                      <span>
                        Couldn&apos;t build a company profile.
                        This lead can still be emailed using the generic template.
                        {attempts >= 3 ? " Automatic retries exhausted — use Refresh to try again." : ""}
                      </span>
                    </div>
                  )}
                  {(currentStage === "queued" || currentStage === "scraping") && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 justify-center">
                      <Loader2 className="size-3.5 animate-spin" />
                      {currentStage === "scraping" ? "Reading company website..." : "Waiting to start..."}
                    </div>
                  )}
                  {!display.orgId && (
                    <p className="text-xs text-muted-foreground italic text-center py-2">
                      No organization linked to this lead.
                    </p>
                  )}

                  {/* Org-level enrichment fans out to every lead under that org
                      regardless of owner (review §3.4) — quiet footnote so a
                      change from someone else's trigger isn't a surprise. */}
                  {!!display.orgShared && display.orgShared.otherOwnerCount > 0 && (
                    <p className="text-[11px] text-foreground/70 leading-relaxed pt-2 border-t border-border/40">
                      This company profile is shared with {display.orgShared.otherLeadCount} other lead{display.orgShared.otherLeadCount === 1 ? "" : "s"} across {display.orgShared.otherOwnerCount} other owner{display.orgShared.otherOwnerCount === 1 ? "" : "s"} — enrichment updates here apply to all of them, however triggered.
                    </p>
                  )}
                </div>
              </div>

            </div>

            </div>{/* end left column */}

            {/* ── Right: activity / internal discussion rail ── */}
            <div className="w-[340px] max-lg:w-[280px] max-sm:hidden shrink-0 border-l border-border bg-secondary/20 flex flex-col min-h-0">
              <div className="flex items-center pl-3 pr-3 py-2.5 border-b border-border shrink-0">
                <div className="flex-1">
                  <SegmentedTabs
                    value={railMode}
                    onValueChange={setRailMode}
                    size="sm"
                    options={[
                      { value: "activity",   label: "Activity",   icon: Clock },
                      { value: "discussion", label: "Discussion", icon: MessageSquare, count: comments.length },
                    ]}
                  />
                </div>
                <Button
                  type="button" variant="ghost" size="icon" onClick={onClose}
                  className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                  aria-label="Close lead"
                >
                  <X className="size-4" />
                </Button>
              </div>

              {railMode === "activity" ? (
                <div className="flex-1 overflow-y-auto p-5">
                  {loadingActivity ? (
                    <div className="space-y-4">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div key={i} className="flex gap-2.5">
                          <Bone className="size-5 rounded-full shrink-0" />
                          <div className="flex-1 space-y-1.5">
                            <Bone className="h-3.5 w-3/4" />
                            <Bone className="h-2.5 w-1/3" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : activity.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-1">No activity yet.</p>
                  ) : (
                    <div>
                      {activity.map((ev, i) => (
                        <ActivityItem
                          key={i}
                          event={ev}
                          isLast={i === activity.length - 1}
                          onCampaignClick={(campaignId) => {
                            onClose();
                            router.push(`/campaigns/${campaignId}`);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex-1 overflow-y-auto p-4">
                    {loadingComments ? (
                      <div className="space-y-4 pt-2">
                        {Array.from({ length: 4 }).map((_, i) => (
                          <div key={i} className={cn("flex gap-2.5", i % 2 === 0 ? "" : "flex-row-reverse")}>
                            <Bone className="size-7 rounded-full shrink-0" />
                            <div className="space-y-1.5 max-w-[70%]">
                              <Bone className="h-3 w-16" />
                              <Bone className="h-12 w-44 rounded-xl" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : comments.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center px-5">
                        <div className="size-9 rounded-full border border-border bg-card flex items-center justify-center text-muted-foreground mb-3">
                          <MessageSquare className="size-4" />
                        </div>
                        <p className="text-sm font-medium">Start the discussion</p>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          Notes here are visible to managers and employees who can access this lead.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {comments.map((comment, index) => {
                          const own = comment.author_id === session?.user.id;
                          const showDate = startsNewChatDay(
                            comment.created_at,
                            comments[index - 1]?.created_at,
                          );
                          return (
                            <div key={comment.id} className="space-y-3">
                              {showDate && (
                                <div className="flex items-center justify-center py-1">
                                  <span className="rounded-full border border-border bg-card px-3 py-1 text-[10px] leading-none font-medium text-muted-foreground shadow-sm">
                                    <span className="translate-y-px inline-block">{formatChatDate(comment.created_at)}</span>
                                  </span>
                                </div>
                              )}
                              <DiscussionComment
                                comment={comment}
                                isOwn={own}
                                currentUserId={session?.user.id ?? ""}
                                compact
                                onToggleReaction={(emoji) => handleToggleCommentReaction(comment.id, emoji)}
                              />
                            </div>
                          );
                        })}
                        <div ref={commentsEndRef} />
                      </div>
                    )}
                  </div>
                  {/* Floating composer — no full-width bar, the input is its own card. */}
                  <div className="shrink-0 px-3 pb-3 pt-1">
                    <div className="rounded-xl border border-border bg-card shadow-lg shadow-black/5">
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
                        placeholder="Write a message to the team…"
                        className="min-h-[72px] resize-none border-0 bg-transparent text-xs shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 px-3 pt-2.5"
                      />
                      <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
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
                          className="size-7 rounded-full"
                        >
                          {sendingComment
                            ? <Loader2 className="size-3 animate-spin" />
                            : <ArrowUp className="size-3.5" strokeWidth={2.5} />}
                        </Button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
