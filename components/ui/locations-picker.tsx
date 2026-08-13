"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { InfoTip } from "@/components/ui/info-tip";
import { badgeVariants } from "@/components/ui/badge";
import { LOCATION_MAP, LOCATION_CATEGORIES } from "@/lib/constants";

export const ALL_LOCATION_KEYS = Object.keys(LOCATION_MAP);

/**
 * The region grid on its own — header, 5 columns of regions, no trigger.
 *
 * Split out because the two callers need it presented differently: the Apollo
 * import opens it from a dropdown, while a team-table row has nowhere to put a
 * dropdown (the table clips absolutely-positioned children) and shows it inside
 * a modal instead. Same grid either way.
 */
export function LocationsGrid({
  selected,
  onChangeSelected,
  maxHeightClassName = "max-h-80",
}: {
  selected: string[];
  onChangeSelected: (v: string[]) => void;
  maxHeightClassName?: string;
}) {
  function toggleCountry(country: string) {
    onChangeSelected(selected.includes(country) ? selected.filter((c) => c !== country) : [...selected, country]);
  }

  function toggleRegion(countries: string[]) {
    const allSel = countries.every((c) => selected.includes(c));
    if (allSel) onChangeSelected(selected.filter((c) => !countries.includes(c)));
    else onChangeSelected([...selected, ...countries.filter((c) => !selected.includes(c))]);
  }

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/40">
        <p className="eyebrow">
          {selected.length > 0 ? `${selected.length} of ${ALL_LOCATION_KEYS.length} selected` : "Select countries by region"}
        </p>
        <div className="flex items-center gap-3">
          {selected.length > 0 && (
            <Button type="button" variant="link" size="sm" onClick={() => onChangeSelected([])} className="h-auto p-0 text-[11px] text-muted-foreground">
              Clear
            </Button>
          )}
          <Button type="button" variant="link" size="sm" onClick={() => onChangeSelected([...ALL_LOCATION_KEYS])} className="h-auto p-0 text-[11px]">
            Select all
          </Button>
        </div>
      </div>

      {/* 5-column grid of regions */}
      <div className={cn("grid grid-cols-5 overflow-y-auto", maxHeightClassName)}>
        {(() => {
          const cols: (typeof LOCATION_CATEGORIES)[] = [[], [], [], [], []];
          LOCATION_CATEGORIES.forEach((cat, i) => cols[i % 5].push(cat));
          return cols.map((col, ci) => (
            <div key={ci} className={cn("flex flex-col", ci < 4 && "border-r border-border")}>
              {col.map((region, ri) => {
                const allSel = region.countries.every((c) => selected.includes(c));
                const someSel = region.countries.some((c) => selected.includes(c));
                return (
                  <div key={region.id} className={cn("px-3 pt-3 pb-2", ri > 0 && "border-t border-border/60")}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => toggleRegion(region.countries)}
                      className="w-full h-auto flex-col items-center gap-1.5 mb-2 rounded-none p-0 font-normal group hover:bg-transparent"
                    >
                      <div className="flex items-center gap-2">
                        <AppCheckbox size="sm" checked={allSel ? true : someSel ? "indeterminate" : false} />
                        <span className="text-[11px] font-bold uppercase tracking-wide text-foreground group-hover:text-primary transition-colors text-center leading-tight">
                          {region.label}
                        </span>
                      </div>
                      <div className="w-full h-px bg-border/60" />
                    </Button>
                    <div className="space-y-0.5">
                      {region.countries.map((country) => {
                        const checked = selected.includes(country);
                        return (
                          <Button
                            key={country}
                            type="button"
                            variant="ghost"
                            onClick={() => toggleCountry(country)}
                            className={cn(
                              "w-full h-auto justify-start gap-2 rounded px-2 py-1 text-left font-normal",
                              checked ? "bg-primary/10 hover:bg-primary/10" : "hover:bg-secondary/60",
                            )}
                          >
                            <AppCheckbox size="sm" checked={checked} />
                            <span className={cn("text-xs leading-tight", checked ? "text-foreground font-medium" : "text-muted-foreground")}>
                              {country}
                            </span>
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ));
        })()}
      </div>
    </>
  );
}

/**
 * Region/country picker: region headers with tri-state checkboxes over a
 * 5-column grid, plus "Select all" and pills for what is chosen.
 *
 * Lifted out of lead-forms.tsx unchanged so employee territories can be set
 * with the same control the Apollo import uses — one grid to learn, and one
 * place to fix when a country list changes. Everything the two callers word
 * differently (label, placeholder, help text) is a prop; the grid itself is not
 * configurable on purpose.
 */
export function LocationsPicker({
  selected,
  onChangeSelected,
  label = "Locations",
  helpText = "No selection = worldwide search. Select specific countries to narrow results, or leave empty to search globally.",
  placeholder = "Select countries… (empty = worldwide)",
  showPills = true,
  panelClassName,
}: {
  selected: string[];
  onChangeSelected: (v: string[]) => void;
  label?: string;
  helpText?: string;
  placeholder?: string;
  showPills?: boolean;
  /** Override panel positioning where the trigger sits inside a narrow cell. */
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Region toggling lives in LocationsGrid; this only needs the per-pill remove.
  function toggleCountry(country: string) {
    onChangeSelected(selected.includes(country) ? selected.filter((c) => c !== country) : [...selected, country]);
  }

  const selectedCount = selected.length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label>{label}</Label>
          {helpText && <InfoTip side="right" text={helpText} />}
        </div>
        {selectedCount > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChangeSelected([])} className="h-auto p-0 text-[10px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground">
            Clear ({selectedCount})
          </Button>
        )}
      </div>

      <div ref={ref} className="relative">
        {/* Trigger */}
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "w-full justify-between px-3 py-2 text-sm font-normal text-left bg-card",
            open ? "border-ring ring-1 ring-ring" : "border-input hover:border-muted-foreground",
          )}
        >
          <span className={selectedCount === 0 ? "text-muted-foreground/60" : "text-foreground"}>
            {selectedCount === 0
              ? placeholder
              : `${selectedCount} countr${selectedCount !== 1 ? "ies" : "y"} selected`}
          </span>
          <svg viewBox="0 0 24 24" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </Button>

        {/* Panel */}
        {open && (
          <div className={cn(
            "absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-border bg-card shadow-2xl overflow-hidden",
            panelClassName,
          )}>
            <LocationsGrid selected={selected} onChangeSelected={onChangeSelected} />

            {/* Footer */}
            <div className="border-t border-border px-4 py-2.5 flex items-center justify-end bg-secondary/20">
              <Button type="button" variant="link" size="sm" onClick={() => setOpen(false)} className="h-auto p-0 text-xs">
                Done
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Selected pills */}
      {showPills && selected.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {selected.map((c) => (
            <span key={c} className={cn(badgeVariants({ variant: "selected" }), "gap-1 px-2")}>
              {c}
              <button type="button" onClick={() => toggleCountry(c)} className="hover:text-destructive transition-colors">
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
