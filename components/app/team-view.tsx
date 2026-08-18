"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, RefreshCw, Eye, EyeOff, Users, ShieldCheck, MapPinOff, Radio, Pencil, X, ChevronDown } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { cn } from "@/lib/utils";
import { AppRadio } from "@/components/ui/app-radio";
import { Avatar } from "@/components/leads/lead-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AvailabilityToggle } from "@/components/ui/availability-toggle";
import { StatTile } from "@/components/ui/stat-tile";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { LocationsPicker, LocationsGrid } from "@/components/ui/locations-picker";
import { summarizeTerritory } from "@/lib/territory";
import { LOCATION_CATEGORIES } from "@/lib/constants";
import {
  fetchUsers, createUser, patchUser,
  fetchOversight, fetchSendingAccounts,
  type Profile, type HandoverStrategy, type HandoverSummary,
  type InstantlySendingAccount,
} from "@/lib/api-client";

/** Select value standing in for "no mailbox of their own" — Radix forbids "". */
const DEFAULT_MAILBOX = "__default__";

const TERRITORY_HELP =
  "Which countries' leads route to this person under territory-based assignment. Tick a region header to take the whole region.";

// Where a departing employee's book goes. Mirrors the Leads-page bulk-assign
// strategies, plus "pool" — the one option that still works when there is
// nobody left to hand the work to.
const HANDOVER_OPTIONS: {
  value: HandoverStrategy;
  label: string;
  description: string;
  /** Round-robin and territory need at least one active, online employee. */
  needsEligible: boolean;
}[] = [
  { value: "manual", label: "One person takes over", description: "Hand every lead and campaign to a single employee you pick.", needsEligible: false },
  { value: "pool", label: "Return to the pool", description: "Unassign everything and leave it in the manager pool to route later.", needsEligible: false },
  { value: "round_robin", label: "Round robin", description: "Split the leads evenly across the rest of the active team.", needsEligible: true },
  { value: "territory", label: "Territory-based", description: "Route each lead to whoever covers its country. Anything uncovered stays in the pool.", needsEligible: true },
];

function roleLabel(u: Profile): string {
  if (u.is_super_admin) return "Super Admin";
  return u.role === "manager" ? "Manager" : "Employee";
}

