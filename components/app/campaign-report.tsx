"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { BarChart2, CheckCircle2, Loader2, RotateCcw, Send, Users, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/ui/stat-tile";
import { Card } from "@/components/ui/card";

const DONUT_COLORS = ["#71717a", "#3b82f6", "#06b6d4", "#14b8a6", "#ef4444"];

export type CampaignReportData = {
  campaignId: string;
  totals: {
    leads: number;
    draftsGenerated: number;
    certified: number;
    /** Delivered and nothing more — excludes replied and bounced. */
    sent: number;
    /** Every lead a mail reached: sent + replied + bounced. Reply rate's base. */
    delivered: number;
    replied: number;
    bounced: number;
    failed: number;
  };
  rates: { replyRate: number; certifyRate: number };
  draftGeneration: {
    total: number;
    pending: number;
    generating: number;
    succeeded: number;
    failed: number;
    successRate: number;
  };
  stageDistribution: Array<{ stage: string; label: string; count: number }>;
};

function DonutTooltip({ active, payload }: {
  active?: boolean;
  payload?: { name: string; value: number }[];
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-border bg-card shadow-xl px-3 py-2 text-xs">
      <span className="font-semibold">{p.name}: </span>
      <span className="tabular-nums">{p.value}</span>
    </div>
  );
}

export function CampaignReportView({
  report,
  onRetryAllFailed,
  retrying,
}: {
  report: CampaignReportData;
  onRetryAllFailed?: () => void;
  retrying?: boolean;
}) {
  const { totals, rates, draftGeneration, stageDistribution } = report;
  const donutData = stageDistribution.map((s, i) => ({
    name: s.label,
    value: s.count,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  return (
    <div className="flex-1 overflow-y-auto p-8 space-y-6">
      <div>
        <p className="eyebrow">Campaign report</p>
        <h2 className="font-display text-lg font-bold mt-0.5">Performance overview</h2>
      </div>

      {/* ── Hero: outbound summary + stage donut (2/3) beside a compact stats rail (1/3) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card swatch="left" className="lg:col-span-2 p-6">
          <div className="flex items-end gap-8 pb-4 mb-4 border-b border-border">
            <div>
              <p className="font-mono text-4xl font-bold tabular-nums leading-none">{totals.sent}</p>
              <p className="eyebrow mt-1.5">Sent</p>
            </div>
            <div>
              <p className="font-mono text-4xl font-bold tabular-nums text-green-400 leading-none">{totals.certified}</p>
              <p className="eyebrow mt-1.5">Certified</p>
            </div>
            <div className="ml-auto text-right">
              <p className="eyebrow">Stage distribution</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Leads by journey stage</p>
            </div>
          </div>
          {donutData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No data yet.</p>
          ) : (
            <div className="flex items-center gap-6">
              <div className="shrink-0">
                <ResponsiveContainer width={200} height={200}>
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {donutData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<DonutTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-2.5 min-w-0">
                {donutData.map((d) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                    <span className="text-xs text-muted-foreground flex-1 truncate">{d.name}</span>
                    <span className="font-mono text-xs font-semibold tabular-nums">{d.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <StatTile layout="row" label="Leads" value={totals.leads} icon={Users} />
          <StatTile layout="row" label="Drafts" value={totals.draftsGenerated} icon={BarChart2} sub={`${rates.certifyRate}% certified`} />
          <StatTile layout="row" label="Certified" value={totals.certified} icon={CheckCircle2} />
          <StatTile layout="row" label="Sent" value={totals.sent} icon={Send} />
          <StatTile
            layout="row" label="Failed drafts" value={draftGeneration.failed} icon={AlertCircle}
            tone={draftGeneration.failed > 0 ? "red" : "neutral"}
            sub={draftGeneration.failed > 0 ? "Needs retry" : "None"}
          />
        </div>
      </div>

      {/* ── Draft generation — distinct full-width section, not a card equal to the hero ── */}
      <div>
        <div className="flex items-start justify-between gap-4 flex-wrap pb-3 mb-4 border-b border-border">
          <div>
            <p className="eyebrow">Pipeline</p>
            <h3 className="font-display text-base font-semibold mt-0.5">Draft generation</h3>
            <p className="text-xs text-muted-foreground mt-0.5">AI email draft pipeline for this campaign</p>
          </div>
          {draftGeneration.failed > 0 && onRetryAllFailed && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-red-500/30 text-red-400 hover:text-red-300"
              disabled={retrying}
              onClick={onRetryAllFailed}
            >
              {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              Retry all failed ({draftGeneration.failed})
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {[
            { label: "Total leads", value: draftGeneration.total },
            { label: "Pending", value: draftGeneration.pending },
            { label: "Generating", value: draftGeneration.generating },
            { label: "Succeeded", value: draftGeneration.succeeded },
            { label: "Failed", value: draftGeneration.failed, red: true },
          ].map(({ label, value, red }) => (
            <StatTile key={label} label={label} value={value} tone={red && value > 0 ? "red" : "neutral"} />
          ))}
        </div>

        <div className="space-y-1.5 mt-4">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Generation success rate</span>
            <span className="font-mono tabular-nums font-medium text-foreground">{draftGeneration.successRate}%</span>
          </div>
          <div className="h-2 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                draftGeneration.successRate >= 80 ? "bg-green-500" : draftGeneration.successRate >= 50 ? "bg-amber-500" : "bg-red-500",
              )}
              style={{ width: `${draftGeneration.successRate}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Based on {draftGeneration.succeeded + draftGeneration.failed} completed attempts
            {draftGeneration.generating > 0 ? ` · ${draftGeneration.generating} still generating` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}
