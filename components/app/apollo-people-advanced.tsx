"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { format } from "date-fns";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { AppCheckbox } from "@/components/ui/app-checkbox";
import { badgeVariants } from "@/components/ui/badge";
import { APOLLO_TITLES, APOLLO_SENIORITIES, EMPLOYEE_RANGES } from "@/lib/constants";
import { cn } from "@/lib/utils";

function csvToList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parseEmployeeRanges(value: string): string[] {
  return [...value.matchAll(/(\d+)\s*,\s*(\d+)/g)].map((m) => `${m[1]},${m[2]}`);
}

/** People API Search filters beyond keyword + person location.
 *  https://docs.apollo.io/reference/people-api-search
 *  Titles / seniorities / employee ranges live as always-visible pill
 *  sections above this panel — only the less-common filters stay here. */
const GROUPS: {
  group: string;
  fields: {
    key: string;
    label: string;
    kind: "list" | "num" | "date" | "locations" | "text";
    placeholder?: string;
    tip: string;
  }[];
}[] = [
  {
    group: "Person",
    fields: [
      { key: "notTitles", label: "Exclude job titles", kind: "list", placeholder: "sales, marketing, recruiter", tip: "Drops anyone holding one of these titles. Useful for keeping a procurement search free of sales contacts." },
      { key: "personName", label: "Person name", kind: "text", placeholder: "Martin", tip: "Find a specific person by name. Normally left empty." },
    ],
  },
  {
    group: "Company",
    fields: [
      { key: "industryTagIds", label: "Industries (Apollo tag IDs)", kind: "list", placeholder: "5567cd4773696439b10b0000", tip: "Apollo's controlled industry list — the only filter that reliably removes off-target companies (shipping lines, universities) that a keyword match still returns. Apollo publishes no id list: filter by industry inside Apollo itself and copy the id out of the URL. Comma-separate several." },
      { key: "organizationLocations", label: "HQ locations", kind: "locations", placeholder: "Select company headquarters…", tip: "Filters by the employer's headquarters, not where the person lives. Locations above still filter the person. Measured: adding this cut a sample search from 27,066 to 15,552." },
      { key: "organizationNotLocations", label: "Exclude HQ countries", kind: "locations", placeholder: "Select countries to exclude…", tip: "Removes companies headquartered in these countries." },
      { key: "organizationName", label: "Company name", kind: "text", placeholder: "ePac", tip: "Find people at one company by its name. Normally left empty." },
      { key: "domains", label: "Company domains", kind: "list", placeholder: "apollo.io, microsoft.com", tip: "Employer domains. No www. or @. Up to 1,000 per search." },
      { key: "revenueMin", label: "Revenue min", kind: "num", tip: "Minimum employer revenue. No currency symbols or commas." },
      { key: "revenueMax", label: "Revenue max", kind: "num", tip: "Maximum employer revenue. No currency symbols or commas." },
      { key: "technologyAny", label: "Uses any of these technologies", kind: "list", placeholder: "salesforce, sap", tip: "People whose employer uses at least one of these web technologies. Use underscores for spaces (google_analytics). Rarely useful for manufacturers — most plastics converters carry no tech tags at all, so filling this in can silently drop the result count to near zero." },
      { key: "technologyAll", label: "Uses all of these technologies", kind: "list", placeholder: "shopify, klaviyo", tip: "People whose employer uses every technology listed." },
      { key: "technologyNot", label: "Does not use these technologies", kind: "list", placeholder: "hubspot", tip: "Exclude people whose employer uses any of these technologies." },
    ],
  },
  {
    group: "Hiring signals",
    fields: [
      { key: "jobTitles", label: "Hiring for titles", kind: "list", placeholder: "export manager", tip: "Companies currently hiring for these roles." },
      { key: "jobLocations", label: "Job locations", kind: "locations", placeholder: "Select countries they are hiring in…", tip: "Only companies hiring in the selected countries." },
      { key: "numJobsMin", label: "Open jobs min", kind: "num", tip: "Minimum number of active job postings at the employer." },
      { key: "numJobsMax", label: "Open jobs max", kind: "num", tip: "Maximum number of active job postings at the employer." },
      { key: "jobPostedAtMin", label: "Job posted after", kind: "date", tip: "Only jobs posted on or after this date." },
      { key: "jobPostedAtMax", label: "Job posted before", kind: "date", tip: "Only jobs posted on or before this date." },
    ],
  },
];

/** Always-visible buying-role defaults — promoted out of Advanced so the
 *  client can see and deselect them. Empty = no filter of that kind (do not
 *  silently re-apply the catalog default). */