export function TeamView() {
  const router = useRouter();
  const { session, role, loadingSession } = useApp();

  const [users, setUsers] = useState<Profile[]>([]);
  const [counts, setCounts] = useState<Record<string, { assigned_lead_count: number; campaign_count: number }>>({});
  const [mailboxes, setMailboxes] = useState<InstantlySendingAccount[]>([]);
  const [defaultMailbox, setDefaultMailbox] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [newRole, setNewRole] = useState<"manager" | "employee">("employee");
  const [territoryCountries, setTerritoryCountries] = useState<string[]>([]);
  const [showPassword, setShowPassword] = useState(false);

  const [reassignTarget, setReassignTarget] = useState<Profile | null>(null);
  // What the SERVER says is still held, from the REASSIGN_REQUIRED response.
  // The roster's own campaign_count means "campaigns containing this person's
  // leads", which is not the same thing as "campaigns assigned to them" — and
  // it is the latter that a handover actually moves.
  const [handoverCounts, setHandoverCounts] = useState<{ held_leads: number; held_campaigns: number } | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [handoverStrategy, setHandoverStrategy] = useState<HandoverStrategy>("manual");
  const [reassigning, setReassigning] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!loadingSession && role !== "manager") router.replace("/dashboard");
  }, [loadingSession, role, router]);

  useEffect(() => {
    if (!session || role !== "manager") return;
    setLoading(true);
    Promise.all([
      fetchUsers(session.access_token),
      fetchOversight(session.access_token),
    ])
      .then(([u, o]) => {
        setUsers(u);
        setCounts(Object.fromEntries(o.employees.map((e) => [e.id, { assigned_lead_count: e.assigned_lead_count, campaign_count: e.campaign_count }])));
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));

    // Separate from the roster load on purpose: this one calls Instantly, so a
    // missing key or a provider outage must not blank out the whole team page.
    // Without it the mailbox column just has nothing to offer.
    fetchSendingAccounts(session.access_token)
      .then((s) => { setMailboxes(s.accounts); setDefaultMailbox(s.selected_email); })
      .catch(() => { /* column degrades to read-only text */ });
  }, [session, role]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!session) return;
    if (newRole === "employee" && territoryCountries.length === 0) {
      toast.error("Pick at least one country — employees need a territory for lead routing.");
      return;
    }
    setSaving(true);
    try {
      const created = await createUser(session.access_token, {
        email, password, full_name: fullName, role: newRole,
        territory_countries: newRole === "employee" ? territoryCountries : [],
      });
      setUsers((prev) => [...prev, created]);
      setShowAdd(false);
      setEmail(""); setPassword(""); setFullName(""); setNewRole("employee"); setTerritoryCountries([]); setShowPassword(false);
      toast.success("User created");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Resolves to the updated profile on success (carrying the handover summary
  // when the patch performed one) and null on failure, so callers can report
  // what actually happened rather than just that something did.
  async function handlePatch(
    id: string,
    patch: Partial<{ role: "manager" | "employee"; territory_countries: string[]; is_active: boolean; availability_status: "online" | "offline"; handover_strategy: HandoverStrategy; reassign_to: string; sending_email: string | null }>,
  ): Promise<(Profile & { handover?: HandoverSummary }) | null> {
    if (!session) return null;
    try {
      const updated = await patchUser(session.access_token, id, patch);
      setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
      return updated;
    } catch (e) {
      const err = e as Error & { code?: string; details?: unknown };
      // Backend requires an explicit handover decision before deactivating
      // someone who still holds leads/campaigns — pop the picker instead of
      // just erroring out.
      if (err.code === "REASSIGN_REQUIRED" && patch.is_active === false) {
        const target = users.find((u) => u.id === id);
        const held = err.details as { held_leads?: number; held_campaigns?: number } | undefined;
        if (target) openHandover(target, { held_leads: held?.held_leads ?? 0, held_campaigns: held?.held_campaigns ?? 0 });
        return null;
      }
      toast.error(err.message);
      return null;
    }
  }

  // Round-robin and territory both need somebody active AND online who isn't the
  // person leaving; default to whichever strategy can actually run, so the modal
  // never opens on a disabled option.
  function openHandover(u: Profile, held: { held_leads: number; held_campaigns: number }) {
    const hasEligible = users.some(
      (e) => e.role === "employee" && e.is_active && e.availability_status === "online" && e.id !== u.id,
    );
    setHandoverStrategy(hasEligible ? "manual" : "pool");
    setReassignTo("");
    setHandoverCounts(held);
    setReassignTarget(u);
  }

  // Always asks the server first rather than gating on the roster's counts:
  // those are a different measure (see handoverCounts) and can be stale anyway.
  // Someone holding nothing is deactivated by this single call; anyone still
  // holding work comes back as REASSIGN_REQUIRED and opens the modal with the
  // real numbers.
  async function handleDeactivateClick(u: Profile) {
    setDeactivatingId(u.id);
    try {
      await handlePatch(u.id, { is_active: false });
    } finally {
      setDeactivatingId(null);
    }
  }

  async function handleConfirmReassign() {
    if (!reassignTarget) return;
    if (handoverStrategy === "manual" && !reassignTo) return;
    setReassigning(true);
    try {
      const updated = await handlePatch(reassignTarget.id, {
        is_active: false,
        handover_strategy: handoverStrategy,
        ...(handoverStrategy === "manual" ? { reassign_to: reassignTo } : {}),
      });
      if (updated) {
        const name = reassignTarget.full_name || reassignTarget.email;
        toast.success(`${name} deactivated.`, { description: describeHandover(updated.handover, users) });
        // Their book is gone, so the roster's workload column is now wrong for
        // both them and whoever inherited it.
        if (session) {
          fetchOversight(session.access_token)
            .then((o) => setCounts(Object.fromEntries(o.employees.map((e) => [e.id, { assigned_lead_count: e.assigned_lead_count, campaign_count: e.campaign_count }]))))
            .catch(() => { /* the roster is still correct; only the counts are stale */ });
        }
        setReassignTarget(null);
        setReassignTo("");
        setHandoverCounts(null);
      }
    } finally {
      setReassigning(false);
    }
  }

  const me = users.find((u) => u.id === session?.user.id);
  const isSuperAdmin = me?.is_super_admin ?? false;
  const activeCount = users.filter((u) => u.is_active).length;
  const managerCount = users.filter((u) => u.role === "manager").length;
  const employeeCount = users.filter((u) => u.role === "employee").length;
  const awayCount = users.filter((u) => u.role === "employee" && u.is_active && u.availability_status === "offline").length;

  // Territory-based routing (auto-assignment and manual territory bulk-assign
  // alike) silently skips leads with no covering active employee — surface
  // the gap here instead of letting leads pile up in the pool unnoticed.
  // A region counts as uncovered only when NOT ONE of its countries is held by
  // an active employee; partial coverage is a deliberate choice, not a gap.
  const uncoveredTerritories = !loading
    ? LOCATION_CATEGORIES.filter((region) => {
        const covered = new Set(
          users
            .filter((u) => u.role === "employee" && u.is_active)
            .flatMap((u) => u.territory_countries ?? []),
        );
        return !region.countries.some((c) => covered.has(c));
      })
    : [];

  if (loadingSession || role !== "manager") return null;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 enter">
      {uncoveredTerritories.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          <span className="font-semibold">No active employee covers {uncoveredTerritories.map((t) => t.label).join(", ")}.</span>{" "}
          Leads from {uncoveredTerritories.length > 1 ? "these regions" : "this region"} will pile up unassigned in the manager pool until someone is added or reactivated there.
        </div>
      )}

      {/* Overview strip — headcount + coverage at a glance, above the roster. */}
      <div className="space-y-3">
        <p className="eyebrow px-1">Team · overview</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatTile layout="row" label="Active" value={loading ? "—" : activeCount} icon={Users} sub={`of ${users.length} total`} />
          <StatTile layout="row" label="Managers" value={loading ? "—" : managerCount} icon={ShieldCheck} />
          <StatTile layout="row" label="Employees" value={loading ? "—" : employeeCount} icon={Users} />
          <StatTile
            layout="row"
            label="Away"
            value={loading ? "—" : awayCount}
            icon={Radio}
            tone={awayCount > 0 ? "amber" : "neutral"}
            sub="excluded from routing"
          />
          <StatTile
            layout="row"
            label="Territory gaps"
            value={loading ? "—" : uncoveredTerritories.length}
            icon={MapPinOff}
            tone={uncoveredTerritories.length > 0 ? "red" : "neutral"}
            sub={uncoveredTerritories.length > 0
              ? uncoveredTerritories.slice(0, 3).map((t) => t.label).join(", ") + (uncoveredTerritories.length > 3 ? ` +${uncoveredTerritories.length - 3}` : "")
              : "fully covered"}
          />
        </div>
      </div>

      <div className="rounded-md border border-border bg-card overflow-hidden min-w-0">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <p className="eyebrow">Team</p>
            <h2 className="font-display text-lg font-semibold mt-0.5">Users</h2>
          </div>
          <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
            <UserPlus className="size-3.5 mr-1.5" /> Add user
          </Button>
        </div>

        {showAdd && (
          <form
            onSubmit={handleCreate}
            className="grid grid-cols-1 sm:grid-cols-2 gap-3 px-5 py-4 border-b border-border bg-secondary/30 enter"
          >
            <p className="eyebrow sm:col-span-2 -mb-1">New user</p>
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="pr-9"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 h-full w-9 rounded-none text-muted-foreground hover:bg-transparent hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={newRole} onValueChange={(v) => setNewRole(v as "manager" | "employee")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newRole === "employee" && (
              <div className="space-y-1.5 sm:col-span-2">
                <LocationsPicker
                  selected={territoryCountries}
                  onChangeSelected={setTerritoryCountries}
                  label="Territory *"
                  helpText={TERRITORY_HELP}
                  placeholder="Pick countries or whole regions (required)"
                />
                <p className="text-xs text-muted-foreground">
                  Decides which leads route to them under territory-based assignment.
                  {territoryCountries.length > 0 && (
                    <> Currently: <span className="text-foreground">{summarizeTerritory(territoryCountries)}</span>.</>
                  )}
                </p>
              </div>
            )}
            <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <RefreshCw className="size-3.5 mr-1.5 animate-spin" />} Create
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground px-5 py-10 text-center">Loading users…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground px-5 py-10 text-center">No users yet. Add one to get started.</p>
        ) : (
          <ul className="divide-y divide-border">
            {users.map((u) => {
              const canEditRole = !u.is_super_admin && isSuperAdmin;
              const canToggleActive = !u.is_super_admin && (isSuperAdmin || u.role === "employee");
              // Mirrors the API's rule exactly: the Super Admin edits anyone
              // (themselves included), a manager only employees. Unlike
              // deactivation, there is nothing dangerous about a Super Admin
              // choosing their own sending mailbox.
              const canEditMailbox = isSuperAdmin || u.role === "employee";
              const leadCount = counts[u.id]?.assigned_lead_count ?? 0;
              const campaignCount = counts[u.id]?.campaign_count ?? 0;
              const displayName = u.full_name || u.email;
              const expanded = expandedId === u.id;

              return (
                <li
                  key={u.id}
                  className={cn(
                    "min-w-0 transition-colors",
                    !u.is_active && "opacity-60",
                    expanded && "bg-secondary/25",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : u.id)}
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-5 py-3.5 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <Avatar name={displayName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                        <p className="text-sm font-semibold truncate">{displayName}</p>
                        {u.is_super_admin && (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-primary/15 text-primary border border-primary/25">
                            Super Admin
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 min-w-0 flex-wrap">
                        <p className="text-xs font-mono text-muted-foreground truncate">{u.email}</p>
                        <span className="text-muted-foreground/40 hidden sm:inline" aria-hidden>·</span>
                        <span className="text-xs text-muted-foreground hidden sm:inline">{roleLabel(u)}</span>
                        {u.role === "employee" && (
                          <>
                            <span className="text-muted-foreground/40 hidden sm:inline" aria-hidden>·</span>
                            <span className="text-xs font-mono text-muted-foreground tabular-nums hidden sm:inline">
                              {leadCount} leads · {campaignCount} campaigns
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 text-xs font-medium",
                          u.is_active ? "text-emerald-400" : "text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            u.is_active ? "bg-emerald-400" : "bg-muted-foreground/50",
                          )}
                          aria-hidden
                        />
                        {u.is_active
                          ? (u.role === "employee" && u.availability_status === "offline" ? "Away" : "Active")
                          : "Inactive"}
                      </span>
                      <ChevronDown
                        className={cn(
                          "size-4 text-muted-foreground transition-transform duration-200",
                          expanded && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </div>
                  </button>

                  {expanded && (
                    <div className="space-y-4 border-t border-border/60 px-5 pb-4 pt-3 enter">
                      {u.role === "employee" && (
                        <div className="grid grid-cols-2 gap-3 sm:hidden">
                          <div className="rounded-md border border-border bg-card px-3 py-2">
                            <p className="eyebrow">Leads</p>
                            <p className="mt-0.5 font-mono text-sm tabular-nums">{leadCount}</p>
                          </div>
                          <div className="rounded-md border border-border bg-card px-3 py-2">
                            <p className="eyebrow">Campaigns</p>
                            <p className="mt-0.5 font-mono text-sm tabular-nums">{campaignCount}</p>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Role</Label>
                          {canEditRole ? (
                            <Select value={u.role} onValueChange={(v) => handlePatch(u.id, { role: v as "manager" | "employee" })}>
                              <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="employee">Employee</SelectItem>
                                <SelectItem value="manager">Manager</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="inline-flex h-9 w-full items-center px-2.5 rounded-md border border-border bg-secondary/40 font-mono text-xs text-muted-foreground">
                              {roleLabel(u)}
                            </span>
                          )}
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs text-muted-foreground">Sends from</Label>
                          <MailboxCell
                            value={u.sending_email}
                            accounts={mailboxes}
                            defaultMailbox={defaultMailbox}
                            disabled={!canEditMailbox}
                            onChange={(next) => handlePatch(u.id, { sending_email: next })}
                          />
                        </div>

                        {u.role === "employee" && (
                          <div className="space-y-1.5 sm:col-span-2">
                            <Label className="text-xs text-muted-foreground">Territory</Label>
                            <TerritoryCell
                              countries={u.territory_countries ?? []}
                              onSave={(next) => handlePatch(u.id, { territory_countries: next })}
                            />
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                        {u.is_active && u.role === "employee" ? (
                          <AvailabilityToggle
                            status={u.availability_status}
                            showLabel
                            onToggle={() =>
                              void handlePatch(u.id, {
                                availability_status: u.availability_status === "offline" ? "online" : "offline",
                              })
                            }
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {u.is_active ? "Always available" : "Account inactive"}
                          </span>
                        )}

                        {canToggleActive ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={deactivatingId === u.id}
                            className={cn(
                              "h-8 text-xs",
                              u.is_active
                                ? "border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-400",
                            )}
                            onClick={() => (u.is_active ? void handleDeactivateClick(u) : void handlePatch(u.id, { is_active: true }))}
                          >
                            {deactivatingId === u.id && <RefreshCw className="size-3 mr-1.5 animate-spin" />}
                            {u.is_active ? "Deactivate" : "Reactivate"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {reassignTarget && (
        <HandoverBeforeDeactivateModal
          target={reassignTarget}
          held={handoverCounts}
          employees={users.filter((u) => u.role === "employee" && u.is_active && u.id !== reassignTarget.id)}
          strategy={handoverStrategy}
          onStrategyChange={setHandoverStrategy}
          value={reassignTo}
          onChange={setReassignTo}
          saving={reassigning}
          onConfirm={handleConfirmReassign}
          onCancel={() => { setReassignTarget(null); setReassignTo(""); setHandoverCounts(null); }}
        />
      )}
    </div>
  );
}

/** One-line account of where the work actually went, for the success toast. */
function describeHandover(handover: HandoverSummary | undefined, users: Profile[]): string {
  if (!handover) return "They held no leads or campaigns.";

  const nameOf = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? u.full_name || u.email : "an employee";
  };
  const parts: string[] = [];

  if (handover.strategy === "pool") {
    parts.push(`${handover.leads_total} lead${handover.leads_total !== 1 ? "s" : ""} and ${handover.campaigns_total} campaign${handover.campaigns_total !== 1 ? "s" : ""} returned to the pool`);
  } else {
    if (handover.leads_reassigned > 0) {
      const people = handover.per_assignee.filter((a) => a.leads > 0);
      const who = people.length === 1
        ? nameOf(people[0].employee_id)
        : `${people.length} employees`;
      parts.push(`${handover.leads_reassigned} lead${handover.leads_reassigned !== 1 ? "s" : ""} → ${who}`);
    }
    if (handover.campaigns_reassigned > 0) {
      parts.push(`${handover.campaigns_reassigned} campaign${handover.campaigns_reassigned !== 1 ? "s" : ""} reassigned`);
    }
    // Territory routing leaves anything nobody covers behind — say so, because
    // those leads are now sitting in the pool waiting for a manager.
    const leftOver = [
      handover.leads_to_pool > 0 ? `${handover.leads_to_pool} lead${handover.leads_to_pool !== 1 ? "s" : ""}` : null,
      handover.campaigns_to_pool > 0 ? `${handover.campaigns_to_pool} campaign${handover.campaigns_to_pool !== 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" and ");
    if (leftOver) {
      parts.push(
        handover.strategy === "territory"
          ? `${leftOver} left in the pool — nobody covers them`
          : `${leftOver} left in the pool`,
      );
    }
  }

  return parts.length > 0 ? parts.join(" · ") : "Nothing needed to move.";
}

function HandoverBeforeDeactivateModal({
  target,
  held,
  employees,
  strategy,
  onStrategyChange,
  value,
  onChange,
  saving,
  onConfirm,
  onCancel,
}: {
  target: Profile;
  /** Server-reported counts of what this handover will actually move. */
  held: { held_leads: number; held_campaigns: number } | null;
  /** Active employees other than the one leaving — the manual-target candidates. */
  employees: Profile[];
  strategy: HandoverStrategy;
  onStrategyChange: (v: HandoverStrategy) => void;
  value: string;
  onChange: (v: string) => void;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const displayName = target.full_name || target.email;
  const leadCount = held?.held_leads ?? 0;
  const campaignCount = held?.held_campaigns ?? 0;

  // Manual may name an offline employee (a deliberate manager choice, warned
  // about). Round-robin and territory only ever draw from online employees, so
  // they are the ones that can run out of candidates.
  const eligible = employees.filter((e) => e.availability_status === "online");
  const awayCount = employees.length - eligible.length;
  const targetIsOffline = !!value && employees.find((e) => e.id === value)?.availability_status === "offline";

  const blocked = strategy === "manual" && !value;

  return (
    <div className="fixed inset-0 z-200 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={saving ? undefined : onCancel} />
      <div className="swatch-bar relative z-10 w-full max-w-md mx-4 rounded-2xl border border-border bg-card shadow-2xl p-6 pl-7 space-y-4 enter max-h-[90vh] overflow-y-auto">
        <div>
          <p className="eyebrow">Handover required</p>
          <p className="font-display text-base font-semibold mt-0.5">Where does this work go?</p>
          <p className="text-xs text-muted-foreground mt-1">
            {displayName} still holds{" "}
            {[
              leadCount > 0 ? `${leadCount.toLocaleString()} lead${leadCount !== 1 ? "s" : ""}` : null,
              campaignCount > 0 ? `${campaignCount} campaign${campaignCount !== 1 ? "s" : ""}` : null,
            ].filter(Boolean).join(" and ")}.{" "}
            Choose where it goes before this account is deactivated.
          </p>
        </div>

        <div className="grid gap-2">
          {HANDOVER_OPTIONS.map((o) => {
            const disabled = o.needsEligible && eligible.length === 0;
            const checked = strategy === o.value;
            return (
              <label
                key={o.value}
                onClick={() => { if (!disabled && !saving) onStrategyChange(o.value); }}
                className={cn(
                  "flex items-start gap-3 rounded-lg border border-border p-3 bg-field",
                  disabled
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer hover:bg-field",
                  checked && !disabled && "border-primary bg-primary/5",
                )}
              >
                <AppRadio checked={checked} disabled={disabled || saving} className="mt-1" />
                <div>
                  <p className="text-sm font-medium">{o.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {o.description}
                    {disabled && " Needs at least one other active, online employee."}
                  </p>
                </div>
              </label>
            );
          })}
        </div>

        {strategy === "manual" && (
          <div className="space-y-1.5">
            <Label>Hand everything to</Label>
            <Select value={value} onValueChange={onChange}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose an employee" /></SelectTrigger>
              <SelectContent className="z-300">
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.full_name || e.email}{e.availability_status === "offline" ? " (offline)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {employees.length === 0 && (
              <p className="text-xs text-destructive">
                No other active employee exists. Use &ldquo;Return to the pool&rdquo; instead.
              </p>
            )}
            {targetIsOffline && (
              <p className="text-xs text-amber-400">
                This employee is marked offline — they will still receive the whole book.
              </p>
            )}
          </div>
        )}

        {(strategy === "round_robin" || strategy === "territory") && (
          <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
            <p>
              Splitting across <span className="text-foreground font-medium">{eligible.length}</span> active, online
              employee{eligible.length !== 1 ? "s" : ""}
              {awayCount > 0 && <> ({awayCount} offline {awayCount !== 1 ? "are" : "is"} excluded)</>}.
            </p>
            {campaignCount > 0 && <p>Each campaign follows whoever inherits most of its leads.</p>}
            {strategy === "territory" && <p>Leads in countries nobody covers stay in the pool.</p>}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={onConfirm} disabled={saving || blocked}>
            {saving && <RefreshCw className="size-3.5 mr-1.5 animate-spin" />} Hand over &amp; deactivate
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which Instantly mailbox this person's leads go out from.
 *
 * Instantly picks the sender per campaign, not per lead, so this choice is what
 * splits a campaign's country buckets into one Instantly campaign per sender.
 * Changing it only affects leads sent from here on: a sub-campaign already
 * running keeps its original mailbox, and replies always go back out from the
 * mailbox that owns the thread.
 */
function MailboxCell({
  value,
  accounts,
  defaultMailbox,
  disabled,
  onChange,
}: {
  value: string | null;
  accounts: InstantlySendingAccount[];
  defaultMailbox: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
}) {
  // The assigned mailbox may be missing from `accounts` — the list is still
  // loading, Instantly is unreachable, or the mailbox was disconnected there.
  // Carry it as its own option so the cell never renders blank.
  const known = accounts.some((a) => a.email.toLowerCase() === (value ?? "").toLowerCase());

  return (
    <Select
      value={value ?? DEFAULT_MAILBOX}
      onValueChange={(v) => onChange(v === DEFAULT_MAILBOX ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger
        title={value ?? (defaultMailbox ? `Company default — ${defaultMailbox}` : "Company default")}
        className={cn("h-9 w-full font-mono text-xs", !value && "text-muted-foreground")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_MAILBOX}>
          Default{defaultMailbox ? ` · ${defaultMailbox.split("@")[0]}` : ""}
        </SelectItem>
        {value && !known && <SelectItem value={value}>{value.split("@")[0]} (not connected)</SelectItem>}
        {accounts.map((a) => (
          <SelectItem key={a.email} value={a.email} disabled={!a.can_send}>
            {a.email.split("@")[0]}{a.can_send ? "" : ` · ${a.status_label}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Territory picker trigger.
 *
 * The picker is a 5-column grid of every region, which cannot live inline in
 * the roster: the users panel is `overflow-hidden`, so an absolutely-positioned
 * panel gets clipped. The trigger therefore shows a summary — "India",
 * "Western Europe", "3 regions · 41 countries" — and opens the grid in a modal
 * portalled to <body>.
 *
 * Edits are held in a draft and written once on Save, so ticking a 17-country
 * region is one request rather than seventeen.
 */
function TerritoryCell({
  countries,
  onSave,
}: {
  countries: string[];
  onSave: (next: string[]) => void | Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(countries);
  const [saving, setSaving] = useState(false);

  const summary = summarizeTerritory(countries);
  const empty = countries.length === 0;

  const dirty = draft.length !== countries.length || draft.some((c) => !countries.includes(c));

  function openEditor() {
    setDraft(countries);
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={openEditor}
        title={empty
          ? "No territory — excluded from routing"
          : `${countries.length} countries: ${countries.slice(0, 12).join(", ")}${countries.length > 12 ? "…" : ""}`}
        className={cn(
          "h-9 w-full justify-between gap-1.5 bg-background px-2.5 font-mono text-xs",
          empty && "border-amber-500/40 text-amber-400",
        )}
      >
        <span className="truncate">{empty ? "Set territory" : summary}</span>
        <Pencil className="size-3 shrink-0 opacity-60" />
      </Button>

      {open && <TerritoryModal
        draft={draft}
        setDraft={setDraft}
        dirty={dirty}
        saving={saving}
        onSave={save}
        onCancel={() => setOpen(false)}
      />}
    </>
  );
}

function TerritoryModal({
  draft, setDraft, dirty, saving, onSave, onCancel,
}: {
  draft: string[];
  setDraft: (v: string[]) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={saving ? undefined : onCancel} />
      <div className="swatch-bar-top enter relative z-10 mx-4 flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <p className="eyebrow">Territory</p>
            <h2 className="font-display text-base font-semibold mt-0.5">
              Which countries&apos; leads route here
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">{TERRITORY_HELP}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onCancel} disabled={saving} className="size-8 shrink-0 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <LocationsGrid selected={draft} onChangeSelected={setDraft} maxHeightClassName="max-h-[55vh]" />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <p className="text-xs text-muted-foreground">
            {draft.length === 0
              ? "No countries — this employee is skipped by territory routing."
              : summarizeTerritory(draft)}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={onSave} disabled={saving || !dirty}>
              {saving && <RefreshCw className="size-3.5 mr-1.5 animate-spin" />}
              Save territory
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
