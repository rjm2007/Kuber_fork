"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { AlertCircle, Check, CheckCircle2, FileText, Plus, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { badgeVariants } from "@/components/ui/badge";
import { StatTile } from "@/components/ui/stat-tile";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LOCATION_MAP, APOLLO_TITLES, APOLLO_SENIORITIES, EMPLOYEE_RANGES, BATCH_COLORS, getBatchColor, resolveApolloKeyword, parseIndustryKeywordGroups, type BatchColorName, type IndustryKeywordGroup } from "@/lib/constants";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { InfoTip } from "@/components/ui/info-tip";
import { ApolloPeopleAdvanced, buildPeopleAdvanced } from "@/components/app/apollo-people-advanced";
import { ApolloCostNote } from "@/components/app/apollo-cost-note";
import { apolloPreview, importExcelDirect, createLead, patchLead, patchOrg, fetchUsers, fetchUsage, fetchSettings, patchSettings, type Profile, type PreviewLead, type DuplicateOwner } from "@/lib/api-client";
import { ensureSplitNames } from "@/lib/utils/person-name";
import { supabase } from "@/lib/supabase";
import { BatchConfirmModal } from "@/components/app/batch-confirm-modal";
import { Stepper } from "@/components/ui/stepper";
import { Pill } from "@/components/ui/pill";

// Exported so the Company Lookup wizard reuses these verbatim rather than
// growing a second copy of the batch/assignment controls that then drifts.
export async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}

// ─── BatchNameField ───────────────────────────────────────────────────────────

