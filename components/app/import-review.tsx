"use client";

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { classifyImport, cleanEmailCell } from "@/lib/import-classify";
import type {
  IgnoredSheet, ImportChoices, ImportMapping, ImportOwnerCount, ImportPlan, ImportResult, ImportRow, RowChoice,
} from "@/lib/import-review-types";

type Review = ImportPlan["review"];

const dot = (parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");
const SKIP = "__skip";

export function needsReview(review: Review) {
  return review.multi.length > 0 || review.ambiguous.length > 0;
}

/** Multi-email rows start with their first address selected, so they are always "decided". */
export function defaultChoices(review: Review): ImportChoices {
  const c: ImportChoices = {};
  for (const m of review.multi) c[String(m.rowIndex)] = { action: "use_email", email: m.candidates[0] };
  return c;
}

/** "Only sheet 'X' was imported; 'Y' (4 rows) was ignored." */
export function ignoredSheetsText(imported: string, sheets: IgnoredSheet[]) {
  if (sheets.length === 0) return "";
  const list = sheets.map((s) => `'${s.name}' (${s.rows} row${s.rows === 1 ? "" : "s"})`).join(", ");
  return `Only sheet '${imported}' was imported; ${list} ${sheets.length === 1 ? "was" : "were"} ignored.`;
}

// ─── Review step ─────────────────────────────────────────────────────────────

export function ImportReviewStep({
  rows, mapping, review, choices, onChoices, onBack, onContinue, error,
}: {
  rows: ImportRow[];
  mapping: ImportMapping;
  review: Review;
  choices: ImportChoices;
  onChoices: (next: ImportChoices) => void;
  onBack: () => void;
  onContinue: () => void;
  error?: string;
}) {
  // "Import none of these" per group, and the raw text typed in each "Change email" box.
  const [none, setNone] = useState<Set<string>>(() => new Set());
  const [edits, setEdits] = useState<Record<number, string>>({});

  const key = (i: number) => String(i);
  const choiceOf = (i: number): RowChoice | undefined => choices[key(i)];

  function pickRow(email: string, group: Review["ambiguous"][number], idx: number) {
    const next = { ...choices };
    for (const r of group.rows) if (next[key(r.rowIndex)]?.action === "keep") delete next[key(r.rowIndex)];
    next[key(idx)] = { action: "keep" };
    setEdits((e) => ({ ...e, [idx]: "" }));
    setNone((s) => { const n = new Set(s); n.delete(email); return n; });
    onChoices(next);
  }

  function pickNone(email: string, group: Review["ambiguous"][number]) {
    const next = { ...choices };
    for (const r of group.rows) if (next[key(r.rowIndex)]?.action === "keep") delete next[key(r.rowIndex)];
    setNone((s) => new Set(s).add(email));
    onChoices(next);
  }

  function editEmail(idx: number, text: string) {
    setEdits((e) => ({ ...e, [idx]: text }));
    const next = { ...choices };
    const cands = cleanEmailCell(text).candidates;
    if (text.trim() !== "" && cands.length === 1) next[key(idx)] = { action: "use_email", email: cands[0] };
    else delete next[key(idx)]; // empty or not valid: the row is not edited (an invalid box blocks Continue)
    onChoices(next);
  }

  const editInvalid = (i: number) => {
    const t = edits[i] ?? "";
    return t.trim() !== "" && cleanEmailCell(t).candidates.length !== 1;
  };
  const anyInvalid = Object.keys(edits).some((i) => editInvalid(Number(i)));

  function decided(g: Review["ambiguous"][number]) {
    if (none.has(g.email)) return true;
    if (g.rows.some((r) => choiceOf(r.rowIndex)?.action === "keep")) return true;
    // Every row but at most one was moved to a different email: nothing is left to choose between.
    return g.rows.filter((r) => choiceOf(r.rowIndex)?.action !== "use_email").length <= 1;
  }
  const undecided = review.ambiguous.filter((g) => !decided(g)).length;

  const plan = useMemo(() => classifyImport(rows, mapping, choices), [rows, mapping, choices]);
  const willImport = plan.importRows.length;
  const willSkip = plan.totalRows - willImport;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">A few rows need your decision</p>
        <p className="text-xs text-muted-foreground mt-0.5">Nothing in these rows is imported until you choose.</p>
      </div>

      {review.multi.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] font-medium">More than one email in a cell <span className="tabular-nums text-muted-foreground">({review.multi.length})</span></p>
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {review.multi.map((m) => {
              const c = choiceOf(m.rowIndex);
              const value = c?.action === "skip" ? SKIP : c?.action === "use_email" ? c.email : m.candidates[0];
              return (
                <div key={m.rowIndex} className="grid grid-cols-2 items-center gap-3 px-3 py-2">
                  <p className="text-[13px] min-w-0 truncate">
                    <span className="tabular-nums text-muted-foreground">Row {m.rowNumber}</span>
                    {dot([m.name, m.company]) && ` · ${dot([m.name, m.company])}`}
                  </p>
                  <Select
                    value={value}
                    onValueChange={(v) => onChoices({
                      ...choices,
                      [key(m.rowIndex)]: v === SKIP ? { action: "skip" } : { action: "use_email", email: v },
                    })}
                  >
                    <SelectTrigger className="text-[13px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {m.candidates.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                      <SelectItem value={SKIP}><span className="text-muted-foreground">Skip this row</span></SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {review.ambiguous.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] font-medium">Same email, different name <span className="tabular-nums text-muted-foreground">({review.ambiguous.length})</span></p>
          {review.ambiguous.map((g) => (
            <div key={g.email} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <p className="text-[13px] font-medium break-all">{g.email}</p>
              {g.rows.map((r) => {
                const edited = !!edits[r.rowIndex]?.trim();
                return (
                  <div key={r.rowIndex} className="flex items-start gap-2">
                    <ChoiceCard
                      className="flex-1 min-w-0"
                      indicator="radio"
                      selected={choiceOf(r.rowIndex)?.action === "keep"}
                      disabled={edited}
                      onSelect={() => pickRow(g.email, g, r.rowIndex)}
                      title={dot([`Row ${r.rowNumber}`, r.name, r.company, r.title])}
                      description="Import this one"
                    />
                    <div className="w-56 shrink-0">
                      <Input
                        placeholder="Change email"
                        value={edits[r.rowIndex] ?? ""}
                        onChange={(e) => editEmail(r.rowIndex, e.target.value)}
                        aria-invalid={editInvalid(r.rowIndex) || undefined}
                      />
                      {editInvalid(r.rowIndex) && <p className="text-xs text-destructive mt-1">Not a valid email</p>}
                    </div>
                  </div>
                );
              })}
              <ChoiceCard
                indicator="radio"
                selected={none.has(g.email)}
                onSelect={() => pickNone(g.email, g)}
                title="Import none of these"
              />
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-xs text-destructive rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertCircle className="size-3.5 shrink-0" />{error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-xs text-muted-foreground tabular-nums">
          {willImport} row{willImport === 1 ? "" : "s"} will be imported, {willSkip} not
          {undecided > 0 && ` · ${undecided} group${undecided === 1 ? "" : "s"} still to decide`}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onBack}>Back</Button>
          <Button type="button" disabled={undecided > 0 || anyInvalid} onClick={onContinue}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

function ownerLabel(o: ImportOwnerCount) {
  if (o.assigned_to === null) return "Unassigned";
  if (o.assigned_to === "self") return "yours";
  if (o.assigned_to === "other") return "with another team member";
  return o.name || "another user"; // real ids + names only ever come from the server for leads:all members
}

export function ImportReport({
  result, fileName, importedSheet, ignoredSheets, onDone, onReset,
}: {
  result: ImportResult;
  fileName: string;
  importedSheet: string;
  ignoredSheets: IgnoredSheet[];
  onDone: () => void;
  onReset: () => void;
}) {
  const r = result;
  const owners = [...(r.duplicate_owner_counts ?? [])].sort((a, b) => b.count - a.count);
  const ownerText = owners.map((o) => `${ownerLabel(o)} ${o.count}`).join(", ");
  const someoneElse = owners.some((o) => o.assigned_to === "other");

  const lines: Array<{ label: string; value: number; note?: string }> = [
    { label: "Rows in file", value: r.total_rows },
    { label: "Imported", value: r.inserted },
    { label: "No usable email", value: r.skipped_no_email },
    { label: "Repeated in the file", value: r.skipped_duplicate_in_file },
    { label: "Same email, different name, not imported", value: r.skipped_ambiguous },
    { label: "Skipped by you", value: r.skipped_by_choice },
    { label: "Already in Kuber", value: r.skipped_duplicate_in_db, note: ownerText },
    { label: "Could not be saved (try again)", value: r.not_saved },
  ].filter((l, i) => i === 0 || l.value > 0);

  const ok = r.inserted > 0;
  const sheetNote = ignoredSheetsText(importedSheet, ignoredSheets);

  return (
    <div className="space-y-4">
      {ok ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-3 dark:border-emerald-500/25 dark:bg-emerald-500/10">
          <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300"><span className="tabular-nums">{r.inserted}</span> lead{r.inserted === 1 ? "" : "s"} imported</p>
            <p className="text-xs text-muted-foreground mt-0.5">from <span>{fileName}</span></p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3 dark:border-amber-500/25 dark:bg-amber-500/10">
          <AlertCircle className="size-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">No new leads in <span>{fileName}</span></p>
            <p className="text-xs text-muted-foreground">No batch was created. The list below shows what happened to every row.</p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {lines.map((l) => (
          <div key={l.label} className="px-3 py-2">
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span>{l.label}</span>
              <span className="tabular-nums font-medium">{l.value}</span>
            </div>
            {l.note && <p className="text-xs text-muted-foreground mt-0.5">{l.note}</p>}
            {l.label === "Already in Kuber" && someoneElse && (
              <p className="text-xs text-muted-foreground mt-0.5">Contact your manager to get them assigned to you.</p>
            )}
          </div>
        ))}
      </div>

      {r.emails_corrected > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {r.emails_corrected} email address{r.emails_corrected === 1 ? " was" : "es were"} auto-corrected (for example gmail.con to gmail.com).
        </p>
      )}
      {sheetNote && <p className="text-xs text-muted-foreground">{sheetNote}</p>}

      <div className="flex gap-2">
        <Button onClick={onDone}>Done</Button>
        <Button variant="outline" onClick={onReset}>Upload another file</Button>
      </div>
    </div>
  );
}