const PRIMARY_FILTERS: {
  key: "titles" | "seniorities" | "employeeRanges";
  label: string;
  tip: string;
  defaults: readonly string[];
  parse: (value: string) => string[];
  serialize: (values: string[]) => string;
  format: (value: string) => string;
  /** Trigger copy when nothing is selected. */
  placeholder: string;
  /** Singular unit for "N titles selected". */
  unit: string;
  unitPlural: string;
  customPlaceholder: string;
  /** Normalize a custom typed value; null = reject. */
  normalizeCustom: (raw: string) => string | null;
}[] = [
  {
    key: "titles",
    label: "Job titles",
    tip: "Buying-role titles sent to Apollo. A person matches if they hold any one of these. Deselect ones you do not want, or add your own.",
    defaults: APOLLO_TITLES,
    parse: csvToList,
    serialize: (v) => v.join(", "),
    format: (v) => v,
    placeholder: "Select job titles…",
    unit: "title",
    unitPlural: "titles",
    customPlaceholder: "e.g. head of supply chain",
    normalizeCustom: (raw) => {
      const v = raw.trim().toLowerCase();
      return v || null;
    },
  },
  {
    key: "seniorities",
    label: "Seniorities",
    tip: "Apollo seniority values. Deselect levels you do not want, or add others (senior, entry, intern, …).",
    defaults: APOLLO_SENIORITIES,
    parse: csvToList,
    serialize: (v) => v.join(", "),
    format: (v) => v.replaceAll("_", " "),
    placeholder: "Select seniorities…",
    unit: "seniority",
    unitPlural: "seniorities",
    customPlaceholder: "e.g. senior",
    normalizeCustom: (raw) => {
      const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
      return v || null;
    },
  },
  {
    key: "employeeRanges",
    label: "Employee ranges",
    tip: "Employer headcount as min–max pairs. Deselect sizes you do not want, or add a custom range.",
    defaults: EMPLOYEE_RANGES,
    parse: parseEmployeeRanges,
    serialize: (v) => v.join("   "),
    format: (v) => v.replace(",", "–"),
    placeholder: "Select employee ranges…",
    unit: "range",
    unitPlural: "ranges",
    customPlaceholder: "e.g. 10,200 or 10-200",
    normalizeCustom: (raw) => {
      const m = raw.trim().match(/^(\d+)\s*[,–\-]\s*(\d+)$/);
      return m ? `${m[1]},${m[2]}` : null;
    },
  },
];

const PRIMARY_KEYS: Set<string> = new Set(PRIMARY_FILTERS.map((f) => f.key));

const LIST_KEYS = new Set([
  ...PRIMARY_FILTERS.map((f) => f.key),
  ...GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "list" || f.kind === "locations").map((f) => f.key)),
]);
const NUM_KEYS = new Set(
  GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "num").map((f) => f.key)),
);
const FIELD_LABEL: Record<string, string> = Object.fromEntries([
  ...PRIMARY_FILTERS.map((f) => [f.key, f.label] as const),
  ...GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label] as const)),
]);

function parseYmd(value: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <DatePicker
      date={parseYmd(value)}
      onChangeDate={(d) => onChange(d ? format(d, "yyyy-MM-dd") : "")}
      displayFormat="MMM d, yyyy"
      size="sm"
      showQuickActions
    />
  );
}

