"use client";

import { useEffect, useState } from "react";
import { Clock, Globe, Calendar, Paperclip, Gauge, Bot, Loader2, User } from "lucide-react";
import { DAY_LABELS, type Campaign } from "@/components/app/create-campaign-modal";
import { fetchCampaignSteps } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";
import { formatOrdinal } from "@/lib/utils";

// Read-only anchored popover — just displays everything for reference.
export function CampaignConfigModal({ campaign, open }: { campaign: Campaign; open: boolean }) {
  const [steps, setSteps] = useState<Array<{ step_order: number; delay: number; delay_unit: string }>>([]);
  const [stepsLoading, setStepsLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    async function loadSteps() {
      setStepsLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        const { steps: s } = await fetchCampaignSteps(session.access_token, campaign.id);
        setSteps([...s].sort((a, b) => a.step_order - b.step_order));
      } catch {
        setSteps([]);
      } finally {
        setStepsLoading(false);
      }
    }
    void loadSteps();
  }, [open, campaign.id]);

  const DAY_ORDER = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
  const activeDays = DAY_ORDER.filter((k) => campaign.sendDays?.[k]).map((k) => DAY_LABELS[k]);

  return (
    <div className="enter swatch-bar-top absolute bottom-full right-0 mb-2 z-50 w-80 overflow-hidden rounded-xl border border-border bg-card text-sm shadow-xl divide-y divide-border max-h-[70vh] overflow-y-auto">
      <div className="px-4 pt-3 pb-2">
        <p className="eyebrow">Campaign · config</p>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-muted-foreground flex items-center gap-2"><User className="size-3.5" /> Sender name</span>
        <span className="font-mono text-xs font-medium">{campaign.senderName || "—"}</span>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-muted-foreground flex items-center gap-2"><Gauge className="size-3.5" /> Daily limit</span>
        <span className="font-mono text-xs font-medium tabular-nums">{campaign.dailyLimit ?? 30}/day</span>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-muted-foreground flex items-center gap-2"><Clock className="size-3.5" /> Window</span>
        <span className="font-mono text-xs font-medium tabular-nums">{campaign.windowFrom ?? "08:00"} – {campaign.windowTo ?? "18:00"}</span>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-muted-foreground flex items-center gap-2"><Globe className="size-3.5" /> Timezone</span>
        <span className="font-mono text-xs font-medium">{campaign.timezone ?? "—"}</span>
      </div>
      {activeDays.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-muted-foreground flex items-center gap-2"><Calendar className="size-3.5" /> Days</span>
          <span className="font-medium text-xs">{activeDays.join(", ")}</span>
        </div>
      )}
      {campaign.aiPromptContext && (
        <div className="px-4 py-2.5 space-y-1">
          <span className="text-muted-foreground flex items-center gap-2"><Bot className="size-3.5" /> AI context</span>
          <p className="text-xs text-muted-foreground whitespace-pre-line">{campaign.aiPromptContext}</p>
        </div>
      )}
      <div className="px-4 py-2.5 space-y-1.5">
        <span className="text-muted-foreground flex items-center gap-2 text-sm"><Clock className="size-3.5" /> Follow-up schedule</span>
        {stepsLoading ? (
          <div className="space-y-2 animate-pulse">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-3 w-24 bg-secondary rounded" />
                <div className="h-3 w-32 bg-secondary rounded" />
              </div>
            ))}
          </div>
        ) : steps.filter((s) => s.step_order > 1).length === 0 ? (
          <p className="text-xs text-muted-foreground">No follow-ups configured.</p>
        ) : (
          steps.filter((s) => s.step_order > 1).map((s) => {
            const waitStep = steps.find((p) => p.step_order === s.step_order - 1);
            return (
              <div key={s.step_order} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{formatOrdinal(s.step_order - 1)} follow-up</span>
                <span className="font-mono font-medium tabular-nums">
                  {waitStep ? `${waitStep.delay} ${waitStep.delay_unit} after previous` : "—"}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-muted-foreground flex items-center gap-2"><Paperclip className="size-3.5" /> Attachment</span>
        <span className="font-medium text-xs">{campaign.attachmentName || "None"}</span>
      </div>
    </div>
  );
}
