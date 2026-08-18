"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Sparkles, MessageSquareReply, ArrowRightLeft } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
import { UsageBarChart } from "@/components/app/usage-bar-chart";
import { UsageHeaderSkeleton, StatTileGridSkeleton, ChartCardSkeleton } from "@/components/app/usage-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAiUsage, type AiUsageData } from "@/lib/api-client";

function formatRemaining(id: string, remaining: number | null): string | null {
  if (remaining == null) return null;
  if (id === "openrouter") return `$${remaining.toFixed(2)} left`;
  return `${remaining} left`;
}

function ProviderRow({ provider }: { provider: AiUsageData["providers"][number] }) {
  const remaining = formatRemaining(provider.id, provider.remaining);
  const detail = provider.message && provider.message !== "OK" ? provider.message : provider.ok ? "Key is valid" : "No usable key configured";
  return (
    <div className="rounded-xl border border-border bg-field px-4 py-3.5 space-y-1">
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("size-1.5 rounded-full shrink-0", provider.ok ? "bg-emerald-400" : "bg-destructive")} aria-hidden />
        <p className="font-medium text-sm truncate">{provider.label}</p>
        {remaining && (
          <span className={cn("ml-auto text-xs font-mono shrink-0", provider.ok ? "text-muted-foreground" : "text-destructive")}>
            {remaining}
          </span>
        )}
      </div>
      <p className={cn("text-xs pl-3.5", provider.ok ? "text-muted-foreground" : "text-destructive")}>{detail}</p>
    </div>
  );
}

export function AiUsageView() {
  const { session } = useApp();
  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    if (!session) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await fetchAiUsage(session.access_token, refresh);
      setData(result);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => { void load(false); }, [load]);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <UsageHeaderSkeleton />
        <Skeleton className="h-9 w-full rounded-lg" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-field px-4 py-3.5 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-1.5 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <Skeleton className="h-3 w-48 ml-3.5" />
            </div>
          ))}
        </div>
        <StatTileGridSkeleton count={3} />
        <ChartCardSkeleton />
      </div>
    );
  }

  const { providers, tierRoles, volume } = data;
  const primaryLabel = providers.find((p) => p.id === tierRoles.primary)?.label ?? tierRoles.primary ?? "default order";
  const fallbackLabel = providers.find((p) => p.id === tierRoles.fallback)?.label ?? tierRoles.fallback ?? "none";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground max-w-2xl">
          Key validity/balance for every configured LLM, plus how many drafts and replies this app has actually generated —
          there is no per-call token or cost log today, so volume is counted from real output, not tokens.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void load(true)} className="shrink-0 gap-1.5">
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-secondary/30 px-4 py-2.5 text-xs text-muted-foreground flex items-center gap-1.5">
        <ArrowRightLeft className="size-3.5 shrink-0" />
        Try order: <span className="font-medium text-foreground">{primaryLabel}</span> primary, <span className="font-medium text-foreground">{fallbackLabel}</span> fallback — set in Settings › Keys › Credentials.
      </div>

      <div className="space-y-2">
        {providers.map((p) => <ProviderRow key={p.id} provider={p} />)}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatTile label="Drafts generated" value={volume.totalDrafts} icon={Sparkles} sub={`last ${volume.windowDays}d`} />
        <StatTile label="Replies generated" value={volume.totalReplies} icon={MessageSquareReply} sub={`last ${volume.windowDays}d`} tone="sky" />
        <StatTile label="Total generations" value={volume.totalGenerations} icon={ArrowRightLeft} sub={`last ${volume.windowDays}d`} tone="amber" />
      </div>

      <Card className="p-5 space-y-3">
        <div>
          <p className="eyebrow">Generation volume</p>
          <p className="text-xs text-muted-foreground">Drafts and replies produced per day, last {volume.windowDays} days.</p>
        </div>
        {volume.daily.every((d) => d.drafts === 0 && d.replies === 0) ? (
          <p className="text-xs text-muted-foreground py-6 text-center">No drafts or replies generated recently.</p>
        ) : (
          <UsageBarChart
            data={volume.daily}
            bars={[
              { dataKey: "drafts", name: "Drafts", color: "var(--primary)" },
              { dataKey: "replies", name: "Replies", color: "#fbbf24" },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
