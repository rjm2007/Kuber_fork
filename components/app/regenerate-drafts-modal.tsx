"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { X, RotateCcw, Loader2, Lock } from "lucide-react";
import type { RegenerationSkipped } from "@/lib/api-client";

const FIELD_FILL = "bg-secondary/70 hover:bg-secondary focus-visible:bg-secondary transition-colors";
const INSTRUCTION_MAX_LENGTH = 4000;

interface RegenerateDraftsModalProps {
  /** Eligible drafts split by current state — what will actually be rewritten. */
  counts: { draft: number; failed: number };
  /** What the run will leave alone, and why. */
  skipped: RegenerationSkipped;
  /** True when the user ticked specific leads rather than targeting the whole campaign. */
  isSubset: boolean;
  submitting?: boolean;
  onConfirm: (instruction: string) => void;
  onCancel: () => void;
}

export function RegenerateDraftsModal(props: RegenerateDraftsModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(<RegenerateDraftsModalInner {...props} />, document.body);
}

function RegenerateDraftsModalInner({
  counts,
  skipped,
  isSubset,
  submitting,
  onConfirm,
  onCancel,
}: RegenerateDraftsModalProps) {
  const [instruction, setInstruction] = useState("");
  const total = counts.draft + counts.failed;

  const protectedRows = [
    { n: skipped.certified, label: "certified" },
    { n: skipped.sent,      label: "sent" },
    { n: skipped.no_draft,  label: "no draft" },
  ].filter((r) => r.n > 0);

  const scopeNotes = [
    isSubset && "only your selected leads",
    counts.failed > 0 && `${counts.failed} of these previously failed and will be retried from scratch`,
  ].filter(Boolean) as string[];

  return (
    // `data-confirm-dialog-root` + forced `pointer-events-auto`: this portals to
    // document.body while the campaign drawer (a Radix Dialog) is open behind it,
    // and Radix sets `pointer-events: none` on <body> while open — without this
    // every button here is unclickable. Same treatment as batch-confirm-modal.
    <div data-confirm-dialog-root className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={submitting ? undefined : onCancel} />

      <div className="enter swatch-bar-top overflow-hidden relative z-10 w-full max-w-lg mx-4 rounded-2xl border border-border bg-card shadow-2xl flex flex-col max-h-[90vh]">

        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold">
              Regenerate <span className="font-mono tabular-nums">{total}</span> draft{total !== 1 ? "s" : ""}
            </h2>
            <p className="text-xs text-muted-foreground mt-2">
              With an instruction, each draft is edited from its current wording. Without one, each gets a fresh AI rewrite. Prior versions stay in history.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onCancel}
            disabled={submitting}
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Scope summary — only shown when there's nuance beyond the header's total */}
        {(scopeNotes.length > 0 || protectedRows.length > 0) && (
          <div className="px-6 py-3 border-b border-border bg-secondary/20 shrink-0 space-y-1">
            {scopeNotes.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {scopeNotes.join(" — ").replace(/^./, (c) => c.toUpperCase())}.
              </p>
            )}
            {protectedRows.length > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Lock className="size-3 shrink-0" />
                {protectedRows.map((r) => `${r.n} ${r.label}`).join(", ")} skipped — not touched
              </p>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
          <div className="flex items-baseline justify-between gap-2">
            <Label className="text-sm font-medium">Instruction (optional)</Label>
            <span className={`text-[11px] tabular-nums shrink-0 ${instruction.length > INSTRUCTION_MAX_LENGTH ? "text-destructive" : "text-muted-foreground"}`}>
              {instruction.length}/{INSTRUCTION_MAX_LENGTH}
            </span>
          </div>
          <Textarea
            value={instruction}
            autoFocus
            disabled={submitting}
            rows={4}
            maxLength={INSTRUCTION_MAX_LENGTH}
            className={`mt-2 text-sm resize-y ${FIELD_FILL}`}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitting) onConfirm(instruction.trim()); }}
            placeholder="e.g. Make it shorter and less salesy — multi-line instructions are fine"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Applied to every draft in this run only — the campaign&apos;s saved AI context is unchanged.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border shrink-0">
          <p className="text-[11px] text-muted-foreground">
            Runs in the background — safe to close.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <Button size="sm" className="gap-1.5" onClick={() => onConfirm(instruction.trim())} disabled={submitting || total === 0}>
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
              Regenerate {total}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
