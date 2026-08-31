"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small "i" affordance for help text that would otherwise sit as a
 * permanent paragraph under every field — fine once, repetitive when the
 * same sentence appears under N identical cards (e.g. one per sequence
 * step). Hover/focus reveals it; nothing is on screen until then.
 */
export function InfoTooltip({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("relative inline-flex group align-middle", className)}>
      <Info className="size-3.5 text-muted-foreground hover:text-foreground cursor-help" tabIndex={0} />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-56 rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-muted-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {text}
      </span>
    </span>
  );
}
