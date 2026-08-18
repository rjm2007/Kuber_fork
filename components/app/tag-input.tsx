"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function TagInput({
  label,
  pills,
  suggestions,
  onChange,
  placeholder,
  allowCustom = true,
  max,
  required,
  tip,
}: {
  label: string;
  pills: string[];
  suggestions: readonly string[];
  onChange: (pills: string[]) => void;
  placeholder?: string;
  allowCustom?: boolean;
  max?: number;
  required?: boolean;
  tip?: string;
}) {
  const [query,     setQuery] = useState("");
  const [open,      setOpen ] = useState(false);
  const containerRef          = useRef<HTMLDivElement>(null);
  const inputRef              = useRef<HTMLInputElement>(null);

  const maxReached = max !== undefined && pills.length >= max;
  const q = query.trim().toLowerCase();
  const filtered = suggestions.filter((s) => s.toLowerCase().includes(q) && !pills.includes(s));
  const exactMatch = suggestions.some((s) => s.toLowerCase() === q);
  const canAddCustom = allowCustom && q.length > 0 && !exactMatch && !pills.includes(query.trim());

  function add(value: string) {
    const v = value.trim();
    if (!v || pills.includes(v) || maxReached) return;
    onChange([...pills, v]);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  }
  function remove(value: string) { onChange(pills.filter((p) => p !== value)); }
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Enter" || e.key === ",") && query.trim() && !maxReached) {
      e.preventDefault();
      if (filtered.length > 0 && !canAddCustom) add(filtered[0]);
      else if (allowCustom) add(query.trim());
    }
    if (e.key === "Backspace" && !query && pills.length > 0) onChange(pills.slice(0, -1));
    if (e.key === "Escape") setOpen(false);
  }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showDropdown = open && !maxReached && (filtered.length > 0 || canAddCustom);

  return (
    <div className="space-y-1.5" ref={containerRef}>
      <div className="flex items-center gap-1">
        <Label>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
        {tip && <InfoTip text={tip} side="right" />}
      </div>
      <div
        className="relative min-h-9 flex flex-wrap gap-1.5 items-center rounded-md border border-input bg-field px-3 py-2 cursor-text focus-within:ring-1 focus-within:ring-ring focus-within:border-transparent transition-shadow"
        onClick={() => !maxReached && inputRef.current?.focus()}
      >
        {pills.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30 text-xs leading-none font-mono font-medium text-primary">
            {p}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={(e) => { e.stopPropagation(); remove(p); }}
              className="size-3.5 rounded-full p-0 text-primary hover:bg-transparent hover:text-destructive"
            >
              <X className="size-2.5" />
            </Button>
          </span>
        ))}
        {!maxReached && (
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={pills.length === 0 ? (placeholder ?? "Type to search…") : ""}
            className="h-auto flex-1 min-w-[120px] border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/50"
          />
        )}
      </div>
      {showDropdown && (
        <div className="relative z-50">
          <div className="absolute top-0 left-0 right-0 rounded-md border border-border bg-popover shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            {filtered.map((s) => (
              <Button
                key={s}
                type="button"
                variant="ghost"
                onMouseDown={(e) => { e.preventDefault(); add(s); }}
                className="h-auto w-full justify-start rounded-none px-3 py-2 text-sm font-normal"
              >
                {s}
              </Button>
            ))}
            {canAddCustom && (
              <Button
                type="button"
                variant="ghost"
                onMouseDown={(e) => { e.preventDefault(); add(query.trim()); }}
                className="h-auto w-full justify-start gap-2 rounded-none border-t border-border px-3 py-2 text-sm font-normal text-muted-foreground"
              >
                <Plus className="size-3.5 shrink-0" />
                Add &ldquo;{query.trim()}&rdquo;
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
