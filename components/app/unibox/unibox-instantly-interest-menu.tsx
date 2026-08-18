"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import { INTEREST_FILTER_OPTIONS } from "@/components/app/unibox/unibox-status-filter";

const INTEREST_OPTIONS: { value: number | null; label: string; color: string }[] = [
  { value: null, label: "Lead", color: "text-muted-foreground" },
  ...INTEREST_FILTER_OPTIONS.filter((o) => o.value !== "lead").map((o) => ({
    value: o.value as number,
    label: o.label,
    color: o.color,
  })),
];

function currentOption(interestStatus: number | null) {
  return INTEREST_OPTIONS.find((o) => o.value === interestStatus)
    ?? INTEREST_OPTIONS.find((o) => o.value === null)!;
}

type Props = {
  interestStatus: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
};

export function UniboxInstantlyInterestMenu({ interestStatus, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = currentOption(interestStatus);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return INTEREST_OPTIONS;
    return INTEREST_OPTIONS.filter((o) => o.label.toLowerCase().includes(q));
  }, [search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-8 px-2.5 bg-field text-xs font-mono font-medium uppercase tracking-wide"
        >
          <Zap className={cn("size-3.5", current.color)} />
          <span>{current.label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-0 overflow-hidden">
        <p className="eyebrow px-3 pt-2.5">Instantly status</p>
        <div className="p-2 border-b border-border">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search…"
            size="sm"
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1.5 space-y-0.5">
          {filtered.map((o) => {
            const selected = interestStatus === o.value || (o.value === null && interestStatus === null);
            return (
              <button
                key={o.label}
                type="button"
                className={cn(
                  "w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-secondary/60 flex items-center gap-2 border-l-2",
                  selected ? "font-semibold text-primary bg-primary/10 border-primary" : "text-muted-foreground border-transparent",
                )}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                  setSearch("");
                }}
              >
                <Zap className={cn("size-3.5 shrink-0", o.color)} />
                {o.label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
