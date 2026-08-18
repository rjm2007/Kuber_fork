import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type StatTileTone = "neutral" | "red" | "sky" | "amber" | "zinc";

const TONE_ICON: Record<StatTileTone, string> = {
  neutral: "bg-primary/10 border-primary/20 text-primary",
  red: "bg-red-500/10 border-red-500/20 text-red-400",
  sky: "bg-sky-500/10 border-sky-500/20 text-sky-400",
  amber: "bg-amber-500/10 border-amber-500/20 text-amber-400",
  zinc: "bg-zinc-500/10 border-zinc-500/20 text-zinc-400",
};

const TONE_TEXT: Record<StatTileTone, string> = {
  neutral: "",
  red: "text-red-400",
  sky: "text-sky-400",
  amber: "text-amber-400",
  zinc: "text-zinc-400",
};

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Renders an icon badge above the value instead of a centered text-only layout. */
  icon?: LucideIcon;
  sub?: string;
  /** Tints the icon badge and value text for a semantic outcome. Omit for the neutral default. */
  tone?: StatTileTone;
  className?: string;
  /** "card" (default) is the stacked icon-over-value tile. "row" is a compact
   *  horizontal layout (icon left, value+label right) for dense stacked rails. */
  layout?: "card" | "row";
}

export function StatTile({ label, value, icon: Icon, sub, tone = "neutral", className, layout = "card" }: StatTileProps) {
  if (layout === "row") {
    return (
      <div className={cn("swatch-bar overflow-hidden rounded-xl border border-border bg-field p-3 flex items-center gap-3", className)}>
        {Icon && (
          <div className={cn("size-8 rounded-lg flex items-center justify-center border shrink-0", TONE_ICON[tone])}>
            <Icon className="size-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{label}</p>
          <p className={cn("font-mono text-lg font-bold tabular-nums leading-tight", TONE_TEXT[tone])}>{value}</p>
          {sub && <p className="text-[9px] text-muted-foreground/60 mt-0.5 truncate">{sub}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("swatch-bar-top overflow-hidden rounded-xl border border-border bg-field p-3", Icon ? "flex flex-col gap-2" : "text-center py-3", className)}>
      {Icon && (
        <div className={cn("size-7 rounded-lg flex items-center justify-center border", TONE_ICON[tone])}>
          <Icon className="size-3.5" />
        </div>
      )}
      <div>
        <p className={cn("font-mono text-xl font-bold tabular-nums leading-tight", TONE_TEXT[tone])}>{value}</p>
        <p className="eyebrow mt-1">{label}</p>
        {sub && <p className="text-[9px] text-muted-foreground/60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}
