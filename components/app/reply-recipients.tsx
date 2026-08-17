"use client";

import { AlertTriangle, Lock, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The To line of a reply — editable, except for one address.
 *
 * Instantly's POST /emails/reply has no To field. It always addresses the sender
 * of `reply_to_uuid`, and everything else we ask for rides along in
 * `additional_recipients` (which land in To, not CC). So exactly one chip here
 * is immovable: to change WHO that is, you reply to a different message. The
 * lock icon says that out loud rather than letting someone click a remove
 * button that quietly does nothing.
 *
 * Raw addresses on purpose, never display names: the composer used to caption
 * every reply "to <the lead>" while Instantly addressed it to whoever wrote
 * last, so a reply could leave the prospect off their own thread with nothing
 * on screen admitting it. A friendly label is the abstraction that hid that.
 */
export function ReplyToField({
  to,
  onChange,
  lockedTo,
  suggestions,
  disabled,
}: {
  to: string[];
  onChange: (next: string[]) => void;
  /** Forced by reply_to_uuid — rendered locked, never removable. */
  lockedTo: string | null;
  suggestions: string[];
  disabled?: boolean;
}) {
  const missing = suggestions.filter((s) => !to.includes(s));

  return (
    <div className="space-y-1">
      <Label className="eyebrow text-muted-foreground">To</Label>
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5",
          disabled && "opacity-50 pointer-events-none",
        )}
      >
        {to.length === 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">
            No recipient — nobody has replied to this thread yet
          </span>
        )}
        {to.map((email) => {
          const locked = email === lockedTo;
          return (
            <span
              key={email}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]",
                locked
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border bg-secondary/30 text-foreground",
              )}
              title={locked ? "Instantly always addresses the message you are replying to. Reply to a different message to change this." : undefined}
            >
              <span className="truncate">{email}</span>
              {locked ? (
                <Lock className="size-2.5 shrink-0 text-muted-foreground" />
              ) : (
                <button
                  type="button"
                  onClick={() => onChange(to.filter((x) => x !== email))}
                  className="shrink-0 rounded text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${email}`}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-[10px] text-muted-foreground">Also on this thread:</span>
          {missing.map((email) => (
            <button
              key={email}
              type="button"
              disabled={disabled}
              onClick={() => onChange([...to, email])}
              className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground disabled:opacity-50"
            >
              + {email}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Warns when the campaign's lead is not among the people this reply reaches. */
export function LeadExcludedWarning({
  to,
  cc,
  bcc,
  leadEmail,
  leadName,
}: {
  to: string[];
  cc: string[];
  bcc: string[];
  leadEmail: string | null;
  leadName: string;
}) {
  const lead = leadEmail?.trim().toLowerCase() ?? null;
  const reaches = new Set([...to, ...cc, ...bcc].map((e) => e.trim().toLowerCase()));
  if (!lead || reaches.has(lead)) return null;

  return (
    <p className="flex items-start gap-1.5 text-[11px] text-amber-500">
      <AlertTriangle className="mt-px size-3 shrink-0" />
      <span>
        {leadName} ({leadEmail}) will <strong className="font-semibold">not</strong> receive this reply.
      </span>
    </p>
  );
}