function PrimaryFilterPicker({
  label,
  tip,
  values,
  defaults,
  formatValue,
  onChange,
  placeholder,
  unit,
  unitPlural,
  customPlaceholder,
  normalizeCustom,
}: {
  label: string;
  tip: string;
  values: string[];
  defaults: readonly string[];
  formatValue: (value: string) => string;
  onChange: (next: string[]) => void;
  placeholder: string;
  unit: string;
  unitPlural: string;
  customPlaceholder: string;
  normalizeCustom: (raw: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const [customOptions, setCustomOptions] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Catalog = defaults + any custom values the user has added (or still has selected).
  const defaultSet = new Set(defaults);
  const extras = [
    ...customOptions,
    ...values.filter((v) => !defaultSet.has(v) && !customOptions.includes(v)),
  ];
  const options = [...defaults, ...extras.filter((v, i) => extras.indexOf(v) === i)];

  const selectedCount = values.length;
  const allSelected = options.length > 0 && options.every((o) => values.includes(o));
  const someSelected = options.some((o) => values.includes(o));

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  }

  function selectAll() {
    onChange([...options]);
  }

  function clearAll() {
    onChange([]);
  }

  function addCustom() {
    const normalized = normalizeCustom(customInput);
    if (!normalized || values.includes(normalized)) return;
    if (!defaultSet.has(normalized) && !customOptions.includes(normalized)) {
      setCustomOptions((prev) => [...prev, normalized]);
    }
    onChange([...values, normalized]);
    setCustomInput("");
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Label className="text-[11px] font-normal text-muted-foreground">{label}</Label>
          <InfoTip side="right" text={tip} />
        </div>
        {selectedCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="h-auto p-0 text-[10px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            Clear ({selectedCount})
          </Button>
        )}
      </div>

      <div ref={ref} className="relative">
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "w-full justify-between px-3 py-2 text-sm font-normal text-left bg-field hover:bg-field",
            open ? "border-ring ring-1 ring-ring" : "border-input hover:border-muted-foreground",
          )}
        >
          <span className={selectedCount === 0 ? "text-muted-foreground/60" : "text-foreground"}>
            {selectedCount === 0
              ? placeholder
              : `${selectedCount} ${selectedCount === 1 ? unit : unitPlural} selected`}
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </Button>

        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-secondary/40">
              <p className="eyebrow">
                {selectedCount > 0
                  ? `${selectedCount} of ${options.length} selected`
                  : "Select options"}
              </p>
              <div className="flex items-center gap-3">
                {selectedCount > 0 && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={clearAll}
                    className="h-auto p-0 text-[11px] text-muted-foreground"
                  >
                    Clear
                  </Button>
                )}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={selectAll}
                  className="h-auto p-0 text-[11px]"
                >
                  Select all
                </Button>
              </div>
            </div>

            <div className="max-h-56 overflow-y-auto p-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => (allSelected ? clearAll() : selectAll())}
                className={cn(
                  "w-full h-auto justify-start gap-2 rounded px-2 py-1.5 mb-1 font-normal",
                  allSelected ? "bg-primary/10 hover:bg-primary/10" : "hover:bg-secondary/60",
                )}
              >
                <AppCheckbox size="sm" checked={allSelected ? true : someSelected ? "indeterminate" : false} />
                <span className={cn("text-xs", allSelected ? "text-foreground font-medium" : "text-muted-foreground")}>
                  Select all
                </span>
              </Button>
              <div className="h-px bg-border/60 my-1" />
              {options.map((opt) => {
                const checked = values.includes(opt);
                const isCustom = !defaultSet.has(opt);
                return (
                  <div
                    key={opt}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1 rounded transition-colors",
                      checked ? "bg-primary/10" : "hover:bg-secondary/60",
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => toggle(opt)}
                      className="h-auto flex-1 justify-start gap-2 rounded-none p-0 text-left font-normal min-w-0 hover:bg-transparent"
                    >
                      <AppCheckbox size="sm" checked={checked} />
                      <span className={cn("text-xs leading-tight truncate", checked ? "text-foreground font-medium" : "text-muted-foreground")}>
                        {formatValue(opt)}
                      </span>
                    </Button>
                    {isCustom && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setCustomOptions((prev) => prev.filter((x) => x !== opt));
                          onChange(values.filter((v) => v !== opt));
                        }}
                        className="size-5 shrink-0 rounded text-muted-foreground hover:bg-transparent hover:text-destructive"
                        title="Remove custom value"
                      >
                        <X className="size-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="border-t border-border px-4 py-3 bg-secondary/30">
              <p className="eyebrow mb-2">Add custom</p>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); addCustom(); }
                    if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder={customPlaceholder}
                  className="h-auto flex-1 rounded-md px-3 py-1.5 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={addCustom}
                  disabled={!normalizeCustom(customInput) || values.includes(normalizeCustom(customInput)!)}
                  className="h-auto shrink-0 gap-1 px-3 py-1.5 text-xs [&_svg]:size-3"
                >
                  <Plus /> Add
                </Button>
              </div>
            </div>

            <div className="border-t border-border px-4 py-2.5 flex items-center justify-end bg-secondary/30">
              <Button type="button" variant="link" size="sm" onClick={() => setOpen(false)} className="h-auto p-0 text-xs">
                Done
              </Button>
            </div>
          </div>
        )}
      </div>

      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {values.map((v) => (
            <span key={v} className={badgeVariants({ variant: "selected" })}>
              {formatValue(v)}
              <button
                type="button"
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="inline-flex size-3 items-center justify-center hover:text-destructive transition-colors"
                aria-label={`Remove ${formatValue(v)}`}
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Raw text inputs → the typed shape ApolloSearchSchema.advanced expects.
 *  Primary filter keys are always emitted when present in raw (including an
 *  empty list) so clearing every pill turns the filter off instead of
 *  silently falling back to catalog defaults. */
export function buildPeopleAdvanced(
  raw: Record<string, string>,
  includeSimilarTitles: boolean,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (!includeSimilarTitles) out.includeSimilarTitles = false;
  for (const [key, value] of Object.entries(raw)) {
    const v = value.trim();
    if (key === "employeeRanges") {
      out[key] = parseEmployeeRanges(v);
      continue;
    }
    if (PRIMARY_KEYS.has(key)) {
      out[key] = csvToList(v);
      continue;
    }
    if (!v) continue;
    if (LIST_KEYS.has(key)) {
      const list = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) out[key] = list;
    } else if (NUM_KEYS.has(key)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    } else {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function ApolloPeopleAdvanced({
  raw,
  onRawChange,
  includeSimilarTitles,
  onIncludeSimilarTitlesChange,
}: {
  raw: Record<string, string>;
  onRawChange: (next: Record<string, string>) => void;
  includeSimilarTitles: boolean;
  onIncludeSimilarTitlesChange: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // Primary filters have their own pill UI — only count the less-common
  // Advanced overrides in the badge.
  const active = Object.entries(raw).filter(
    ([k, v]) => !PRIMARY_KEYS.has(k) && v.trim() !== "",
  );
  const activeCount = active.length + (includeSimilarTitles ? 0 : 1);

  function setPrimaryList(key: string, serialize: (values: string[]) => string, next: string[]) {
    onRawChange({ ...raw, [key]: serialize(next) });
  }

  return (
    <div className="space-y-4">
      {PRIMARY_FILTERS.map((f) => (
        <PrimaryFilterPicker
          key={f.key}
          label={f.label}
          tip={f.tip}
          values={f.parse(raw[f.key] ?? "")}
          defaults={f.defaults}
          formatValue={f.format}
          onChange={(next) => setPrimaryList(f.key, f.serialize, next)}
          placeholder={f.placeholder}
          unit={f.unit}
          unitPlural={f.unitPlural}
          customPlaceholder={f.customPlaceholder}
          normalizeCustom={f.normalizeCustom}
        />
      ))}

      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between py-1 text-left"
        >
          <span className="text-xs font-medium">
            Advanced search
            {activeCount > 0 && (
              <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                {activeCount} active
              </span>
            )}
          </span>
          <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>

        {!open && activeCount > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {!includeSimilarTitles && (
              <button
                type="button"
                onClick={() => onIncludeSimilarTitlesChange(true)}
                className="rounded border border-border bg-field px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="Remove filter"
              >
                similar titles off ✕
              </button>
            )}
            {active.map(([k, v]) => (
              <button
                key={k}
                type="button"
                onClick={() => onRawChange({ ...raw, [k]: "" })}
                className="rounded border border-border bg-field px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="Remove filter"
              >
                {FIELD_LABEL[k] ?? k}: {v} ✕
              </button>
            ))}
          </div>
        )}

        {open && (
          <div className="space-y-3 pt-3">
            <div className="flex items-center justify-between rounded-md border border-border bg-field px-3 py-2">
              <div className="flex items-center gap-1 min-w-0 pr-3">
                <Label className="text-[11px] font-normal">Match similar titles</Label>
                <InfoTip side="right" text="On (default): Apollo also returns close title variants — Head of Purchasing for purchase manager. Off: only the titles you list (or the default list) match." />
              </div>
              <Switch tone="success" checked={includeSimilarTitles} onCheckedChange={onIncludeSimilarTitlesChange} />
            </div>

            {GROUPS.map((g) => (
              <div key={g.group} className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</p>
                <div className="grid grid-cols-2 gap-2">
                  {g.fields.map((f) => (
                    f.kind === "locations" ? (
                      <div key={f.key} className="col-span-2">
                        <LocationsPicker
                          label={f.label}
                          helpText={f.tip}
                          placeholder={f.placeholder ?? "Select countries…"}
                          selected={csvToList(raw[f.key])}
                          onChangeSelected={(v) => onRawChange({ ...raw, [f.key]: v.join(", ") })}
                          labelClassName="text-[11px] font-normal text-muted-foreground"
                          triggerClassName="h-8 text-xs"
                        />
                      </div>
                    ) : f.kind === "date" ? (
                      <div key={f.key} className="space-y-1">
                        <div className="flex items-center gap-0.5">
                          <Label className="text-[11px] font-normal text-muted-foreground">{f.label}</Label>
                          <InfoTip side="right" text={f.tip} />
                        </div>
                        <DateField
                          value={raw[f.key] ?? ""}
                          onChange={(v) => onRawChange({ ...raw, [f.key]: v })}
                        />
                      </div>
                    ) : (
                      <div key={f.key} className="space-y-1">
                        <div className="flex items-center gap-0.5">
                          <Label className="text-[11px] font-normal text-muted-foreground">{f.label}</Label>
                          <InfoTip side="right" text={f.tip} />
                        </div>
                        <Input
                          value={raw[f.key] ?? ""}
                          onChange={(e) => onRawChange({ ...raw, [f.key]: e.target.value })}
                          placeholder={f.placeholder}
                          type={f.kind === "num" ? "number" : "text"}
                          className="h-8 text-xs"
                        />
                      </div>
                    )
                  ))}
                </div>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              Separate multiple values with commas. Job titles, seniorities and employee ranges are edited above — empty Advanced here adds no further filters. Email status stays verified / likely to engage so we never import people Apollo cannot contact.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