export function BatchNameField({
  value,
  onChange,
  color,
  onColorChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  color: string;
  onColorChange: (c: string) => void;
  error?: boolean;
}) {
  const [swatchOpen, setSwatchOpen] = useState(false);
  const swatchRef = useRef<HTMLDivElement>(null);
  const c = getBatchColor(color);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (swatchRef.current && !swatchRef.current.contains(e.target as Node)) setSwatchOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="rounded-xl p-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium text-muted-foreground">Batch Name</span>
            <span className="text-destructive text-xs">*</span>
            <InfoTip
              side="right"
              text="Name this import so you can recognise it later (e.g. 'India Plastics Q3'). The name becomes a coloured tag on every lead in this batch."
            />
            {value.trim() && (
              <Pill color={color as BatchColorName} dot className="ml-1 px-1.5 text-[10px]">{value}</Pill>
            )}
          </div>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="e.g. India Plastics Q3…"
            className={cn("h-8 text-sm", error && "border-destructive focus-visible:ring-destructive")}
          />
          {error && (
            <p className="text-[10px] text-destructive flex items-center gap-1">
              <AlertCircle className="size-3 shrink-0" /> Batch name is required
            </p>
          )}
        </div>
        <div ref={swatchRef} className="relative shrink-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground block">Colour</span>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSwatchOpen((o) => !o)}
            className={cn(
              "h-8 gap-2 rounded-md px-3 text-sm font-normal bg-field hover:bg-field",
              swatchOpen && "ring-2 ring-ring border-transparent",
            )}
          >
            <span className={cn("size-3.5 rounded-full shrink-0", c.bg)} />
            <span className="capitalize text-xs">{color}</span>
          </Button>
          {swatchOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-10 rounded-xl border border-border bg-popover shadow-xl p-3.5 grid grid-cols-4 gap-3.5 w-[188px]">
              {BATCH_COLORS.map((bc) => (
                <button
                  key={bc.name}
                  type="button"
                  title={bc.name}
                  onClick={() => { onColorChange(bc.name); setSwatchOpen(false); }}
                  className={cn(
                    "size-8 rounded-full transition-all",
                    bc.bg,
                    color === bc.name
                      ? "ring-2 ring-white ring-offset-2 ring-offset-popover scale-110"
                      : "hover:scale-110 opacity-80 hover:opacity-100",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── AssignToField ────────────────────────────────────────────────────────────
// Shared by all three add-lead tabs (Apollo, Excel, Manual): lets the Manager
// route the whole imported batch to one employee at creation time, instead of
// leaving every lead in the pool for manual assignment later.

export function useAssignableEmployees(enabled: boolean) {
  const [employees, setEmployees] = useState<Profile[]>([]);

  useEffect(() => {
    if (!enabled) return;
    getToken().then((token) => fetchUsers(token)).then((users) => {
      setEmployees(users.filter((u) => u.role === "employee" && u.is_active));
    }).catch(() => {});
  }, [enabled]);

  return employees;
}

// The Industry Segments taxonomy (Settings > Industry Segments) is
// per-company data now, not a compile-time constant — fetched once per form
// so both the dropdown and the keyword-group-count summary below it agree.
function useIndustryKeywordGroups() {
  const [groups, setGroups] = useState<IndustryKeywordGroup[]>([]);

  useEffect(() => {
    getToken().then((token) => fetchSettings(token)).then((settings) => {
      setGroups(parseIndustryKeywordGroups(settings.industry_keyword_groups));
    }).catch(() => {});
  }, []);

  return [groups, setGroups] as const;
}

function AssignToField({
  employees,
  value,
  onChange,
}: {
  employees: Profile[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (employees.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <Label>Assign to</Label>
      <Select value={value || "unassigned"} onValueChange={(v) => onChange(v === "unassigned" ? "" : v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Leave in pool (unassigned)</SelectItem>
          {employees.map((e) => (
            <SelectItem key={e.id} value={e.id}>{e.full_name || e.email}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── AssignStrategyPicker ─────────────────────────────────────────────────────
// Batch imports (Apollo, Excel) can distribute leads as they land: to one
// employee, spread round-robin (least-loaded first), or by territory
// (India / rest of world).

export type ImportAssignMode = "pool" | "manual" | "round_robin" | "territory";

const ASSIGN_MODE_OPTIONS: { value: ImportAssignMode; label: string; hint: string }[] = [
  { value: "pool",        label: "Leave in pool",      hint: "Unassigned — distribute later from the Leads page." },
  { value: "manual",      label: "One employee",       hint: "The whole batch goes to one person." },
  { value: "round_robin", label: "Round-robin",        hint: "Spread across all active employees, least-loaded first." },
  { value: "territory",   label: "By territory",       hint: "India → India reps, everything else → Foreign reps. Leads without a country stay in the pool." },
];

/** Request fields for the chosen mode — matches the import APIs.
 *
 * "pool" MUST send an explicit strategy. It used to return {}, and an absent
 * assignment_strategy does not mean "leave alone" — importChoiceFor() reads it
 * as "no preference" and falls through to the company-wide default, which on
 * the live account is round_robin. So the one option whose entire purpose is
 * "assign nobody" silently assigned the whole batch to everybody. Reported by
 * the client on 2026-09-04 after a 400-lead import scattered across the team.
 *
 * 'manual' with no target is exactly "leave in pool" in resolveAssignee, and is
 * already permitted by imports_assignment_strategy_check — so this needs no
 * migration and no new enum value. */
export function buildImportAssignment(mode: ImportAssignMode, assignTo: string):
  { assigned_to?: string; assignment_strategy?: "manual" | "round_robin" | "territory" } {
  if (mode === "manual" && assignTo) return { assigned_to: assignTo };
  if (mode === "round_robin" || mode === "territory") return { assignment_strategy: mode };
  return { assignment_strategy: "manual" };
}

export function AssignStrategyPicker({
  employees,
  mode,
  onModeChange,
  assignTo,
  onAssignToChange,
}: {
  employees: Profile[];
  mode: ImportAssignMode;
  onModeChange: (m: ImportAssignMode) => void;
  assignTo: string;
  onAssignToChange: (v: string) => void;
}) {
  if (employees.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <Label>Assign imported leads</Label>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {ASSIGN_MODE_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            variant="outline"
            onClick={() => onModeChange(opt.value)}
            className={cn(
              "h-auto flex-col items-start justify-start gap-0 rounded-lg p-3 text-left font-normal",
              mode === opt.value
                ? "border-primary bg-primary/10 hover:bg-primary/10 hover:text-foreground"
                : "border-border bg-field hover:bg-field hover:border-muted-foreground/40",
            )}
          >
            <p className="text-sm font-medium">{opt.label}</p>
            <p className="text-xs text-muted-foreground mt-1 whitespace-normal">{opt.hint}</p>
          </Button>
        ))}
      </div>
      {mode === "manual" && (
        <Select value={assignTo || "unassigned"} onValueChange={(v) => onAssignToChange(v === "unassigned" ? "" : v)}>
          <SelectTrigger><SelectValue placeholder="Pick an employee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Pick an employee…</SelectItem>
            {employees.map((e) => (
              <SelectItem key={e.id} value={e.id}>{e.full_name || e.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// Surfaces WHO already owns a skipped duplicate — previously the importer was
// just told "N skipped" with no idea the lead already belongs to someone else
// (review §3.3). Shown as a toast right after import completes.
function notifyDuplicateOwners(duplicates: DuplicateOwner[] | undefined, employees: Profile[]) {
  if (!duplicates || duplicates.length === 0) return;
  const ownerName = (id: string | null) => {
    if (!id) return "the pool (unassigned)";
    return employees.find((e) => e.id === id)?.full_name
      || employees.find((e) => e.id === id)?.email
      || "another user";
  };
  const sample = duplicates.slice(0, 3).map((d) => {
    const who = d.email ?? d.name ?? "a lead";
    return `${who} (owned by ${ownerName(d.assigned_to)})`;
  }).join(", ");
  const more = duplicates.length > 3 ? ` and ${duplicates.length - 3} more` : "";
  toast.warning(`${duplicates.length} lead${duplicates.length === 1 ? "" : "s"} already exist${duplicates.length === 1 ? "s" : ""} — skipped: ${sample}${more}.`, { duration: 8000 });
}

// ─── IndustryKeywordsDropdown ─────────────────────────────────────────────────

function IndustryKeywordsDropdown({
  selected,
  onChange,
  groups,
  onGroupsChange,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
  groups: IndustryKeywordGroup[];
  onGroupsChange: (groups: IndustryKeywordGroup[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [targetGroupId, setTargetGroupId] = useState("");
  const [adding, setAdding] = useState(false);
  /** Which keyword's Apollo term is being edited inline, and the draft value.
   *  Editing lives here rather than only in Settings because the moment a
   *  manager notices a wrong search word is while they are picking keywords —
   *  sending them to Settings loses the selection they are halfway through. */
  const [editingKwId, setEditingKwId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingKw, setSavingKw] = useState(false);
  /** Live reachability of the keyword being typed. A term that finds nothing is
   *  otherwise saved into the company's taxonomy and returns zero on every
   *  future import — which is exactly what happened on 2026-09-07, when eleven
   *  hand-typed terms of the shape "Plastic Bag Manufacturer" produced four
   *  empty batches before anyone realised the wording was the problem.
   *  Checking costs nothing: people-search is free. */
  const [kwCheck, setKwCheck] = useState<{ total: number; suggestion: { term: string; count: number } | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as HTMLElement;
      // The group Select's popover is portaled to document.body (Radix), so it
      // never appears inside `ref` — without this check, picking a group from
      // it registered as an "outside" click and closed the whole panel.
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Default the "add to which group" choice to the first group once the
  // company's taxonomy has loaded.
  useEffect(() => {
    if (!targetGroupId && groups.length > 0) setTargetGroupId(groups[0].id);
  }, [groups, targetGroupId]);

  // Debounced so a manager typing "shopping bags" does not fire eight searches.
  useEffect(() => {
    const term = customInput.trim();
    if (term.length < 3) { setKwCheck(null); setChecking(false); return; }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const token = await getToken();
        const res = await apolloPreview(token, { keywords: [term], locations: [], batch_name: "keyword check" });
        if (!cancelled) setKwCheck({ total: res.total_entries ?? 0, suggestion: res.suggestion ?? null });
      } catch {
        if (!cancelled) setKwCheck(null); // a failed check must never block adding
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(t); setChecking(false); };
  }, [customInput]);

  const allKeywordLabels = groups.flatMap((g) => g.keywords.map((k) => k.label));

  /** Persist a changed Apollo term for one keyword. Same setting Settings >
   *  Industry Segments writes, so the two screens cannot disagree. */
  async function saveKeywordQuery(groupId: string, kwId: string) {
    const query = editDraft.trim();
    if (!query) { toast.error("The search word cannot be empty."); return; }
    const updated = groups.map((g) => g.id !== groupId ? g : {
      ...g,
      keywords: g.keywords.map((k) => k.id === kwId ? { ...k, query } : k),
    });
    setSavingKw(true);
    try {
      const token = await getToken();
      await patchSettings(token, { industry_keyword_groups: JSON.stringify(updated) });
      onGroupsChange(updated);
      setEditingKwId(null);
      toast.success(`Now searching "${query}" for this keyword.`);
    } catch (e) {
      toast.error((e as Error).message || "Could not save the search word.");
    } finally {
      setSavingKw(false);
    }
  }

  function toggleKw(label: string) {
    onChange(selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label]);
  }

  function toggleCategoryKws(kws: string[]) {
    const allSelected = kws.every((k) => selected.includes(k));
    if (allSelected) {
      onChange(selected.filter((s) => !kws.includes(s)));
    } else {
      onChange([...selected, ...kws.filter((k) => !selected.includes(k))]);
    }
  }

  // Attaches the typed label as a real keyword on an existing group and saves
  // it to the company's settings immediately — it must survive this session
  // and show up for every future import, not just live in local state like
  // the old flat "custom keyword" bucket did. Creating a brand-new group is a
  // Settings-only action (Settings > Industry Segments).
  async function addKeywordToGroup() {
    const label = customInput.trim();
    const targetGroup = groups.find((g) => g.id === targetGroupId);
    if (!label || !targetGroup) return;
    if (targetGroup.keywords.some((k) => k.label.toLowerCase() === label.toLowerCase())) {
      toast.error(`"${label}" is already in ${targetGroup.label}.`);
      return;
    }
    // The NAME stays exactly what was typed — that is what the manager
    // recognises in the list. The QUERY is the wording that actually finds
    // companies, which is not always the same thing: saving `query: label`
    // verbatim is how "Plastic Bag Manufacturer" would become a permanent
    // keyword that returns zero on every future import. The live check above
    // already knows the working form, so use it.
    const deadTerm = kwCheck !== null && kwCheck.total === 0;
    const query = deadTerm && kwCheck?.suggestion ? kwCheck.suggestion.term : label;
    const updatedGroups = groups.map((g) =>
      g.id === targetGroupId ? { ...g, keywords: [...g.keywords, { id: crypto.randomUUID(), label, query }] } : g,
    );
    setAdding(true);
    try {
      const token = await getToken();
      await patchSettings(token, { industry_keyword_groups: JSON.stringify(updatedGroups) });
      onGroupsChange(updatedGroups);
      onChange([...selected, label]);
      if (query !== label) {
        toast.info(`Added "${label}" — searching "${query}"`, {
          description: `Apollo finds nothing for "${label}", so the closer term is used. You can change it any time with "Edit word".`,
          duration: 12000,
        });
      } else if (deadTerm) {
        toast.warning(`Added "${label}", but Apollo finds nothing for it`, {
          description: `This keyword will return no leads until you change its search word. Use "Edit word" to set one.`,
          duration: 12000,
        });
      }
      setCustomInput("");
      customInputRef.current?.focus();
    } catch {
      toast.error("Couldn't save the new keyword — please try again.");
    } finally {
      setAdding(false);
    }
  }

  const selectedCount = selected.length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Label>
            Industry Segments <span className="text-destructive ml-0.5">*</span>
          </Label>
          <InfoTip side="right" text="Keywords filter Apollo's database by industry. Use 'plastics', 'polymer', 'moulding' or 'packaging' to target the right segment. At least one is required." />
        </div>
        {selectedCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange([])}
            className="h-auto p-0 text-[10px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            Clear all ({selectedCount})
          </Button>
        )}
      </div>

      <div ref={ref} className="relative">
        {/* Trigger */}
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "w-full justify-between px-3 py-2 text-sm font-normal text-left bg-field hover:bg-field",
            open ? "border-ring ring-1 ring-ring" : "border-input hover:border-muted-foreground",
          )}
        >
          <span className={selectedCount === 0 ? "text-muted-foreground/60" : "text-foreground"}>
            {selectedCount === 0
              ? "Select industry segments…"
              : `${selectedCount} segment${selectedCount !== 1 ? "s" : ""} selected`}
          </span>
          <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </Button>

        {/* Panel */}
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/40">
              <p className="eyebrow">
                {selectedCount > 0 ? `${selectedCount} of ${allKeywordLabels.length} selected` : "Select industry segments"}
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => onChange([...allKeywordLabels])}
                className="h-auto p-0 text-[11px]"
              >
                Select all
              </Button>
            </div>

            {/* 3-column grid of groups */}
            <div className="grid grid-cols-3 max-h-72 overflow-y-auto">
              {(() => {
                const cols: IndustryKeywordGroup[][] = [[], [], []];
                groups.forEach((g, i) => cols[i % 3].push(g));
                return cols.map((col, ci) => (
                  <div key={ci} className={cn("flex flex-col", ci < 2 && "border-r border-border")}>
                    {col.map((group, groupIdx) => {
                      const groupKws = group.keywords.map((k) => k.label);
                      const allGroupSelected = groupKws.length > 0 && groupKws.every((k) => selected.includes(k));
                      const someGroupSelected = groupKws.some((k) => selected.includes(k));
                      return (
                        <div key={group.id} className={cn("px-3 pt-3 pb-2", groupIdx > 0 && "border-t border-border/60")}>
                          {/* Group header — centered, bold */}
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => toggleCategoryKws(groupKws)}
                            className="w-full h-auto flex-col items-center gap-1.5 mb-2 rounded-none p-0 font-normal group hover:bg-transparent"
                          >
                            <div className="flex items-center gap-2">
                              <AppCheckbox
                                size="sm"
                                checked={allGroupSelected ? true : someGroupSelected ? "indeterminate" : false}
                              />
                              <span className="text-[11px] font-bold uppercase tracking-wide transition-colors text-center leading-tight text-foreground group-hover:text-primary">
                                {group.label}
                              </span>
                            </div>
                            <div className="w-full h-px bg-border/60" />
                          </Button>
                          {/* Keywords */}
                          <div className="space-y-0.5">
                            {group.keywords.map((kw) => {
                              const checked = selected.includes(kw.label);
                              return (
                                <div
                                  key={kw.id}
                                  className={cn(
                                    "group/kw w-full flex items-center gap-2 px-2 py-1 rounded transition-colors",
                                    checked ? "bg-primary/10" : "hover:bg-secondary/60",
                                  )}
                                >
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => toggleKw(kw.label)}
                                    className="h-auto flex-1 justify-start gap-2 rounded-none p-0 text-left font-normal min-w-0 hover:bg-transparent"
                                  >
                                    <AppCheckbox size="sm" checked={checked} />
                                    <span className="min-w-0 flex flex-col items-start gap-0.5">
                                      <span className={cn("text-xs leading-tight truncate", checked ? "text-foreground font-medium" : "text-muted-foreground")}>
                                        {kw.label}
                                      </span>
                                      {/* The name and the term Apollo actually receives are often
                                          different — "Water Tanks & Storage" searches "rotomoulding".
                                          14 of this company's 35 keywords differ. Hiding that meant a
                                          client could not question a search word they never saw, and
                                          they know this industry far better than the catalogue does.
                                          Only shown when it differs, so identical rows stay quiet. */}
                                      {kw.query && kw.query.toLowerCase() !== kw.label.toLowerCase() && (
                                        <span className="text-[10px] leading-tight text-muted-foreground/70 truncate font-mono">
                                          searches &ldquo;{kw.query}&rdquo;
                                        </span>
                                      )}
                                    </span>
                                  </Button>
                                  {editingKwId === kw.id ? (
                                    <span className="flex items-center gap-1 shrink-0">
                                      <Input
                                        autoFocus
                                        value={editDraft}
                                        onChange={(e) => setEditDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") { e.preventDefault(); saveKeywordQuery(group.id, kw.id); }
                                          if (e.key === "Escape") setEditingKwId(null);
                                        }}
                                        className="h-6 w-36 text-[11px] font-mono px-1.5"
                                        placeholder="search word"
                                      />
                                      <Button
                                        type="button" size="sm" variant="ghost" disabled={savingKw}
                                        onClick={() => saveKeywordQuery(group.id, kw.id)}
                                        className="h-6 px-1.5 text-[10px]"
                                      >
                                        {savingKw ? "…" : "Save"}
                                      </Button>
                                    </span>
                                  ) : (
                                    <Button
                                      type="button" size="sm" variant="ghost"
                                      title="Change the word we search for this keyword"
                                      onClick={() => { setEditingKwId(kw.id); setEditDraft(kw.query || kw.label); }}
                                      className="h-6 px-1.5 text-[10px] text-muted-foreground shrink-0 opacity-0 group-hover/kw:opacity-100 focus-visible:opacity-100"
                                    >
                                      Edit word
                                    </Button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>

            {/* Add a keyword to an existing group — saved to Settings immediately */}
            <div className="border-t border-border px-4 py-3 bg-secondary/20">
              <div className="flex items-center justify-between mb-2">
                <p className="eyebrow">Add keyword to a group</p>
                <a href="/settings?section=knowledge&knowledge=industry-segments" className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2">
                  Manage groups in Settings
                </a>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  ref={customInputRef}
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); addKeywordToGroup(); }
                    if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder="Short trade words, e.g. shopping bags"
                  className="h-auto flex-1 rounded-md px-3 py-1.5 text-xs"
                />
                <Select value={targetGroupId} onValueChange={setTargetGroupId}>
                  <SelectTrigger className="h-auto w-40 shrink-0 rounded-md px-3 py-1.5 text-xs">
                    <SelectValue placeholder="Group…" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  onClick={addKeywordToGroup}
                  disabled={!customInput.trim() || !targetGroupId || adding}
                  className="h-auto shrink-0 gap-1 px-3 py-1.5 text-xs [&_svg]:size-3"
                >
                  <Plus /> Add
                </Button>
              </div>
              {customInput.trim().length >= 3 && (
                <p className="mt-1.5 text-[11px] leading-tight">
                  {checking ? (
                    <span className="text-muted-foreground">Checking &ldquo;{customInput.trim()}&rdquo;…</span>
                  ) : kwCheck === null ? null : kwCheck.total >= 25 ? (
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{kwCheck.total.toLocaleString()}</span> people found worldwide. Looks good.
                    </span>
                  ) : (
                    <span className="text-destructive">
                      {kwCheck.total === 0
                        ? `Apollo finds nothing for "${customInput.trim()}".`
                        : `Only ${kwCheck.total} people match "${customInput.trim()}" — too few to be useful.`}
                      {kwCheck.suggestion ? (
                        <>
                          {" "}Try{" "}
                          <button
                            type="button"
                            onClick={() => setCustomInput(kwCheck.suggestion!.term)}
                            className="font-mono underline underline-offset-2 font-medium"
                          >
                            {kwCheck.suggestion.term}
                          </button>
                          {" "}— {kwCheck.suggestion.count.toLocaleString()} people.
                        </>
                      ) : (
                        <> Try shorter words, and drop &ldquo;Manufacturer&rdquo;.</>
                      )}
                    </span>
                  )}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-border px-4 py-2 flex items-center justify-end bg-secondary/30">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setOpen(false)}
                className="h-auto p-0 text-xs"
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Selected pills */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {selected.map((kw) => (
            <span key={kw} className={badgeVariants({ variant: "selected" })}>
              {kw}
              <button
                type="button"
                onClick={() => toggleKw(kw)}
                className="inline-flex size-3 items-center justify-center hover:text-destructive transition-colors"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── LocationsDropdown ────────────────────────────────────────────────────────
// The picker itself now lives in components/ui/locations-picker.tsx so employee
// territories can use the identical control. This alias keeps the call sites in
// this file unchanged.

const LocationsDropdown = LocationsPicker;

// ─── Apollo ───────────────────────────────────────────────────────────────────

export function ApolloForm({ onImport }: { onImport: (n: number) => void }) {
  const [keywords,      setKeywords     ] = useState<string[]>([]);
  const [industryKeywordGroups, setIndustryKeywordGroups] = useIndustryKeywordGroups();
  const [locations,     setLocations    ] = useState<string[]>([]);
  // The ONLY two knobs. Search depth is no longer a choice — the server pages
  // until these are met (apollo-search/route.ts). Every lead landed here
  // eventually costs a paid Apollo reveal call, so these bound real spend.
  const [maxTotalLeads, setMaxTotalLeads] = useState(200);
  // null = no per-keyword ceiling; the even split governs alone. Was a fixed 50,
  // which made `keywords x 50` the real limit of every import (8 keywords could
  // never exceed 400, whatever the total said).
  const [maxPerKeyword, setMaxPerKeyword] = useState<number | null>(null);
  const [strictCap,     setStrictCap    ] = useState(false);
  const [apolloRemaining, setApolloRemaining] = useState<number | null>(null);
  const [batchName,     setBatchName    ] = useState("");
  const [color,         setColor        ] = useState("violet");
  const [batchNameError, setBatchNameError] = useState(false);
  const [importing,     setImporting    ] = useState(false);
  const [error,         setError        ] = useState("");
  const [assignTo,      setAssignTo     ] = useState("");
  const [assignMode,    setAssignMode   ] = useState<ImportAssignMode>("manual");
  // Pre-filled with the values every search already uses. These three were
  // ALWAYS applied — they just lived in the backend where nobody could see them,
  // so an empty Advanced panel looked like "no filters" when it meant "our
  // defaults, hidden". Showing them changes no results; it lets the client see
  // what they are getting and tune it.
  //
  // Deliberately NOT pre-filled: HQ locations. Measured 2026-09-05 with the real
  // title/size defaults applied, mirroring HQ to the person's countries removed
  // 2-12% of results while noise stayed flat (0.09% -> 0.10%) — i.e. it deletes
  // real prospects, not junk. A plant manager in Mexico at a Spanish-headquartered
  // converter is exactly the buyer Kuber wants, and that filter drops them.
  // Everything else (domains, revenue, technologies, hiring signals, exclusions)
  // is left blank because no measurement supports a default for it.
  const [advancedRaw,   setAdvancedRaw  ] = useState<Record<string, string>>({
    titles: APOLLO_TITLES.join(", "),
    seniorities: APOLLO_SENIORITIES.join(", "),
    employeeRanges: EMPLOYEE_RANGES.join("   "),
  });
  const [includeSimilarTitles, setIncludeSimilarTitles] = useState(true);
  const employees = useAssignableEmployees(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const { providers } = await fetchUsage(token);
        const apollo = providers.find((p) => p.id === "apollo");
        if (apollo?.remaining != null) setApolloRemaining(apollo.remaining);
      } catch {
        // Non-blocking — the server enforces the real cap regardless of
        // whether this pre-flight number loaded.
      }
    })();
  }, []);

  const APOLLO_STEPS = ["Criteria", "Settings", "Batch", "Assign"];
  const [step, setStep] = useState(0);

  const STRICT_TIERS = [25, 50, 100] as const;
  function toggleStrictCap(on: boolean) {
    setStrictCap(on);
    // Strict mode only allows the tightest tiers — snap down to the nearest
    // one instead of silently failing server-side validation.
    if (on && !(STRICT_TIERS as readonly number[]).includes(maxTotalLeads)) {
      const nearest = [...STRICT_TIERS].reduce((best, tier) =>
        Math.abs(tier - maxTotalLeads) < Math.abs(best - maxTotalLeads) ? tier : best
      );
      setMaxTotalLeads(nearest);
    }
  }

  function goNext() {
    if (step === 0 && keywords.length === 0) { setError("Please select an industry keyword."); return; }
    setError("");
    setStep((s) => Math.min(s + 1, APOLLO_STEPS.length - 1));
  }
  function goBack() { setStep((s) => Math.max(s - 1, 0)); }

  const effectiveLocations = locations.map((l) => LOCATION_MAP[l] ?? l);
  // Several keyword labels resolve to the same underlying Apollo query (e.g.
  // all 4 "Masterbatch…" labels search for "masterbatch") — the server dedupes
  // on this resolved value and runs ONE Apollo search per distinct group. Each
  // group is paged until its own cap is met, so the ceiling is groups ×
  // per-keyword cap (bounded by the overall cap) — shown below so a big
  // multi-keyword selection doesn't surprise anyone at import time.
  const keywordGroupCount = new Set(keywords.map((label) => resolveApolloKeyword(industryKeywordGroups, label))).size;
  // The server splits the import evenly across keywords (apollo-search), so this
  // is what each one actually gets. The per-keyword cap only means anything when
  // it is SMALLER than this — 100 leads across 9 groups is ~12 each, and picking
  // "25 per keyword" there changes nothing at all.
  const fairSharePerKeyword = Math.ceil(maxTotalLeads / Math.max(1, keywordGroupCount));
  const perKeywordCapIsMoot = false;
  const effectivePerKeyword = maxPerKeyword ? Math.min(fairSharePerKeyword, maxPerKeyword) : fairSharePerKeyword;

  async function handleImport(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (keywords.length === 0) { setError("Please select an industry keyword."); return; }
    if (!batchName.trim()) { setBatchNameError(true); return; }
    setBatchNameError(false);
    setError("");
    setImporting(true);
    try {
      const token = await getToken();
      const advanced = buildPeopleAdvanced(advancedRaw, includeSimilarTitles);
      // Search + lead insert happen synchronously server-side; only email
      // enrichment (Phase 2) runs in the background after this responds.
      const response = await fetch("/api/v1/leads/apollo-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          keywords,
          locations: effectiveLocations,
          max_total_leads: maxTotalLeads,
          ...(maxPerKeyword ? { max_leads_per_keyword: maxPerKeyword } : {}),
          strict_cap: strictCap,
          titles: [...APOLLO_TITLES],
          batch_name: batchName,
          color,
          ...buildImportAssignment(assignMode, assignTo),
          ...(advanced ? { advanced } : {}),
        }),
      });
      const json = await response.json().catch(() => ({}));
      // fail() nests the reason at error.message (lib/api-response.ts) — reading
      // json.message meant every failure here surfaced as a bare status code
      // with the actual cause thrown away.
      if (!response.ok) throw new Error(json?.error?.message ?? `Request failed: ${response.status}`);
      const inserted = json?.data?.inserted ?? 0;
      const warnings: string[] = json?.data?.warnings ?? [];
      const requested = json?.data?.requested ?? maxTotalLeads;
      const skipped = json?.data?.skipped ?? 0;
      const skippedUnenrichable = json?.data?.skipped_unenrichable ?? 0;
      const recoveredDeleted = json?.data?.recovered_deleted ?? 0;
      const skippedExistingOrg = json?.data?.skipped_existing_org ?? 0;
      const skippedSameOrg = json?.data?.skipped_same_org ?? 0;
      const rescued: Array<{ from: string; to: string; count: number }> = json?.data?.rescued_keywords ?? [];
      if (rescued.length > 0) {
        toast.info(
          `${rescued.length} keyword(s) found nothing, so we searched a closer term instead`,
          {
            description: rescued.slice(0, 4).map((r) => `"${r.from}" → "${r.to}" (${r.count.toLocaleString()} found)`).join("  ·  "),
            duration: 14000,
          }
        );
      }

      // A short import is the normal case on a well-mined niche, and it used to
      // be reported as a bare lead count with no reason — which is exactly why
      // "25 requested, 8 imported" looked like a bug during the 13 Aug demo.
      // The server already knows why it stopped; say so whenever the number
      // falls short, not only when it is zero.
      if (inserted > 0 && inserted < requested) {
        const parts = [`${requested} requested`, `${inserted} imported`];
        if (skipped > 0) parts.push(`${skipped} already in your list`);
        if (recoveredDeleted > 0) parts.push(`${recoveredDeleted} restored from deleted`);
        if (skippedUnenrichable > 0) parts.push(`${skippedUnenrichable} have no email in Apollo`);
        // One lead per company is the single biggest reason an import now comes
        // back short, so it has to be said in the same breath as the number —
        // otherwise "I asked for 500 and got 150" reads as a bug.
        if (skippedExistingOrg > 0) parts.push(`${skippedExistingOrg} at companies you already cover`);
        if (skippedSameOrg > 0) parts.push(`${skippedSameOrg} were extra people at the same companies`);
        toast.warning(parts.join(" · "), {
          description: warnings.length > 0 ? warnings.slice(0, 3).join("  ") : undefined,
          duration: 12000,
        });
      }

      if (inserted === 0) {
        // Nothing was saved — don't redirect into an empty batch, tell the user why.
        const why = skippedExistingOrg > 0
          ? `Every company this search found is one you already have a contact at (${skippedExistingOrg} contact(s) skipped). Only one lead is taken per company. Try different keywords or a new region.`
          : skipped > 0
            ? `All ${skipped} matching people are already in your list.`
            : "No leads matched this search. Try different keywords or locations.";
        // The old text read "No leads were imported: [X] no results — try
        // removing location filter or changing keyword", which blamed the
        // location filter for what is nearly always a keyword-phrasing problem,
        // and left the client believing they had been charged. Say what
        // actually happened, and say that it was free.
        setError(
          warnings.length > 0
            ? `No leads were imported. ${warnings[0]} (No Apollo credits were used — searching is free.)`
            : why
        );
        setImporting(false);
        return;
      }
      // Phase 1 complete — leads are in the DB, redirect now.
      // Email enrichment runs in the background on the server.
      notifyDuplicateOwners(json?.data?.duplicate_owners, employees);
      const effectiveCap = json?.data?.effective_max_total_leads;
      if (typeof effectiveCap === "number" && effectiveCap < maxTotalLeads) {
        toast.warning(`Apollo credits ran lower than expected — this import was capped to ${effectiveCap.toLocaleString()} leads instead of ${maxTotalLeads.toLocaleString()}.`);
      }
      onImport(inserted);
    } catch (e) {
      setError((e as Error).message);
      setImporting(false);
    }
  }

  function handleFormSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step < APOLLO_STEPS.length - 1) { goNext(); return; }
    void handleImport(e);
  }

  return (
    <div className="space-y-5">
      <Stepper steps={APOLLO_STEPS} current={step} className="pb-4 mb-6 border-b border-border" />
      <form onSubmit={handleFormSubmit} className="space-y-4">
        {step === 0 && (
          <div className="space-y-4">
            <IndustryKeywordsDropdown
              selected={keywords}
              onChange={setKeywords}
              groups={industryKeywordGroups}
              onGroupsChange={setIndustryKeywordGroups}
            />
            <LocationsDropdown
              selected={locations}
              onChangeSelected={setLocations}
            />
            <ApolloPeopleAdvanced
              raw={advancedRaw}
              onRawChange={setAdvancedRaw}
              includeSimilarTitles={includeSimilarTitles}
              onIncludeSimilarTitlesChange={setIncludeSimilarTitles}
            />
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Strict cap</Label>
              <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5">
                <p className="text-xs text-muted-foreground">Limit this import to a small, safe size (25/50/100)</p>
                <Switch tone="success" checked={strictCap} onCheckedChange={toggleStrictCap} />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label>Overall leads for this import</Label>
                <InfoTip side="right" text="Every lead here costs a paid Apollo credit to reveal an email for — this is a hard cap on how many the import will spend, no matter how many keywords are selected." />
              </div>
              <Select value={String(maxTotalLeads)} onValueChange={(v) => setMaxTotalLeads(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(strictCap ? STRICT_TIERS : [25, 50, 100, 250, 500]).map((n) => (
                    <SelectItem key={n} value={String(n)} disabled={apolloRemaining != null && n > apolloRemaining}>
                      {n.toLocaleString()} leads
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {apolloRemaining != null && apolloRemaining < maxTotalLeads && (
                <p className="text-[11px] text-amber-500">
                  Only ~{apolloRemaining.toLocaleString()} Apollo credits remaining — the import will stop there even if you pick a higher number.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Max leads per keyword</Label>
              <Select
                value={maxPerKeyword === null ? "none" : String(maxPerKeyword)}
                onValueChange={(v) => setMaxPerKeyword(v === "none" ? null : Number(v))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No limit — split evenly</SelectItem>
                  {[25, 50, 100, 250, 500].map((n) => (
                    // An option at or above the even split can never bite — the
                    // budget runs out first — so offering it would be a control
                    // that silently does nothing.
                    <SelectItem key={n} value={String(n)} disabled={n >= fairSharePerKeyword}>
                      {n} leads per keyword
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-[11px] text-muted-foreground">
              You selected <strong>{keywords.length}</strong> keyword{keywords.length === 1 ? "" : "s"}
              {keywordGroupCount !== keywords.length && (
                <>, which search Apollo as <strong>{keywordGroupCount}</strong> distinct term{keywordGroupCount === 1 ? "" : "s"} (some labels share the same Apollo query)</>
              )}. The{" "}
              <strong>{maxTotalLeads.toLocaleString()}</strong> leads are split evenly between them —{" "}
              <strong>
                ~{effectivePerKeyword.toLocaleString()} per keyword
              </strong>
              {keywordGroupCount > 1 ? ", and whatever one keyword can't fill is passed to the others" : ""}.{" "}
              {maxPerKeyword === null
                ? "No per-keyword limit is set, so the full total is reachable."
                : `The per-keyword limit of ${maxPerKeyword} applies on top, so this import can reach at most ${Math.min(maxTotalLeads, maxPerKeyword * keywordGroupCount).toLocaleString()}.`}{" "}
              Apollo is searched as deeply as needed, skipping anyone already in your list.
            </p>
            {/* Said BEFORE the search, not only after it. One lead per company
                is the main reason an import lands short of the number typed
                above, and a client who reads the reason afterwards has already
                decided it is broken. */}
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">One lead per company.</span>{" "}
              You get a single contact at each company — the person most likely to
              buy, favouring purchasing and procurement roles over job titles that
              simply sound senior. Companies where you already have a working
              contact are skipped entirely, so no credit is spent twice on the same
              business. This means a search can return fewer leads than requested.
            </p>
            <ApolloCostNote
              credits={maxTotalLeads}
              spendingOn={`revealing emails for up to ${maxTotalLeads.toLocaleString()} leads`}
            />
          </div>
        )}

        {step === 2 && (
          <BatchNameField
            value={batchName}
            onChange={(v) => { setBatchName(v); if (v.trim()) setBatchNameError(false); }}
            color={color}
            onColorChange={setColor}
            error={batchNameError}
          />
        )}

        {step === 3 && (
          <div className="space-y-4">
            <AssignStrategyPicker
              employees={employees}
              mode={assignMode}
              onModeChange={setAssignMode}
              assignTo={assignTo}
              onAssignToChange={setAssignTo}
            />
            <ApolloCostNote
              credits={maxTotalLeads}
              spendingOn={`revealing emails for up to ${maxTotalLeads.toLocaleString()} leads`}
            />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5">
            <AlertCircle className="size-3.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button type="button" variant="outline" onClick={goBack} disabled={step === 0}>Back</Button>
          {step < APOLLO_STEPS.length - 1 ? (
            <Button type="submit">Continue</Button>
          ) : (
            <Button type="submit" disabled={importing || keywords.length === 0} className="gap-1.5" title={keywords.length === 0 ? "Add at least one keyword" : undefined}>
              <Search className="size-3.5" />
              {importing ? "Searching & saving leads…" : "Import leads"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── Excel / CSV ──────────────────────────────────────────────────────────────

const PLATFORM_FIELDS = [
  { key: "email",               label: "Email",           required: true,  note: "Blocks progress if unmapped" },
  // Mapped to first_name in the API payload; backend splits full names into first + last.
  { key: "first_name",          label: "Name",            required: true,  note: "Full name OK — split into first & last on import" },
  { key: "organization_name",   label: "Company Name",    required: false, note: "" },
  { key: "organization_domain", label: "Company Domain",  required: true,  note: "Required for Firecrawl enrichment" },
  { key: "title",               label: "Job Title",       required: false, note: "" },
];

type ParseResult = {
  inserted: number;
  skipped_blank_email: number;
  skipped_invalid_email: number;
  skipped_duplicate_in_file: number;
  skipped_duplicate_in_db: number;
};

const EXCEL_STEPS = ["Upload file", "Map columns", "Batch", "Assign", "Review & import"];

export function ExcelForm({ onImport }: { onImport: (n: number) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  type Stage = "upload" | "map" | "batch" | "assign" | "result";
  const [stage,       setStage      ] = useState<Stage>("upload");
  const [fileName,    setFileName   ] = useState("");
  const [headers,     setHeaders    ] = useState<string[]>([]);
  const [rows,        setRows       ] = useState<Record<string, string>[]>([]);
  const [mapping,     setMapping    ] = useState<Record<string, string>>({});
  const [batchName,   setBatchName  ] = useState("");
  const [color,       setColor      ] = useState("violet");
  const [batchNameError, setBatchNameError] = useState(false);
  const [importing,   setImporting  ] = useState(false);
  const [showConfirm,     setShowConfirm    ] = useState(false);
  const [showRawPreview,  setShowRawPreview ] = useState(false);
  const [result,          setResult         ] = useState<ParseResult | null>(null);
  const [fileError,       setFileError      ] = useState("");
  const [assignTo,        setAssignTo       ] = useState("");
  const [assignMode,      setAssignMode     ] = useState<ImportAssignMode>("manual");
  const employees = useAssignableEmployees(true);

  function tryAutoMap(cols: string[]): Record<string, string> {
    const auto: Record<string, string> = {};
    const n = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const normalized = cols.map((c) => ({ raw: c, nc: n(c) }));

    for (const pf of PLATFORM_FIELDS) {
      const match = cols.find((c) => {
        const nc = n(c);
        if (pf.key === "email"               && (nc.includes("email") || nc.includes("mail"))) return true;
        if (pf.key === "organization_name"   && (nc.includes("company") || nc.includes("org"))) return true;
        if (pf.key === "organization_domain" && (nc.includes("website") || nc.includes("domain") || nc.includes("url") || nc.includes("web"))) return true;
        if (pf.key === "title"               && (nc.includes("title") || nc.includes("designation") || nc.includes("position") || nc.includes("role"))) return true;
        return false;
      });
      if (match) auto[pf.key] = match;
    }

    // Single Name field: prefer a full-name column; otherwise use First Name
    // (and keep Last Name in the API mapping quietly when both exist).
    const fullNameCol = normalized.find(({ nc }) =>
      nc === "name" || nc === "fullname" || nc.includes("contactperson") || nc === "contactname"
    )?.raw;
    const firstCol = normalized.find(({ nc }) => nc.includes("firstname") || nc === "first")?.raw;
    const lastCol  = normalized.find(({ nc }) => nc.includes("lastname")  || nc === "last")?.raw;
    if (fullNameCol) {
      auto.first_name = fullNameCol;
    } else if (firstCol) {
      auto.first_name = firstCol;
      if (lastCol) auto.last_name = lastCol;
    }

    return auto;
  }

  /** UI maps only Name → first_name; strip any leftover last_name if the user remaps Name. */
  function setNameMapping(column: string | null) {
    setMapping((m) => {
      const next = { ...m };
      if (!column) delete next.first_name;
      else next.first_name = column;
      // Remapping Name means we're treating that column as the full name source.
      delete next.last_name;
      return next;
    });
  }

  function handleFile(file: File) {
    setFileError("");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb   = XLSX.read(data, { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        // Parse as raw arrays first to find the actual header row (first non-empty row)
        const raw  = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" });
        const headerRowIdx = raw.findIndex((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
        if (headerRowIdx === -1) { setFileError("The file appears to be empty."); return; }
        // Re-parse starting from the detected header row
        const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
        range.s.r = headerRowIdx;
        ws["!ref"] = XLSX.utils.encode_range(range);
        const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
        if (json.length === 0) { setFileError("The file appears to be empty."); return; }
        const cols = Object.keys(json[0]);
        setHeaders(cols); setRows(json); setMapping(tryAutoMap(cols)); setFileName(file.name); setStage("map");
      } catch {
        setFileError("Could not read file. Make sure it is a valid .xlsx or .csv.");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleConfirm() {
    setImporting(true);
    try {
      const token = await getToken();
      const res = await importExcelDirect(token, rows, mapping, batchName, color, buildImportAssignment(assignMode, assignTo));
      setShowConfirm(false);
      setResult(res);
      setStage("result");
      notifyDuplicateOwners(res.duplicate_owners, employees);
      onImport(res.inserted);
    } catch (e) {
      setShowConfirm(false);
      setFileError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setStage("upload"); setFileName(""); setHeaders([]); setRows([]); setMapping({});
    setBatchName(""); setColor("violet"); setBatchNameError(false);
    setResult(null); setFileError(""); setAssignTo(""); setAssignMode("manual");
  }

  const previewLeads: PreviewLead[] = rows.map((row) => {
    const { firstName, lastName } = ensureSplitNames(
      mapping.first_name ? String(row[mapping.first_name] ?? "") : "",
      mapping.last_name  ? String(row[mapping.last_name]  ?? "") : "",
    );
    return {
      firstName,
      lastName,
      email:     mapping.email                ? String(row[mapping.email]                ?? "") : "",
      company:   mapping.organization_name    ? String(row[mapping.organization_name]    ?? "") : "",
      domain:    mapping.organization_domain  ? String(row[mapping.organization_domain]  ?? "") : "",
      jobTitle:  mapping.title                ? String(row[mapping.title]                ?? "") : "",
    };
  });

  if (stage === "result") {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-green-500/20 bg-green-500/5 px-5 py-4 flex items-center gap-3">
          <CheckCircle2 className="size-5 text-green-400 shrink-0" />
          <div>
            <p className="font-semibold text-green-400"><span className="font-mono tabular-nums">{result?.inserted}</span> leads imported</p>
            <p className="text-xs text-muted-foreground mt-0.5">from <span className="font-mono">{fileName}</span></p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Duplicates removed",   value: (result?.skipped_duplicate_in_file ?? 0) + (result?.skipped_duplicate_in_db ?? 0), tone: "amber" as const },
            { label: "Blank emails skipped", value: result?.skipped_blank_email,   tone: "zinc" as const },
            { label: "Invalid format",       value: result?.skipped_invalid_email, tone: "red" as const },
          ].map(({ label, value, tone }) => (
            <StatTile key={label} label={label} value={value ?? 0} tone={tone} />
          ))}
        </div>
        <Button variant="outline" onClick={reset}>Upload another file</Button>
      </div>
    );
  }

  const emailMapped  = !!mapping.email;
  const nameMapped   = !!mapping.first_name;
  const domainMapped = !!mapping.organization_domain;
  const currentStepIndex =
    stage === "upload" ? 0
    : stage === "map"  ? 1
    : stage === "batch" ? 2
    : showConfirm ? 4 : 3;

  function handleFormSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (stage === "map") {
      if (!emailMapped || !nameMapped || !domainMapped) return;
      setStage("batch");
      return;
    }
    if (stage === "batch") {
      if (!batchName.trim()) { setBatchNameError(true); return; }
      setBatchNameError(false);
      setStage("assign");
      return;
    }
    if (importing) return;
    setShowConfirm(true);
  }

  return (
    <div className="space-y-4">
      <Stepper steps={EXCEL_STEPS} current={currentStepIndex} className="pb-4 mb-6 border-b border-border" />

      {stage === "upload" && (
        <div className="space-y-4">
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            className="border-2 border-dashed border-border hover:border-muted-foreground rounded-xl p-12 flex flex-col items-center gap-3 cursor-pointer transition-colors"
          >
            <Upload className="size-8 text-muted-foreground/50" />
            <p className="font-medium text-sm">Click or drag to upload</p>
            <p className="text-xs text-muted-foreground">.xlsx or .csv · any column layout supported</p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
          {fileError && (
            <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5">
              <AlertCircle className="size-3.5 shrink-0" /> {fileError}
            </div>
          )}
        </div>
      )}

      {(stage === "map" || stage === "batch" || stage === "assign") && (
        <form className="space-y-4" onSubmit={handleFormSubmit}>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-4 py-3">
            <FileText className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-sm font-medium truncate">{fileName}</p>
              <p className="font-mono text-xs text-muted-foreground tabular-nums">{rows.length} rows · {headers.length} columns detected</p>
            </div>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setShowRawPreview(true)}>View</Button>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={reset}>Change</Button>
          </div>

          {stage === "map" && (
            <>
              <div className="space-y-3">
                <p className="eyebrow">Column mapping</p>
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {PLATFORM_FIELDS.map((pf) => {
                    const mapped = mapping[pf.key];
                    const isName = pf.key === "first_name";
                    return (
                      <div key={pf.key} className="grid grid-cols-2 items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
                        <div>
                          <span className="text-sm">{pf.label}{pf.required && <span className="text-destructive ml-1 text-xs">*</span>}</span>
                          {pf.note && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{pf.note}</p>}
                        </div>
                        <Select
                          value={mapped || "__none"}
                          onValueChange={(v) => {
                            if (isName) {
                              setNameMapping(v === "__none" ? null : v);
                              return;
                            }
                            setMapping((m) => {
                              const next = { ...m };
                              if (v === "__none") delete next[pf.key];
                              else next[pf.key] = v;
                              return next;
                            });
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Not mapped" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none"><span className="text-muted-foreground">Not mapped</span></SelectItem>
                            {headers.map((h) => <SelectItem key={h} value={h}>{h.length > 40 ? `${h.slice(0, 38)}…` : h}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                {!emailMapped && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />Email column must be mapped before importing</div>}
                {emailMapped && !nameMapped && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />Name column must be mapped before importing</div>}
                {emailMapped && nameMapped && !domainMapped && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />Company Domain must be mapped before importing</div>}
                {fileError && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />{fileError}</div>}
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">{rows.length} rows detected</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={reset}>Back</Button>
                  <Button type="submit" disabled={!emailMapped || !nameMapped || !domainMapped}>
                    Continue
                  </Button>
                </div>
              </div>
            </>
          )}

          {stage === "batch" && (
            <>
              <BatchNameField
                value={batchName}
                onChange={(v) => { setBatchName(v); if (v.trim()) setBatchNameError(false); }}
                color={color}
                onColorChange={setColor}
                error={batchNameError}
              />

              {fileError && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />{fileError}</div>}

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">{rows.length} rows will be processed</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setStage("map")}>Back</Button>
                  <Button type="submit">
                    Continue
                  </Button>
                </div>
              </div>
            </>
          )}

          {stage === "assign" && (
            <>
              <AssignStrategyPicker
                employees={employees}
                mode={assignMode}
                onModeChange={setAssignMode}
                assignTo={assignTo}
                onAssignToChange={setAssignTo}
              />
              {employees.length === 0 && (
                <p className="text-xs text-muted-foreground rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                  No active employees to assign to — the batch will land in the pool (unassigned).
                </p>
              )}

              {fileError && <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2"><AlertCircle className="size-3.5 shrink-0" />{fileError}</div>}

              <div className="flex items-center justify-between gap-3 pt-2">
                <p className="text-xs text-muted-foreground">{rows.length} rows will be processed</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setStage("batch")}>Back</Button>
                  <Button type="submit" disabled={importing}>
                    Preview & Import
                  </Button>
                </div>
              </div>
            </>
          )}
        </form>
      )}

      {showConfirm && (
        <BatchConfirmModal
          source="excel"
          leads={previewLeads}
          totalCount={rows.length}
          confirming={importing}
          onConfirm={() => { void handleConfirm(); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <Dialog open={showRawPreview} onOpenChange={setShowRawPreview}>
        <DialogContent className="max-w-5xl w-full p-0 gap-0 flex flex-col max-h-[85vh]">
          <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
            <DialogTitle className="font-mono text-sm font-semibold">{fileName}</DialogTitle>
            <p className="font-mono text-xs text-muted-foreground mt-0.5 tabular-nums">{rows.length} rows · {headers.length} columns</p>
          </DialogHeader>
          <div className="flex-1 overflow-auto min-h-0">
            <table className="text-xs border-collapse min-w-max w-full">
              <thead className="sticky top-0 bg-secondary/80 backdrop-blur-sm z-10">
                <tr>
                  <th className="px-3 py-2 text-left font-mono font-semibold uppercase tracking-wider text-muted-foreground border-b border-border w-10">#</th>
                  {headers.map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-mono font-semibold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                    <td className="px-3 py-2 font-mono text-muted-foreground/60 tabular-nums">{i + 1}</td>
                    {headers.map((h) => (
                      <td key={h} className="px-3 py-2 font-mono text-foreground/80 max-w-[200px] truncate whitespace-nowrap" title={String(row[h] ?? "")}>
                        {String(row[h] ?? "") || <span className="text-muted-foreground/40">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Manual ───────────────────────────────────────────────────────────────────

type OrgFields  = { name: string; industry: string; domain: string; country: string };
type LeadEntry  = { firstName: string; lastName: string; email: string; jobTitle: string; id?: string };
const BLANK_LEAD = (): LeadEntry => ({ firstName: "", lastName: "", email: "", jobTitle: "" });

export interface ManualFormProps {
  onImport: (n: number) => void;
  prefillOrg?: { name: string; industry: string; domain: string; country: string; id?: string };
  prefillLeads?: Array<{ firstName: string; lastName: string; email: string; jobTitle: string; id?: string }>;
  editMode?: boolean;
}

export function ManualForm({ onImport, prefillOrg, prefillLeads, editMode = false }: ManualFormProps) {
  const [org, setOrg] = useState<OrgFields>({
    name:     prefillOrg?.name     ?? "",
    industry: prefillOrg?.industry ?? "",
    domain:   prefillOrg?.domain   ?? "",
    country:  prefillOrg?.country  ?? "",
  });
  const [leads,       setLeads      ] = useState<LeadEntry[]>(prefillLeads?.length ? prefillLeads.map((l) => ({ ...l })) : [BLANK_LEAD()]);
  const [batchName,   setBatchName  ] = useState("");
  const [color,       setColor      ] = useState("violet");
  const [batchNameError, setBatchNameError] = useState(false);
  const [saving,      setSaving     ] = useState(false);
  const [saved,       setSaved      ] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error,       setError      ] = useState("");
  const [assignTo,    setAssignTo   ] = useState<string>("");
  const employees = useAssignableEmployees(!editMode);

  const MANUAL_STEPS = editMode ? ["Organization", "People"] : ["Organization", "People", "Batch", "Assign"];
  const [step, setStep] = useState(0);

  function addLead()                                        { setLeads((p) => [...p, BLANK_LEAD()]); }
  function removeLead(i: number)                            { if (leads.length > 1) setLeads((p) => p.filter((_, j) => j !== i)); }
  function updateLead(i: number, f: keyof LeadEntry, v: string) { setLeads((p) => p.map((l, j) => j === i ? { ...l, [f]: v } : l)); }

  function goNext() {
    if (step === 0) {
      if (!org.name.trim())   { setError("Organization name is required."); return; }
      if (!org.domain.trim()) { setError("Company website / domain is required."); return; }
    }
    if (step === 1) {
      for (const l of leads) {
        if (!l.firstName.trim()) { setError("Each lead needs a first name."); return; }
        if (!l.email.trim())     { setError("Each lead needs an email."); return; }
      }
    }
    if (step === 2 && !editMode) {
      if (!batchName.trim()) { setBatchNameError(true); return; }
      setBatchNameError(false);
    }
    setError("");
    setStep((s) => Math.min(s + 1, MANUAL_STEPS.length - 1));
  }
  function goBack() { setStep((s) => Math.max(s - 1, 0)); }

  function handleOpenConfirm() {
    if (!org.name.trim())   { setError("Organization name is required."); return; }
    if (!org.domain.trim()) { setError("Company website / domain is required."); return; }
    for (const l of leads) {
      if (!l.firstName.trim()) { setError("Each lead needs a first name."); return; }
      if (!l.email.trim())     { setError("Each lead needs an email."); return; }
    }
    setError("");
    if (editMode) {
      void handleSaveAll();
    } else {
      if (!batchName.trim()) { setBatchNameError(true); return; }
      setBatchNameError(false);
      setShowConfirm(true);
    }
  }

  async function handleSaveAll(overrideBatchName?: string, overrideColor?: string) {
    const resolvedBatchName = overrideBatchName ?? batchName;
    const resolvedColor = overrideColor ?? color;
    setSaving(true);
    setError("");
    try {
      const token = await getToken();
      let savedCount = 0;
      let sharedImportId: string | undefined;

      if (editMode && prefillOrg?.id) {
        await patchOrg(token, prefillOrg.id, { name: org.name, domain: org.domain, industry: org.industry || undefined, country: org.country || undefined });
      }

      for (const entry of leads) {
        if (editMode && entry.id) {
          await patchLead(token, entry.id, {
            first_name: entry.firstName, last_name: entry.lastName || undefined,
            email: entry.email, title: entry.jobTitle || undefined, country: org.country || undefined,
          });
        } else {
          const created = await createLead(token, {
            email:                entry.email,
            first_name:           entry.firstName,
            last_name:            entry.lastName || undefined,
            organization_name:    org.name,
            organization_domain:  org.domain,
            organization_industry: org.industry || undefined,
            organization_country: org.country || undefined,
            title:                entry.jobTitle || undefined,
            country:              org.country || undefined,
            assigned_to:          assignTo || undefined,
            // all leads in this batch share one import row
            ...(sharedImportId ? { import_id: sharedImportId } : { batch_name: resolvedBatchName, color: resolvedColor }),
          });
          if (!sharedImportId && created.import_id) sharedImportId = created.import_id;
        }
        savedCount++;
      }

      setShowConfirm(false);
      onImport(savedCount);
      setSaved(true);
      if (!editMode) {
        setOrg({ name: "", industry: "", domain: "", country: "" });
        setLeads([BLANK_LEAD()]);
        setBatchName(""); setColor("violet");
      }
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setShowConfirm(false);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const previewLeads: PreviewLead[] = leads.map((l) => ({
    firstName: l.firstName, lastName: l.lastName,
    email: l.email, company: org.name, domain: org.domain, jobTitle: l.jobTitle,
  }));

  const isLastStep = step === MANUAL_STEPS.length - 1;

  function handleFormSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isLastStep) { goNext(); return; }
    handleOpenConfirm();
  }

  return (
    <form
      className="space-y-6"
      onSubmit={handleFormSubmit}
    >
      <Stepper steps={MANUAL_STEPS} current={step} className="pb-4 mb-6 border-b border-border" />

      {step === 0 && (
        <div className="space-y-4">
          <p className="eyebrow">Organization</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Organization name <span className="text-destructive">*</span></Label>
              <Input value={org.name} onChange={(e) => setOrg((o) => ({ ...o, name: e.target.value }))} placeholder="Acme Plastics Ltd." />
            </div>
            <div className="space-y-1.5">
              <Label>Company website / domain <span className="text-destructive">*</span></Label>
              <Input className="font-mono" value={org.domain} onChange={(e) => setOrg((o) => ({ ...o, domain: e.target.value }))} placeholder="acmeplastics.com" />
              <p className="text-[10px] text-muted-foreground/60">Used for Firecrawl enrichment</p>
            </div>
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <Input value={org.industry} onChange={(e) => setOrg((o) => ({ ...o, industry: e.target.value }))} placeholder="Plastics manufacturing" />
            </div>
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Input value={org.country} onChange={(e) => setOrg((o) => ({ ...o, country: e.target.value }))} placeholder="India" />
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="eyebrow">People</p>
          {leads.map((lead, index) => (
            <div key={index} className={cn("space-y-3 relative rounded-lg border border-border bg-card/60 p-4", index > 0 && "mt-3")}>
              {leads.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLead(index)}
                  className="absolute top-2 right-2 size-6 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  aria-label="Remove lead"
                >
                  <X className="size-4" />
                </Button>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label>First name <span className="text-destructive">*</span></Label>
                  <Input value={lead.firstName} onChange={(e) => updateLead(index, "firstName", e.target.value)} placeholder="Raj" />
                </div>
                <div className="space-y-1.5">
                  <Label>Last name</Label>
                  <Input value={lead.lastName} onChange={(e) => updateLead(index, "lastName", e.target.value)} placeholder="Sharma" />
                </div>
                <div className="space-y-1.5">
                  <Label>Email <span className="text-destructive">*</span></Label>
                  <Input className="font-mono" type="email" value={lead.email} onChange={(e) => updateLead(index, "email", e.target.value)} placeholder="raj@company.com" />
                </div>
                <div className="space-y-1.5">
                  <Label>Job title</Label>
                  <Input value={lead.jobTitle} onChange={(e) => updateLead(index, "jobTitle", e.target.value)} placeholder="VP Procurement" />
                </div>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" className="gap-1.5 w-full" onClick={addLead}>
            <Plus className="size-3.5" /> Add lead
          </Button>
        </div>
      )}

      {step === 2 && !editMode && (
        <BatchNameField
          value={batchName}
          onChange={(v) => { setBatchName(v); if (v.trim()) setBatchNameError(false); }}
          color={color}
          onColorChange={setColor}
          error={batchNameError}
        />
      )}

      {step === 3 && !editMode && <AssignToField employees={employees} value={assignTo} onChange={setAssignTo} />}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="outline" onClick={goBack} disabled={step === 0}>Back</Button>
        <Button type="submit" disabled={saving}>
          {isLastStep ? (saving ? "Saving…" : editMode ? "Save changes" : "Preview & Save") : "Continue"}
        </Button>
      </div>
      {saved && <p className="text-sm text-green-400">Saved successfully.</p>}

      {showConfirm && (
        <BatchConfirmModal
          source="manual"
          leads={previewLeads}
          totalCount={leads.length}
          confirming={saving}
          onConfirm={() => { void handleSaveAll(); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </form>
  );
}
