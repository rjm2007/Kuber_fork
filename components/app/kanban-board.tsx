"use client";

import { Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Lead, LeadStatus } from "@/lib/leads";
import { kanbanColumnFor, inputRequiredReason } from "@/lib/leads";
import { Button } from "@/components/ui/button";

const KANBAN_COLS: { id: LeadStatus; label: string; hint?: string; dot: string; header: string }[] = [
  { id: "New",            label: "New",            hint: "Enrichment in progress", dot: "bg-zinc-400",   header: "border-zinc-500/30"   },
  { id: "Input Required", label: "Input Required", hint: "Enrichment concluded — needs attention", dot: "bg-yellow-400", header: "border-yellow-500/30" },
  { id: "Enriched",       label: "Enriched",       dot: "bg-blue-400",   header: "border-blue-500/30"   },
  { id: "Open",           label: "Win",            dot: "bg-green-400",  header: "border-green-500/30"  },
  { id: "Closed",         label: "Closed",         dot: "bg-zinc-400",   header: "border-zinc-500/30"   },
];

export function KanbanBoard({
  leads,
  onCardClick,
  onRetryAllFailed,
  retryingAll,
  columnTotals,
}: {
  leads: Lead[];
  onCardClick: (lead: Lead) => void;
  /** Manager-only bulk retry for the "failed website" flavour of Input Required. Omit to hide the action. */
  onRetryAllFailed?: () => void;
  retryingAll?: boolean;
  /** True per-stage totals from the database, keyed by display status. Without
   *  these the header numbers count only the leads the browser has loaded — the
   *  same account read 999 on the Dashboard and 500 across these columns.
   *  Omitted when a filter or search is active, because `leads` is then already
   *  the complete server-filtered set and counting it is correct. */
  columnTotals?: Partial<Record<LeadStatus, number>>;
}) {
  return (
    <div className="enter flex gap-2 overflow-x-auto pb-4 min-h-[500px]">
      {KANBAN_COLS.map((col) => {
        const colLeads = leads.filter((l) => kanbanColumnFor(l) === col.id);
        const colTotal = columnTotals?.[col.id] ?? colLeads.length;
        const failedCount = col.id === "Input Required"
          ? colLeads.filter((l) => inputRequiredReason(l) === "failed").length
          : 0;
        return (
          <div
            key={col.id}
            className="shrink-0 flex flex-col gap-2"
            style={{ width: "calc((100% - 32px) / 5)", minWidth: "160px" }}
          >
            <div className={cn("swatch-bar overflow-hidden flex items-center gap-1.5 px-2.5 py-2 rounded-lg border bg-field", col.header)} title={col.hint}>
              <span className={cn("size-2 rounded-full shrink-0", col.dot)} />
              <span className="eyebrow truncate text-foreground/80!">{col.label}</span>
              {col.id === "Input Required" && onRetryAllFailed && failedCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRetryAllFailed}
                  disabled={retryingAll}
                  title="Retry enrichment for every failed company in this list"
                  className="ml-auto h-auto shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-yellow-500 hover:text-yellow-400 hover:bg-transparent disabled:opacity-50"
                >
                  <RotateCcw className={cn("size-3", retryingAll && "animate-spin")} />
                  Retry all
                </Button>
              )}
              <span className={cn("font-mono text-[10px] font-medium text-muted-foreground bg-secondary rounded-full px-1.5 py-0.5 tabular-nums shrink-0", !(col.id === "Input Required" && onRetryAllFailed && failedCount > 0) && "ml-auto")}>
                {colTotal}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {colLeads.map((lead) => {
                const reason = inputRequiredReason(lead);
                return (
                  <Button
                    key={lead.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onCardClick(lead)}
                    className={cn(
                      "h-auto w-full block rounded-lg border bg-field p-2.5 text-left font-normal cursor-pointer hover:border-muted-foreground/50 hover:bg-field transition-colors shadow-sm relative",
                      reason === "failed" ? "border-yellow-500/40" : reason === "missing_data" ? "border-red-500/30" : "border-border",
                    )}
                    title={reason === "failed" && lead.lastError ? lead.lastError : undefined}
                  >
                    {reason === "missing_data" && (
                      <span title="No email found — add one before this lead can be contacted" className="absolute top-2 right-2 text-red-400">
                        <Info className="size-3" />
                      </span>
                    )}
                    {reason === "failed" && (
                      <span title="No usable website — campaigns will use the generic template. Open to retry enrichment." className="absolute top-2 right-2 text-yellow-400">
                        <RotateCcw className="size-3" />
                      </span>
                    )}
                    <p className="text-xs font-semibold truncate mb-0.5 pr-4">
                      {lead.firstName} {lead.lastName}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground truncate mb-2">{lead.company}</p>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] text-muted-foreground/60 truncate">
                        {reason === "failed"
                          ? "No website — generic template"
                          : reason === "missing_data"
                          ? "Needs email"
                          : lead.jobTitle}
                      </span>
                      {lead.score !== "—" && (
                        <span
                          className={cn(
                            "font-mono text-[9px] font-bold px-1 py-0.5 rounded shrink-0",
                            lead.score === "Hot"
                              ? "bg-orange-500/15 text-orange-400"
                              : "bg-blue-500/15 text-blue-400"
                          )}
                        >
                          {lead.score}
                        </span>
                      )}
                    </div>
                  </Button>
                );
              })}
              {colLeads.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-6 flex items-center justify-center">
                  <p className="text-[10px] text-muted-foreground/40">Empty</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
