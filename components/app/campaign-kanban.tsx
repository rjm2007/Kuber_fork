"use client";

import { Flame, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import {
  CAMPAIGN_KANBAN_COLS,
  campaignBucket,
  isFailedDraft,
  type CampaignKanbanBucket,
} from "@/lib/campaign-status";

export type CampaignKanbanLead = {
  id: string;
  crm_status: string;
  lead_temperature: string | null;
  leads: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    title: string | null;
  } | null;
  email_drafts: { id: string; status: string } | null;
};

const COL_COUNT = CAMPAIGN_KANBAN_COLS.length;

export function CampaignKanban({
  leads,
  selectedId,
  onSelect,
  onRetry,
  retryingId,
}: {
  leads: CampaignKanbanLead[];
  selectedId: string | null;
  onSelect: (campaignLeadId: string) => void;
  onRetry?: (draftId: string, campaignLeadId: string) => void;
  retryingId?: string | null;
}) {
  return (
    <div className="enter flex flex-col flex-1 min-h-0">
      <p className="eyebrow px-4 pt-2 shrink-0">
        Click a lead to open in Leads view for review and certification.
      </p>
      <div className="flex gap-2 overflow-x-auto pb-4 min-h-0 flex-1 p-2">
        {CAMPAIGN_KANBAN_COLS.map((col) => {
          const colLeads = leads.filter((cl) => campaignBucket(cl) === col.id);
          return (
            <div
              key={col.id}
              className="shrink-0 flex flex-col gap-2 min-h-0 self-stretch"
              style={{
                width: `calc((100% - ${(COL_COUNT - 1) * 8}px) / ${COL_COUNT})`,
                minWidth: "180px",
              }}
            >
              <div className={cn("swatch-bar overflow-hidden flex items-center gap-1.5 px-2.5 py-2 rounded-lg border bg-card shrink-0", col.header)}>
                <span className={cn("size-2 rounded-full shrink-0", col.dot)} />
                <span className="eyebrow truncate text-foreground/80!">{col.label}</span>
                <span className="ml-auto font-mono text-[10px] font-medium text-muted-foreground bg-secondary rounded-full px-1.5 py-0.5 tabular-nums shrink-0">
                  {colLeads.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto">
                {colLeads.map((cl) => {
                  const lead = cl.leads;
                  const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "Unknown";
                  const isFailed = isFailedDraft(cl);
                  const isSelected = selectedId === cl.id;
                  const isRetrying = retryingId === cl.id;
                  return (
                    <div
                      key={cl.id}
                      className={cn(
                        "shrink-0 rounded-lg border bg-card p-2.5 cursor-pointer transition-colors overflow-hidden",
                        isFailed ? "border-red-500/50" : "border-border",
                        isSelected ? "swatch-bar ring-1 ring-primary/50 bg-primary/5" : "hover:bg-secondary/40",
                      )}
                      onClick={() => onSelect(cl.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(cl.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-start gap-2">
                        <Avatar name={name} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{name}</p>
                          <p className="font-mono text-[10px] text-muted-foreground truncate">
                            {lead?.title || lead?.email}
                          </p>
                        </div>
                        {cl.crm_status === "replied" && cl.lead_temperature === "hot" && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-400 bg-red-500/10 border border-red-500/25 rounded-full px-1.5 py-0.5">
                            <Flame className="size-2.5" /> HOT
                          </span>
                        )}
                      </div>
                      {isFailed && onRetry && cl.email_drafts?.id && (
                        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] w-full gap-1 border-red-500/30 text-red-400 hover:text-red-300"
                            disabled={!!retryingId}
                            onClick={() => onRetry(cl.email_drafts!.id, cl.id)}
                          >
                            {isRetrying ? (
                              <Loader2 className="size-2.5 animate-spin" />
                            ) : (
                              <RotateCcw className="size-2.5" />
                            )}
                            Retry
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function countByBucket(leads: CampaignKanbanLead[]): Record<CampaignKanbanBucket, number> {
  const counts: Record<CampaignKanbanBucket, number> = {
    pending: 0,
    draft: 0,
    approved: 0,
    sent: 0,
    replied: 0,
  };
  for (const cl of leads) counts[campaignBucket(cl)]++;
  return counts;
}
