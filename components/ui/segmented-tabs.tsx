"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared chrome for every segmented tab bar in the app. */
export const segmentedListClassName =
  "inline-flex items-center justify-center rounded-lg border border-border bg-field p-0.5 text-muted-foreground";

export function segmentedTriggerClassName(active: boolean, size: "sm" | "md" | "lg" = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 font-medium leading-none transition-colors whitespace-nowrap",
    size === "sm" && "h-7 px-2.5 rounded-md text-[10px]",
    size === "md" && "h-8 px-3 rounded-md text-xs",
    size === "lg" && "h-10 px-5 rounded-md text-sm gap-2",
    active
      ? "bg-primary/15 text-primary"
      : "text-muted-foreground hover:text-foreground",
  );
}

export type SegmentedTabOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
  disabled?: boolean;
};

export function SegmentedTabs<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "md",
  fullWidth = false,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedTabOption<T>[] | SegmentedTabOption<T>[];
  className?: string;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
}) {
  return (
    <div
      role="tablist"
      className={cn(segmentedListClassName, fullWidth && "w-full", className)}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              segmentedTriggerClassName(active, size),
              fullWidth && "flex-1",
              opt.disabled && "opacity-50 pointer-events-none",
            )}
          >
            {Icon ? <Icon className={size === "sm" ? "size-3" : size === "lg" ? "size-4" : "size-3.5"} /> : null}
            <span>{opt.label}</span>
            {typeof opt.count === "number" && opt.count > 0 ? (
              <span
                className={cn(
                  "rounded-full font-mono font-semibold tabular-nums text-center",
                  size === "lg" ? "min-w-[20px] px-1.5 text-[11px]" : "min-w-[18px] px-1 text-[10px]",
                  active ? "bg-primary/20 text-primary" : "bg-primary/15 text-primary",
                )}
              >
                {opt.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
