"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/app-context";
import {
  deleteCampaign, fetchUsers, pauseCampaign, resumeCampaign, type Profile,
} from "@/lib/api-client";
import type { Campaign } from "@/components/app/create-campaign-modal";
import { Pause, Play, Trash2, User, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { ServiceHealthBanner } from "@/components/app/service-health-banner";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type CampaignStatus = "Draft" | "Live" | "Paused";

const CAMPAIGN_STATUS_STYLES: Record<string, { badge: string; dot: string }> = {
  Draft:  { badge: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",   dot: "bg-zinc-400"  },
  Live:   { badge: "bg-green-500/15 text-green-400 border-green-500/25", dot: "bg-green-400" },
  Paused: { badge: "bg-amber-500/15 text-amber-400 border-amber-500/25", dot: "bg-amber-400" },
};

export function CampaignsClient({ initialCampaigns }: { initialCampaigns: Campaign[] }) {
  const router = useRouter();
  const { campaigns, setCampaigns, session, role } = useApp();

  // After first sync, always trust client state — even when empty after deleting
  // the last campaign. Falling back to initialCampaigns made deleted rows reappear.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    setCampaigns(initialCampaigns);
    setSeeded(true);
  }, [initialCampaigns, setCampaigns]);

  const list = seeded ? campaigns : (campaigns.length > 0 ? campaigns : initialCampaigns);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | "All">("All");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [users, setUsers] = useState<Profile[]>([]);
  const [deletingCampaign, setDeletingCampaign] = useState<Campaign | null>(null);
  const [deleteCampaignLoading, setDeleteCampaignLoading] = useState(false);
  const [pausingCampaign, setPausingCampaign] = useState<Campaign | null>(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "manager" || !session) return;
    fetchUsers(session.access_token).then(setUsers).catch(() => {});
  }, [role, session]);

  const userMap = new Map(users.map((u) => [u.id, u]));

  function displayName(userId: string | null | undefined): string | null {
    if (!userId) return null;
    const u = userMap.get(userId);
    return u ? (u.full_name || u.email) : null;
  }

  const filtered = list.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "All" || c.status === statusFilter;
    const matchesOwner = ownerFilter === "all" || c.createdBy === ownerFilter || c.assignedTo === ownerFilter;
    return matchesSearch && matchesStatus && matchesOwner;
  });

  const counts: Record<CampaignStatus | "All", number> = {
    All:    list.length,
    Draft:  list.filter((c) => c.status === "Draft").length,
    Live:   list.filter((c) => c.status === "Live").length,
    Paused: list.filter((c) => c.status === "Paused").length,
  };

  async function handleResume(c: Campaign) {
    if (!session || resumingId) return;
    setResumingId(c.id);
    try {
      const res = await resumeCampaign(session.access_token, c.id);
      if (res.errors.length > 0) {
        toast.warning(`Resumed ${res.resumed} region(s); ${res.errors.length} failed. Try again for the rest.`);
      } else {
        toast.success("Campaign resumed — Instantly is sending again");
      }
      setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, status: "Live" } : x)));
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Failed to resume campaign");
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="eyebrow">Outreach · Campaigns</p>
      </div>

      {/* Drafts are written here, so a dead LLM key has to be visible here. It
          was only on Leads and Dashboard, which is why a whole campaign could
          show "No draft" on every row with no explanation anywhere. */}
      <ServiceHealthBanner />

      <div className="flex items-center gap-3 flex-wrap rounded-lg bg-secondary/30 p-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search campaigns…"
          wrapperClassName="flex-1 min-w-[200px] max-w-xs"
          className="bg-card"
        />
        <SegmentedTabs
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={(["All", "Draft", "Live", "Paused"] as const).map((s) => ({
            value: s, label: s, count: counts[s],
          }))}
        />
        {role === "manager" && users.length > 0 && (
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="h-9 w-40 border-border bg-card shadow-sm">
              <SelectValue placeholder="Owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          message={
            list.length === 0
              ? "No campaigns yet. Create one to start sending outreach emails."
              : "No campaigns match your filters."
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((c) => {
            const style = CAMPAIGN_STATUS_STYLES[c.status] ?? CAMPAIGN_STATUS_STYLES.Draft;
            const replyRate = c.sent > 0 ? Math.round((c.replied / c.sent) * 100) : 0;
            const assigneeName = role === "manager" ? displayName(c.assignedTo) : null;
            return (
              <Card
                key={c.id}
                swatch="left"
                className="enter relative group/card flex flex-col p-5 transition-all hover:bg-secondary/30 hover:border-border/80 hover:shadow-sm"
              >
                <div className="absolute right-3 top-3 flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-all z-10">
                  {c.status === "Live" && (
                    <Button
                      type="button" variant="ghost" size="icon"
                      title="Pause campaign (stops all sending, incl. follow-ups)"
                      onClick={() => setPausingCampaign(c)}
                      className="size-8 text-muted-foreground/50 hover:text-amber-400 hover:bg-amber-500/10"
                    >
                      <Pause className="size-4" />
                    </Button>
                  )}
                  {c.status === "Paused" && (
                    <Button
                      type="button" variant="ghost" size="icon"
                      title="Resume campaign"
                      disabled={resumingId === c.id}
                      onClick={() => void handleResume(c)}
                      className="size-8 text-muted-foreground/50 hover:text-green-400 hover:bg-green-500/10 disabled:opacity-50"
                    >
                      <Play className="size-4" />
                    </Button>
                  )}
                  <Button
                    type="button" variant="ghost" size="icon"
                    title="Delete campaign"
                    onClick={() => setDeletingCampaign(c)}
                    className="size-8 text-muted-foreground/50 hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => router.push(`/campaigns/${c.id}`)}
                  className="h-auto flex-1 flex flex-col items-stretch justify-start p-0 text-left font-normal hover:bg-transparent"
                >
                  <div className="flex items-start gap-2 mb-1.5 pr-20">
                    <div className={cn("size-2 rounded-full shrink-0 mt-1.5", style.dot)} />
                    <div className="flex-1 min-w-0">
                      <p className="font-display font-semibold truncate">{c.name}</p>
                      <span className={cn(
                        "inline-block mt-1 font-mono text-[10px] font-semibold uppercase tracking-wider border rounded-md px-1.5 py-0.5 shrink-0",
                        style.badge,
                      )}>
                        {c.status}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap mb-4">
                    <span className={cn(
                      "text-[11px] px-1.5 py-0.5 rounded border",
                      c.humanInLoop
                        ? "text-blue-400 bg-blue-500/10 border-blue-500/20"
                        : "text-muted-foreground bg-secondary/50 border-border",
                    )}>
                      {c.humanInLoop ? "Human review" : "Auto-send"}
                    </span>
                    {role === "manager" && c.createdBy && userMap.has(c.createdBy) && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <User className="size-3" />
                        {displayName(c.createdBy)}
                      </span>
                    )}
                    {assigneeName && (
                      <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border text-primary bg-primary/10 border-primary/20">
                        <UserPlus className="size-3" />
                        {assigneeName}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-4 gap-1 mt-auto pt-3 border-t border-border">
                    {[
                      { label: "Leads", value: c.leads, color: "text-foreground" },
                      { label: "Sent", value: c.sent, color: "text-foreground" },
                      { label: "Replied", value: c.replied, color: "text-green-400" },
                      { label: "Reply rate", value: `${replyRate}%`, color: replyRate > 0 ? "text-green-400" : "text-muted-foreground" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="text-center">
                        <p className={cn("font-mono text-sm font-bold tabular-nums", color)}>{value}</p>
                        <p className="eyebrow mt-0.5">{label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="font-mono text-[10px] text-muted-foreground mt-3">Created {c.createdAt}</p>
                </Button>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deletingCampaign}
        title={`Delete "${deletingCampaign?.name}"?`}
        description="This will permanently delete the campaign and all its leads, drafts, and send history. This cannot be undone."
        loading={deleteCampaignLoading}
        onClose={() => { if (!deleteCampaignLoading) setDeletingCampaign(null); }}
        onConfirm={async () => {
          if (!deletingCampaign || !session || deleteCampaignLoading) return;
          const id = deletingCampaign.id;
          setDeleteCampaignLoading(true);
          try {
            await deleteCampaign(session.access_token, id);
            setCampaigns((prev) => prev.filter((c) => c.id !== id));
            setDeletingCampaign(null);
            toast.success("Campaign deleted");
            router.refresh();
          } catch (e) {
            toast.error((e as Error).message || "Failed to delete campaign");
          } finally {
            setDeleteCampaignLoading(false);
          }
        }}
      />

      <ConfirmDialog
        open={!!pausingCampaign}
        title={`Pause "${pausingCampaign?.name}"?`}
        description="Instantly stops sending this campaign, including scheduled follow-ups, until you resume it. Conversations already started are unaffected."
        confirmLabel="Pause"
        tone="warning"
        loading={pauseLoading}
        onClose={() => { if (!pauseLoading) setPausingCampaign(null); }}
        onConfirm={async () => {
          if (!pausingCampaign || !session || pauseLoading) return;
          const id = pausingCampaign.id;
          setPauseLoading(true);
          try {
            const res = await pauseCampaign(session.access_token, id);
            if (res.errors.length > 0) {
              toast.warning(`Paused ${res.paused} region(s); ${res.errors.length} failed. Try again for the rest.`);
            } else {
              toast.success("Campaign paused — Instantly has stopped sending");
            }
            setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status: "Paused" } : c)));
            setPausingCampaign(null);
            router.refresh();
          } catch (e) {
            toast.error((e as Error).message || "Failed to pause campaign");
          } finally {
            setPauseLoading(false);
          }
        }}
      />

    </div>
  );
}
