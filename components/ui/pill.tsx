import { cn } from "@/lib/utils";
import { getBatchColor, type BatchColorName } from "@/lib/constants";

/** A single reusable colour + text pill — batch tags, status/score chips,
 *  and any other "small coloured label" in the app render through this, so a
 *  palette, shape, or text-alignment fix only needs to happen once.
 *
 *  `color` picks a tone from the shared batch palette (and drives `dot`).
 *  For a one-off semantic colour that isn't in that palette (status/score
 *  chips, etc.), leave `color` at its default and pass `bg`/`border`/`text`
 *  utilities via `className` — they override the palette tone since later
 *  classes win. */
export function Pill({
  color = "violet",
  dot = false,
  icon,
  shape = "full",
  className,
  children,
  ...rest
}: {
  color?: BatchColorName;
  dot?: boolean;
  icon?: React.ReactNode;
  /** "full" — a soft coloured tag (batches, leads table). "sm" — a tighter
   *  uppercase status/score chip. */
  shape?: "full" | "sm";
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const c = getBatchColor(color);
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 border text-xs leading-none font-medium whitespace-nowrap",
        shape === "full" ? "rounded-full px-2.5 py-1" : "rounded-sm px-1.5 py-0.5",
        c.pill,
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full shrink-0", c.bg)} />}
      {icon}
      {/* leading-none removes the extra line-height, but the line box still
          centers on font ascent+descent rather than the glyphs' visual ink,
          so text reads as sitting high — nudge to its optical center. The
          bias is smaller at text-xs (shape="full") than at text-[10px]
          (shape="sm"), so the correction scales with it. */}
      <span className={shape === "full" ? "translate-y-[0.5px]" : "translate-y-px"}>{children}</span>
    </span>
  );
}
