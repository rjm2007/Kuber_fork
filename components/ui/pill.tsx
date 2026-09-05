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
        "inline-flex items-center justify-center gap-1 border leading-none font-medium whitespace-nowrap",
        shape === "full" ? "rounded-full px-2 py-0.5 text-[11px]" : "rounded-sm px-1.5 py-0.5 text-[10px]",
        c.pill,
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full shrink-0", c.bg)} />}
      {icon}
      {children}
    </span>
  );
}
