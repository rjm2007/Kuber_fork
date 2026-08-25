"use client";

import {
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Activity, Award, BarChart2, Calendar, Mail,
  Megaphone, PieChart as PieIcon, Tags,
  TrendingUp, Users, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getBatchColor, type BatchColorName } from "@/lib/constants";
import type { Campaign } from "@/components/app/create-campaign-modal";
import type { ImportBatch } from "@/lib/api-client";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";

// ─── Chart helpers ────────────────────────────────────────────────────────────

const GRID_COLOR = "var(--border)";
const TICK_COLOR = "var(--muted-foreground)";

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card shadow-xl px-3 py-2.5 text-xs space-y-1">
      {label && <p className="font-medium text-muted-foreground mb-1">{label}</p>}
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="size-1.5 rounded-full shrink-0 bg-primary" />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-mono font-semibold text-foreground tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Eyebrow + font-display title + hairline divider — the standard section header. */
function SectionHeader({
  eyebrow, title, sub, icon: Icon,
}: { eyebrow: string; title: string; sub?: string; icon?: React.ElementType }) {
  return (
    <div className="flex items-center justify-between gap-3 pb-3 mb-4 border-b border-border">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h3 className="font-display text-base font-semibold mt-0.5">{title}</h3>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
      {Icon && <Icon className="size-4 text-muted-foreground/60 shrink-0" />}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
  campaigns: Campaign[];
  imports: ImportBatch[];
  loading?: boolean;
  totalLeads: number;
  leadsThisMonth?: number;
  enrichedLeads: number;
  hotCount: number;
  pipelineGrowth: Array<{ month: string; leads: number }>;
  stageDonutData: Array<{ name: string; value: number; color: string }>;
  temperatureBreakdown: { hot: number; cold: number; ooo: number; unsubscribed: number; unclassified: number } | null;
  pendingReplies: Array<{ id: string; campaignId: string; campaignName: string; leadEmail: string | null; preview: string; createdAt: string }>;
  onNavigate: (view: "lead-generation" | "leads" | "campaigns") => void;
  onSelectBatch: (label: string) => void;
}

export function DashboardView({
  campaigns,
  imports,
  loading = false,
  totalLeads,
  leadsThisMonth = 0,
  enrichedLeads,
  hotCount,
  pipelineGrowth,
  stageDonutData,
  temperatureBreakdown,
  pendingReplies,
  onNavigate,
  onSelectBatch,
}: DashboardViewProps) {
  const hotLeads      = hotCount;
  const liveCampaigns = campaigns.filter((c) => c.status === "Live").length;
  const totalReplied   = campaigns.reduce((a, c) => a + c.replied, 0);
  // DELIVERED, not `c.sent` — a replied or bounced lead has left `sent` for
  // its own bucket (see campaignOutcomes), so summing `sent` alone would
  // undercount every email that actually went out and got an outcome. Reply
  // rate divides by the same total for the same reason: dividing by `sent`
  // would shrink the base every time a campaign works and overstate the rate.
  const totalSent      = campaigns.reduce((a, c) => a + c.delivered, 0);
  const replyRate      = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

  const pulse = (w: string) => <span className={cn("inline-block h-6 rounded bg-secondary/60 animate-pulse", w)} />;

  return (
    <div className="enter p-8 space-y-6 max-w-7xl mx-auto">

      {/* Upstream credit/API-key failures (OpenRouter/Firecrawl/Apollo). */}
      <ServiceHealthBanner />

      {/* ── Compact identity strip (section title already lives in the shell top bar) ── */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <p className="eyebrow">Overview · Pipeline console</p>
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Calendar className="size-3.5" />
          {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        </div>
      </div>

      {/* ── Hero panel + secondary-stats rail (asymmetric 2/3 · 1/3) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Hero: pipeline growth is the primary metric — headline number + trend chart */}
        <Card swatch="left" className="lg:col-span-2 p-6">
          <div className="flex items-start justify-between gap-4 pb-4 mb-4 border-b border-border">
            <div>
              <p className="eyebrow">Pipeline · 6mo trend</p>
              <p className="font-mono text-4xl font-bold tabular-nums mt-1 leading-none">
                {loading ? pulse("w-20 h-9") : totalLeads}
              </p>
              <p className="text-xs text-muted-foreground mt-1.5">Total leads in pipeline, cumulative over 6 months</p>
            </div>
            <TrendingUp className="size-4 text-muted-foreground/60 shrink-0 mt-1" />
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={pipelineGrowth} margin={{ left: -10, right: 4, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="areaPrimary" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="var(--primary)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_COLOR} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: TICK_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: TICK_COLOR, fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--primary)", strokeWidth: 1.5, strokeOpacity: 0.3 }} />
              <Area
                type="natural" dataKey="leads" name="Leads" stroke="var(--primary)" strokeWidth={2.5}
                fill="url(#areaPrimary)"
                dot={{ fill: "var(--primary)", r: 3.5, strokeWidth: 2, stroke: "var(--background)" }}
                activeDot={{ r: 5, fill: "var(--primary)", strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Secondary-stats rail: compact stacked tiles, 1/3 width */}
        <div className="flex flex-col gap-3">
          <StatTile
            layout="row" label="Hot Leads" icon={TrendingUp} tone="red"
            value={loading ? pulse("w-10") : hotLeads}
            sub={`${Math.round(hotLeads / Math.max(totalLeads, 1) * 100)}% of total`}
          />
          <StatTile
            layout="row" label="Emails Sent" icon={Mail} tone="sky"
            value={loading ? pulse("w-12") : totalSent}
            sub={`${campaigns.length} campaigns`}
          />
          <StatTile
            layout="row" label="Reply Rate" icon={Activity} tone="amber"
            value={loading ? pulse("w-10") : `${replyRate}%`}
            sub={`${totalReplied} replies total`}
          />
          <StatTile
            layout="row" label="Live Campaigns" icon={Megaphone} tone="neutral"
            value={loading ? pulse("w-8") : liveCampaigns}
            sub={`${campaigns.length} total created`}
          />
          <StatTile
            layout="row" label="Enriched" icon={Zap} tone="zinc"
            value={loading ? pulse("w-12") : enrichedLeads}
            sub={`${Math.round(enrichedLeads / Math.max(totalLeads, 1) * 100)}% done`}
          />
        </div>
      </div>

      {/* ── Secondary charts row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Stage distribution */}
        <Card className="p-6">
          <SectionHeader eyebrow="Breakdown" title="Stage Distribution" sub="Leads across pipeline stages" icon={PieIcon} />
          {stageDonutData.length === 0 ? (
            <EmptyState
              boxed={false}
              message="No leads yet — add some to see the distribution"
              className="h-[180px] py-0"
            />
          ) : (
            <div className="flex items-center gap-6">
              <div className="shrink-0">
                <ResponsiveContainer width={180} height={180}>
                  <PieChart>
                    <Pie
                      data={stageDonutData} cx="50%" cy="50%"
                      innerRadius={52} outerRadius={76} paddingAngle={2} dataKey="value" strokeWidth={0}
                    >
                      {stageDonutData.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex-1 space-y-2.5 min-w-0">
                {stageDonutData.map((d) => {
                  const pct = Math.round((d.value / Math.max(totalLeads, 1)) * 100);
                  return (
                    <div key={d.name} className="flex items-center gap-2">
                      <span className="size-2 rounded-full shrink-0" style={{ background: d.color }} />
                      <span className="text-xs text-muted-foreground flex-1 truncate">{d.name}</span>
                      <span className="font-mono text-xs font-semibold tabular-nums">{d.value}</span>
                      <span className="font-mono text-[10px] text-muted-foreground/50 w-6 text-right tabular-nums">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        {/* Reply Temperature */}
        <Card className="p-6">
          <SectionHeader eyebrow="Classification" title="Reply Temperature" sub="How prospects who replied were classified" icon={PieIcon} />
          {!temperatureBreakdown || Object.values(temperatureBreakdown).every((v) => v === 0) ? (
            <div className="h-[140px] flex items-center justify-center text-xs text-muted-foreground">
              No replies classified yet
            </div>
          ) : (
            (() => {
              const data = [
                { name: "Hot", value: temperatureBreakdown.hot, color: "#ef4444" },
                { name: "Cold", value: temperatureBreakdown.cold, color: "#3b82f6" },
                { name: "Out of office", value: temperatureBreakdown.ooo, color: "#f59e0b" },
                { name: "Unsubscribed", value: temperatureBreakdown.unsubscribed, color: "#6b7280" },
              ].filter((d) => d.value > 0);
              const total = data.reduce((a, d) => a + d.value, 0);
              return (
                <div className="flex items-center gap-6">
                  <div className="shrink-0">
                    <ResponsiveContainer width={140} height={140}>
                      <PieChart>
                        <Pie data={data} cx="50%" cy="50%" innerRadius={40} outerRadius={62} paddingAngle={2} dataKey="value" strokeWidth={0}>
                          {data.map((d) => <Cell key={d.name} fill={d.color} />)}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 space-y-2.5 min-w-0">
                    {data.map((d) => (
                      <div key={d.name} className="flex items-center gap-2">
                        <span className="size-2 rounded-full shrink-0" style={{ background: d.color }} />
                        <span className="text-xs text-muted-foreground flex-1 truncate">{d.name}</span>
                        <span className="font-mono text-xs font-semibold tabular-nums">{d.value}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/50 w-8 text-right tabular-nums">
                          {Math.round((d.value / Math.max(total, 1)) * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()
          )}
        </Card>
      </div>

      {/* ── Needs Your Review — full-width list section, distinct from the chart cards above ── */}
      <div>
        <SectionHeader eyebrow="Approvals" title="Needs Your Review" sub="Reply drafts waiting for approval, across all campaigns" icon={Mail} />
        {pendingReplies.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">No replies waiting for review</p>
        ) : (
          <div className="divide-y divide-border">
            {pendingReplies.map((r) => (
              <Button
                key={r.id}
                type="button"
                variant="ghost"
                onClick={() => onNavigate("campaigns")}
                className="w-full h-auto justify-start text-left px-3 py-2.5 rounded-md font-normal"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-medium truncate">{r.leadEmail ?? "Unknown lead"}</p>
                    <span className="text-[10px] text-muted-foreground shrink-0">{r.campaignName}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate">{r.preview}</p>
                </div>
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Batches */}
        <Card swatch="left" className="lg:col-span-2 p-6">
          <SectionHeader eyebrow="Imports" title="Batches" sub="Click a batch to view its leads" icon={Tags} />
          {imports.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">
              No batches yet. Import leads from Apollo, Excel, or manual entry to create one.
            </p>
          ) : (
            <div className="space-y-1">
              {imports.map((b) => {
                const bc = getBatchColor(b.color);
                return (
                  <Button
                    key={b.id}
                    type="button"
                    variant="ghost"
                    onClick={() => onSelectBatch(b.label)}
                    className="w-full h-auto justify-start gap-3 p-3 rounded-lg font-normal"
                  >
                    <span className={cn("size-2.5 rounded-full shrink-0", bc.bg)} />
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium truncate">{b.label}</p>
                      <p className="text-xs text-muted-foreground truncate capitalize">{b.source}</p>
                    </div>
                    <Pill color={b.color as BatchColorName} className="font-mono tabular-nums shrink-0">
                      {b.lead_count} lead{b.lead_count !== 1 ? "s" : ""}
                    </Pill>
                  </Button>
                );
              })}
            </div>
          )}
        </Card>

        {/* Right column */}
        <div className="space-y-4">

          <div className="swatch-bar-top overflow-hidden bg-primary border border-primary rounded-xl p-5">
            <Award className="size-7 text-primary-foreground/80 mb-3" />
            <p className="eyebrow text-primary-foreground/60">Summary</p>
            <h3 className="font-display text-sm font-semibold text-primary-foreground mb-1 mt-0.5">Pipeline overview</h3>
            <p className="text-xs text-primary-foreground/60 leading-relaxed">
              <span className="font-mono tabular-nums">{hotLeads}</span> hot leads · <span className="font-mono tabular-nums">{totalSent}</span> emails sent · <span className="font-mono tabular-nums">{replyRate}%</span> reply rate.
              Keep enriching and following up to close your pipeline.
            </p>
          </div>

          <Card className="p-5 space-y-4">
            <p className="eyebrow">Targets</p>
            <h3 className="font-display text-sm font-semibold -mt-2.5">Monthly Goals</h3>
            {/* Leads is true month-to-date. Emails/Replies are lifetime campaign
                counters — Instantly gives no per-month history and nothing local
                records a send date, so there is no MTD figure to show.
                ponytail: add a monthly send ledger if these need to be true MTD. */}
            {[
              { label: "Leads Added", current: leadsThisMonth, goal: 50,  period: "this month" },
              { label: "Emails Sent", current: totalSent,      goal: 100, period: "all time"   },
              { label: "Replies",     current: totalReplied,   goal: 20,  period: "all time"   },
            ].map((item) => (
              <div key={item.label}>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">
                    {item.label}
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">{item.period}</span>
                  </span>
                  <span className="text-muted-foreground font-mono font-medium tabular-nums">
                    {item.current >= item.goal
                      ? `${item.current} ✓`
                      : `${item.current}/${item.goal}`}
                  </span>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.min(Math.round(item.current / item.goal * 100), 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="eyebrow">Next up</p>
                <h3 className="font-display text-sm font-semibold mt-0.5">Suggested Actions</h3>
              </div>
              <BarChart2 className="size-3.5 text-muted-foreground/60 shrink-0" />
            </div>
            <ul className="space-y-2.5 text-xs text-muted-foreground">
              {[
                { text: "Review leads awaiting approval", action: () => onNavigate("leads")           },
                { text: "Enrich newly imported leads",    action: () => onNavigate("leads")           },
                { text: "Create Q3 outreach campaign",    action: () => onNavigate("campaigns")       },
                { text: "Add more leads via Apollo",      action: () => onNavigate("lead-generation") },
              ].map((s) => (
                <li
                  key={s.text}
                  onClick={s.action}
                  className="flex items-center gap-2 cursor-pointer hover:text-foreground transition-colors"
                >
                  <span className="size-1.5 rounded-full shrink-0 bg-primary" />
                  {s.text}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
