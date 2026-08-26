"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import {
  fetchCampaigns,
  fetchUniboxThread,
  fetchUniboxThreads,
  markThreadRead,
  setThreadStatus,
  syncUnibox,
  type ReplyDraft,
  type UniboxMessage,
  type UniboxThreadSummary,
} from "@/lib/api-client";
import { pickLatestDraftForThread } from "@/lib/reply-draft-pick";
import { UniboxThreadList } from "@/components/app/unibox/unibox-thread-list";
import { UniboxThreadView } from "@/components/app/unibox/unibox-thread-view";
import { UniboxTemperatureBadge } from "@/components/app/unibox/unibox-temperature-badge";
import { UniboxInstantlyInterestMenu } from "@/components/app/unibox/unibox-instantly-interest-menu";
import type { UniboxInterestFilter, UniboxReadStateFilter } from "@/components/app/unibox/unibox-status-filter";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const READ_STATE_VALUES: UniboxReadStateFilter[] = ["all", "unread", "read", "replied", "needs_reply", "no_reply"];

function parseReadStateParam(v: string | null): UniboxReadStateFilter {
  return v && (READ_STATE_VALUES as string[]).includes(v) ? (v as UniboxReadStateFilter) : "all";
}

function parseInterestParam(v: string | null): UniboxInterestFilter {
  if (!v) return "all";
  if (v === "lead") return "lead";
  const n = Number(v);
  return Number.isFinite(n) ? n : "all";
}

function parseCampaignIdsParam(sp: URLSearchParams): string[] {
  const ids = sp.get("campaign_ids");
  if (ids) return ids.split(",").map((s) => s.trim()).filter(Boolean);
  const single = sp.get("campaign_id");
  return single ? [single] : [];
}

// Latest reply_draft for the latest inbound message, regardless of status —
// used as the anchor id for regenerating a fresh draft (even after one was
// already sent), and to know whether one is ready to show.
function pickLatestDraft(messages: UniboxMessage[], drafts: ReplyDraft[]): ReplyDraft | null {
  const received = messages.filter((m) => m.direction === "received");
  const latest = received[received.length - 1];
  return pickLatestDraftForThread(latest?.reply_event_id, drafts);
}

