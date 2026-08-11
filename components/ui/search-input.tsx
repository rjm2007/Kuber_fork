"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "h-8 pl-8 text-xs",
  default: "h-9 pl-9 text-sm",
} as const;

const ICON_POSITION_CLASSES = {
  sm: "left-2.5",
  default: "left-3",
} as const;

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  size = "default",
  className,
  wrapperClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "default";
  className?: string;
  wrapperClassName?: string;
}) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <Search className={cn("absolute top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none", ICON_POSITION_CLASSES[size])} />
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(SIZE_CLASSES[size], className)}
      />
    </div>
  );
}
