"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { X, PauseCircle, Loader2 } from "lucide-react";

interface HoldSendingModalProps {
  /** Follow-ups already delivered — a floor, not an exact figure (see below). */
  sent: number;
  /** Written, approved, and still waiting to go out. What a hold protects. */
  waiting: number;
  /** Due but not written yet. Also protected, and still fully editable. */
  unwritten: number;
  /** Set when the user arrived here from a refused "regenerate every follow-up",
   *  so the button offers to do both rather than making them repeat themselves. */
  thenRegenerate?: boolean;
  submitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function HoldSendingModal(props: HoldSendingModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(<HoldSendingModalInner {...props} />, document.body);
}

function HoldSendingModalInner({
  sent, waiting, unwritten, thenRegenerate, submitting, onConfirm, onCancel,
}: HoldSendingModalProps) {
  const stoppable = waiting + unwritten;

  return (
    // `data-confirm-dialog-root` + forced `pointer-events-auto`: this portals to
    // document.body while the campaign drawer (a Radix Dialog) is open behind it,
    // and Radix sets `pointer-events: none` on <body> while open — without this
    // every button here is unclickable. Same treatment as regenerate-drafts-modal.
    <div data-confirm-dialog-root className="fixed inset-0 z-200 flex items-center justify-center pointer-events-auto">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={submitting ? undefined : onCancel} />

      <div className="relative w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <PauseCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <h2 className="font-display text-sm font-semibold">Hold sending?</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={submitting}
            onClick={onCancel}
            aria-label="Close"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold tabular-nums">{stoppable}</span>
              <span className="text-sm text-muted-foreground">
                follow-up{stoppable === 1 ? "" : "s"} will be held and stay editable
              </span>
            </div>
            {waiting > 0 && unwritten > 0 && (
              <p className="pl-1 text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">{waiting}</span> already written
                {" · "}
                <span className="font-mono tabular-nums">{unwritten}</span> not written yet
              </p>
            )}
          </div>

          {sent > 0 && (
            <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold tabular-nums">{sent}</span>
                <span className="text-xs text-muted-foreground">
                  already went out — these cannot be changed
                </span>
              </div>
              {/* Our "sent" count comes from Instantly's webhook, and measured
                  across 820 real sends 13% of those arrived up to 15 minutes
                  late. Saying so beats showing a number that silently grows. */}
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                This number may rise for a few minutes as Instantly reports in.
              </p>
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Holding stops the whole campaign, not one step — Instantly has no
            per-step pause. Other steps are days apart, so they are only delayed.
            Nothing is lost: everything held goes out when you resume.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="gap-1.5" disabled={submitting} onClick={onConfirm}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <PauseCircle className="size-3.5" />}
            {thenRegenerate ? "Hold sending, then regenerate" : "Hold sending"}
          </Button>
        </div>
      </div>
    </div>
  );
}