export function UniboxClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState("");
  const [campaignIds, setCampaignIds] = useState<string[]>(() => parseCampaignIdsParam(searchParams));
  const [eaccount, setEaccount] = useState<string | null>(() => searchParams.get("eaccount"));
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");
  const [readState, setReadState] = useState<UniboxReadStateFilter>(() => parseReadStateParam(searchParams.get("status")));
  const [interest, setInterest] = useState<UniboxInterestFilter>(() => parseInterestParam(searchParams.get("interest")));
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [threads, setThreads] = useState<UniboxThreadSummary[]>([]);
  const [threadsTotal, setThreadsTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string }>>([]);
  const [threadDetail, setThreadDetail] = useState<Awaited<ReturnType<typeof fetchUniboxThread>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slower, older request (e.g. the initial unfiltered load)
  // resolving after a newer filtered one and silently overwriting the list
  // with stale results — the list would then disagree with the highlighted
  // filter, making filters look broken.
  const loadThreadsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setToken(data.session.access_token);
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Keep filters in the URL so a refresh (or sharing the link) restores them
  // instead of silently resetting to "All".
  useEffect(() => {
    const qs = new URLSearchParams();
    if (campaignIds.length > 0) qs.set("campaign_ids", campaignIds.join(","));
    if (eaccount) qs.set("eaccount", eaccount);
    if (readState !== "all") qs.set("status", readState);
    if (interest !== "all") qs.set("interest", String(interest));
    if (debouncedSearch) qs.set("q", debouncedSearch);
    const qsStr = qs.toString();
    router.replace(qsStr ? `${pathname}?${qsStr}` : pathname, { scroll: false });
  }, [campaignIds, eaccount, readState, interest, debouncedSearch, pathname, router]);

  const eaccounts = useMemo(
    () => [...new Set(threads.map((t) => t.eaccount).filter(Boolean))] as string[],
    [threads],
  );

  const loadThreads = useCallback(async (append = false) => {
    if (!token) return;
    // Cancel any request still in flight (e.g. from a filter clicked a moment
    // ago) so its response can never land after — and overwrite — this one.
    loadThreadsAbortRef.current?.abort();
    const controller = new AbortController();
    loadThreadsAbortRef.current = controller;
    if (append) setLoadingMore(true);
    else setLoading(true);
    // Clear the old list right away on a fresh (non-append) load so a filter
    // change never shows the previous filter's results while the new request
    // is in flight — it should read as "cleared, then repopulated", not
    // "stale list that suddenly swaps out".
    if (!append) {
      setThreads([]);
      setCursor(null);
      setThreadsTotal(null);
    }
    try {
      const params: Record<string, string | undefined> = {
        eaccount: eaccount ?? undefined,
        q: debouncedSearch || undefined,
        cursor: append && cursor ? cursor : undefined,
        limit: "30",
      };
      if (campaignIds.length > 0) {
        params.campaign_ids = campaignIds.join(",");
      }
      if (readState !== "all") {
        params.status = readState;
      }
      if (interest !== "all") {
        params.interest = interest === "lead" ? "lead" : String(interest);
      }

      const data = await fetchUniboxThreads(token, params, controller.signal);
      if (controller.signal.aborted) return;
      setThreads((prev) => (append ? [...prev, ...data.threads] : data.threads));
      setCursor(data.next_cursor);
      setThreadsTotal(data.counts.total);
      if (!append) setUnreadTotal(data.counts.unread_total);
    } catch (e) {
      if (controller.signal.aborted || (e as Error).name === "AbortError") return;
      toast.error((e as Error).message);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [token, campaignIds, eaccount, debouncedSearch, readState, interest, cursor]);

  useEffect(() => { void loadThreads(false); }, [token, campaignIds, eaccount, debouncedSearch, readState, interest]);

  useEffect(() => {
    if (!token) return;
    fetchCampaigns(token).then((c) => setCampaigns(c.map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
  }, [token]);

  const loadDetail = useCallback(async (threadId: string, opts?: { silent?: boolean }) => {
    if (!token) return;
    if (!opts?.silent) setDetailLoading(true);
    try {
      const detail = await fetchUniboxThread(token, threadId, true);
      setThreadDetail(detail);
      if (readTimer.current) clearTimeout(readTimer.current);
      readTimer.current = setTimeout(() => {
        void markThreadRead(token, threadId).catch(() => {});
      }, 1000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      if (!opts?.silent) setDetailLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function handleSync() {
    if (!token) return;
    setSyncing(true);
    try {
      const r = await syncUnibox(token);
      toast.success(
        r.failed > 0
          ? `Synced ${r.ingested} emails (${r.pages} pages) — ${r.failed} could not be read`
          : `Synced ${r.ingested} emails (${r.pages} pages)`,
      );
      await loadThreads(false);
      if (selectedId) await loadDetail(selectedId);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const selectedSummary = threads.find((t) => t.thread_id === selectedId);
  const leadName = selectedSummary
    ? [selectedSummary.lead?.first_name, selectedSummary.lead?.last_name].filter(Boolean).join(" ") || selectedSummary.lead_email || "Unknown"
    : "";

  const latestDraft = useMemo(
    () => pickLatestDraft(threadDetail?.messages ?? [], threadDetail?.reply_drafts ?? []),
    [threadDetail],
  );

  const leadTemperature = threadDetail?.lead_temperature ?? selectedSummary?.lead_temperature ?? null;
  const showDetail = view === "detail" && !!selectedSummary;
  // A deleted lead's thread stays fully functional by design (planning.md
  // §3.6/§5.6) — history and reply rights are unaffected — but the viewer
  // should know the underlying lead record no longer exists.
  const leadIsDeleted = !!(threadDetail?.lead as { is_deleted?: boolean } | null)?.is_deleted;

  return (
    <div className="flex flex-col h-full">
      {/* Page identity now lives in the shell's top bar (icon + "Unibox" label) —
          this strip only carries the page-level action that doesn't belong there. */}
      <div className="border-b border-border pl-6 pr-6 py-2 flex items-center justify-end shrink-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="gap-1.5 text-xs font-mono uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Sync now
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {showDetail ? (
          <>
            <div className="swatch-bar border-b border-border pl-6 pr-6 py-3 flex items-center justify-between gap-4 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setView("list")}
                  aria-label="Back to conversations"
                  className="shrink-0 text-muted-foreground"
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <Avatar name={leadName} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="font-display font-semibold truncate">{leadName}</p>
                    {leadIsDeleted && (
                      <Badge
                        variant="secondary"
                        title="This lead's record has been deleted. Thread history and reply rights are unaffected."
                        className="shrink-0 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                      >
                        Lead deleted
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground truncate">{selectedSummary.lead_email}</p>
                </div>
                {selectedSummary.campaign && (
                  <Link
                    href={`/campaigns/${selectedSummary.campaign.id}`}
                    className="inline-flex items-center gap-1 shrink-0 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-primary/10 transition-colors"
                  >
                    {selectedSummary.campaign.name}
                    <ExternalLink className="size-3 opacity-70" />
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <UniboxTemperatureBadge temperature={leadTemperature} />
                <UniboxInstantlyInterestMenu
                  interestStatus={threadDetail?.interest_status ?? selectedSummary.interest_status}
                  onChange={(v) => {
                    if (!token || !selectedId) return;
                    void setThreadStatus(token, selectedId, v, selectedSummary.lead_email ?? undefined)
                      .then(() => { void loadThreads(false); void loadDetail(selectedId, { silent: true }); })
                      .catch((e) => toast.error((e as Error).message));
                  }}
                />
              </div>
            </div>
            {detailLoading ? (
              <div className="flex-1 min-h-0 p-6 space-y-5 animate-pulse">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className={`flex ${i % 2 === 0 ? "" : "justify-end"}`}>
                    <div className="space-y-1.5">
                      <div className="h-3 w-20 bg-secondary rounded" />
                      <div className="h-14 w-56 bg-secondary rounded-xl" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0">
                <UniboxThreadView
                  key={selectedId}
                  messages={threadDetail?.messages ?? []}
                  leadName={leadName}
                  leadEmail={selectedSummary.lead_email}
                  campaign={selectedSummary.campaign}
                  threadId={selectedId!}
                  token={token}
                  canReply={!!threadDetail?.reply_to_uuid}
                  latestDraft={latestDraft}
                  // Prefer what they wrote, but fall back to ANY message with a
                  // subject. A thread where the lead has never replied has no
                  // received message at all, and seeding null there left the
                  // Subject box empty and the Send button silently dead —
                  // exactly the case where you most want to chase them.
                  replyToSubject={
                    threadDetail?.messages?.find((m) => m.direction === "received" && m.subject)?.subject
                    ?? threadDetail?.messages?.find((m) => m.subject)?.subject
                    ?? null
                  }
                  // Our mailbox on this thread — keeps it out of the CC list we
                  // build from the thread's participants.
                  eaccount={threadDetail?.eaccount ?? null}
                  knownLeadEmails={threadDetail?.known_lead_emails ?? []}
                  organizationName={threadDetail?.lead_organization_name ?? null}
                  ownerName={threadDetail?.lead_owner_name ?? null}
                  onChanged={() => { void loadThreads(false); void loadDetail(selectedId!, { silent: true }); }}
                />
              </div>
            )}
          </>
        ) : (
          <UniboxThreadList
            threads={threads}
            threadsTotal={threadsTotal}
            selectedId={selectedId}
            search={search}
            loading={loading}
            loadingMore={loadingMore}
            readState={readState}
            interest={interest}
            unreadTotal={unreadTotal}
            campaignIds={campaignIds}
            campaigns={campaigns}
            eaccount={eaccount}
            eaccounts={eaccounts}
            onCampaigns={setCampaignIds}
            onEaccount={setEaccount}
            onReadState={setReadState}
            onInterest={setInterest}
            onSearch={setSearch}
            onSelect={(id) => { setSelectedId(id); setView("detail"); }}
            hasMore={!!cursor}
            onLoadMore={() => void loadThreads(true)}
          />
        )}
      </div>
    </div>
  );
}
