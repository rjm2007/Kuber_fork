"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UniboxThreadSummary } from "@/lib/api-client";
import type { UniboxInterestFilter, UniboxReadStateFilter } from "@/components/app/unibox/unibox-status-filter";
import { hasActiveUniboxFilters, UniboxFiltersPanel } from "@/components/app/unibox/unibox-filters";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/** Mirrors the real row's layout so the loading state doesn't jump/reflow once data arrives. */
function ThreadRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Skeleton className="size-1.5 rounded-full shrink-0" />
      <Skeleton className="h-3.5 w-32 shrink-0" />
      <Skeleton className="h-3.5 flex-1 min-w-0" />
      <Skeleton className="h-3 w-10 shrink-0" />
    </div>
  );
}

type Props = {
  threads: UniboxThreadSummary[];
  threadsTotal: number | null;
  selectedId: string | null;
  search: string;
  loading: boolean;
  loadingMore?: boolean;
  readState: UniboxReadStateFilter;
  interest: UniboxInterestFilter;
  unreadTotal: number;
  campaignIds: string[];
  campaigns: Array<{ id: string; name: string }>;
  eaccount: string | null;
  eaccounts: string[];
  onCampaigns: (ids: string[]) => void;
  onEaccount: (e: string | null) => void;
  onReadState: (v: UniboxReadStateFilter) => void;
  onInterest: (v: UniboxInterestFilter) => void;
  onSearch: (q: string) => void;
  onSelect: (threadId: string) => void;
  onLoadMore?: () => void;
  hasMore: boolean;
};

export function UniboxThreadList({
  threads, threadsTotal, selectedId, search, loading, loadingMore, readState, interest, unreadTotal,
  campaignIds, campaigns, eaccount, eaccounts, onCampaigns, onEaccount,
  onReadState, onInterest, onSearch, onSelect, onLoadMore, hasMore,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersActive = hasActiveUniboxFilters(campaignIds, eaccount, readState, interest);

  return (
    <div className="w-full h-full flex">
      <div
        className={cn(
          "shrink-0 border-r border-border bg-card/60 overflow-hidden transition-[width] duration-200",
          filtersOpen ? "w-72" : "w-0",
        )}
      >
        <div className="w-72 h-full">
          <UniboxFiltersPanel
            campaigns={campaigns}
            campaignIds={campaignIds}
            onCampaigns={onCampaigns}
            eaccount={eaccount}
            eaccounts={eaccounts}
            onEaccount={onEaccount}
            readState={readState}
            onReadState={onReadState}
            interest={interest}
            onInterest={onInterest}
            unreadTotal={unreadTotal}
            onClose={() => setFiltersOpen(false)}
          />
        </div>
      </div>

      <div className="flex-1 min-w-0 h-full flex flex-col bg-secondary/20">
        <div className="px-6 py-3 border-b border-border shrink-0 bg-background">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="eyebrow">
              {threadsTotal !== null
                ? `${threadsTotal} thread${threadsTotal === 1 ? "" : "s"}`
                : loading
                  ? "…"
                  : "Conversations"}
            </p>
            {unreadTotal > 0 && (
              <p className="font-mono text-[11px] tabular-nums text-primary">{unreadTotal} unread</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-label={filtersOpen ? "Close filters" : "Open filters"}
              className={cn(
                "relative shrink-0 size-9 bg-card text-muted-foreground",
                filtersActive && "text-primary",
              )}
            >
              <Menu className="size-4" />
              {filtersActive && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-card" />}
            </Button>
            <SearchInput
              value={search}
              onChange={onSearch}
              placeholder="Search by lead name…"
              wrapperClassName="flex-1 max-w-xl"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && threads.length === 0 ? (
            <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden divide-y divide-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <ThreadRowSkeleton key={i} />
              ))}
            </div>
          ) : threads.length === 0 ? (
            <EmptyState message="No conversations match your filters." />
          ) : (
            <div className="enter rounded-xl border border-border bg-card shadow-sm overflow-hidden divide-y divide-border">
              {threads.map((t) => {
                const name = [t.lead?.first_name, t.lead?.last_name].filter(Boolean).join(" ") || t.lead_email || "Unknown";
                const needsReply = t.latest_direction === "received";
                const isUnread = t.unread_count > 0;
                return (
                  <button
                    key={t.thread_id}
                    type="button"
                    onClick={() => onSelect(t.thread_id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-l-2",
                      selectedId === t.thread_id
                        ? "swatch-bar bg-primary/5 border-transparent"
                        : "border-transparent hover:bg-secondary/40",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn("size-1.5 rounded-full shrink-0", needsReply ? "bg-amber-500" : "bg-transparent")}
                    />
                    <span className={cn("w-44 shrink-0 truncate text-sm", isUnread ? "font-semibold text-foreground" : "text-foreground/80")}>
                      {name}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm">
                      <span className={isUnread ? "font-semibold text-foreground" : "text-foreground/80"}>
                        {t.subject ?? "(no subject)"}
                      </span>
                      <span className="text-muted-foreground"> — {t.preview}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {isUnread && t.unread_count > 1 && (
                        <span className="font-mono text-[9px] font-semibold tabular-nums min-w-4 text-center px-1 py-0.5 rounded-md bg-primary/15 text-primary">
                          {t.unread_count}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-muted-foreground w-14 text-right tabular-nums">
                        {format(new Date(t.latest_at), "MMM d")}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {hasMore && threadsTotal !== null && (
            <div className="flex justify-center pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="h-8 text-xs"
              >
                {loadingMore
                  ? "Loading…"
                  : `Show more (${threads.length} of ${threadsTotal})`}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
