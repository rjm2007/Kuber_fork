"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { format } from "date-fns";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { cn } from "@/lib/utils";

/** People API Search filters beyond keyword + person location.
 *  https://docs.apollo.io/reference/people-api-search
 *  Untouched values must never be sent — empty Advanced = the existing defaults. */
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
      { key: "titles", label: "Job titles", kind: "list", placeholder: "purchase manager, export manager", tip: "Overrides the default buying-role title list. A person matches if they hold any one of these titles. Leave empty to keep the default list." },
      { key: "seniorities", label: "Seniorities", kind: "list", placeholder: "owner, founder, c_suite, director, manager", tip: "Apollo values: owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern. Leave empty to keep the default (owner through manager)." },
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
      { key: "employeeRanges", label: "Employee ranges", kind: "list", placeholder: "1,10   11,50   51,200", tip: "Headcount as min,max pairs. Leave empty to keep the default ranges (1–10,000)." },
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

const LIST_KEYS = new Set(
  GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "list" || f.kind === "locations").map((f) => f.key)),
);
const NUM_KEYS = new Set(
  GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "num").map((f) => f.key)),
);
const FIELD_LABEL: Record<string, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label])),
);

function csvToList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parseEmployeeRanges(value: string): string[] {
  return [...value.matchAll(/(\d+)\s*,\s*(\d+)/g)].map((m) => `${m[1]},${m[2]}`);
}

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

/** Raw text inputs → the typed shape ApolloSearchSchema.advanced expects. */
export function buildPeopleAdvanced(
  raw: Record<string, string>,
  includeSimilarTitles: boolean,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (!includeSimilarTitles) out.includeSimilarTitles = false;
  for (const [key, value] of Object.entries(raw)) {
    const v = value.trim();
    if (!v) continue;
    if (key === "employeeRanges") {
      const list = parseEmployeeRanges(v);
      if (list.length > 0) out[key] = list;
    } else if (LIST_KEYS.has(key)) {
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
  const active = Object.entries(raw).filter(([, v]) => v.trim() !== "");
  const activeCount = active.length + (includeSimilarTitles ? 0 : 1);

  return (
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
            Separate multiple values with commas. Empty Advanced keeps the usual title, seniority and company-size defaults. Email status stays verified / likely to engage so we never import people Apollo cannot contact.
          </p>
        </div>
      )}
    </div>
  );
}
