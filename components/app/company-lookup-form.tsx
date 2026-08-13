"use client";

import { useState } from "react";
import { AlertCircle, Building2, ChevronDown, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Stepper } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";
import {
  AssignStrategyPicker,
  BatchNameField,
  buildImportAssignment,
  getToken,
  useAssignableEmployees,
  type ImportAssignMode,
} from "@/components/app/lead-forms";
import { COMPANY_LOOKUP_MAX_CONTACTS, COMPANY_LOOKUP_MAX_PAGES } from "@/lib/constants";

const STEPS = ["Find company", "Select company", "Select people", "Batch & assign"];

/** Rows shown per screen while paging through companies already paid for.
 *  Purely cosmetic — moving between these pages costs nothing. */
const ROWS_PER_VIEW = 20;

interface Company {
  apollo_org_id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  employees: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
  linkedin_url: string | null;
  founded_year: number | null;
  already_in_system: boolean;
}

interface Contact {
  apollo_id: string;
  first_name: string | null;
  last_name_masked: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organization_name: string | null;
  already_imported: boolean;
  unenrichable: boolean;
}

/** Every Organization Search filter beyond the three basic fields. Comma-separated
 *  text for list params keeps the panel to one control per filter — these are
 *  power-user inputs, not the common path. */
const ADVANCED_GROUPS: {
  group: string;
  fields: { key: string; label: string; kind: "list" | "num" | "date"; placeholder?: string }[];
}[] = [
  {
    group: "Company profile",
    fields: [
      { key: "employeeRanges", label: "Employee ranges", kind: "list", placeholder: "10,200   200,1000" },
      { key: "keywordTags", label: "Industry keywords", kind: "list", placeholder: "plastics, packaging" },
      { key: "revenueMin", label: "Revenue min", kind: "num" },
      { key: "revenueMax", label: "Revenue max", kind: "num" },
      { key: "technologyUids", label: "Technologies used", kind: "list", placeholder: "shopify, sap" },
    ],
  },
  {
    group: "Location",
    fields: [{ key: "notLocations", label: "Exclude locations", kind: "list", placeholder: "China, Vietnam" }],
  },
  {
    group: "Funding",
    fields: [
      { key: "latestFundingAmountMin", label: "Latest funding min", kind: "num" },
      { key: "latestFundingAmountMax", label: "Latest funding max", kind: "num" },
      { key: "totalFundingMin", label: "Total funding min", kind: "num" },
      { key: "totalFundingMax", label: "Total funding max", kind: "num" },
      { key: "latestFundingDateMin", label: "Latest funding after", kind: "date" },
      { key: "latestFundingDateMax", label: "Latest funding before", kind: "date" },
    ],
  },
  {
    group: "Hiring signals",
    fields: [
      { key: "jobTitles", label: "Hiring for titles", kind: "list", placeholder: "export manager" },
      { key: "jobLocations", label: "Job locations", kind: "list", placeholder: "Kenya" },
      { key: "numJobsMin", label: "Open jobs min", kind: "num" },
      { key: "numJobsMax", label: "Open jobs max", kind: "num" },
      { key: "jobPostedAtMin", label: "Job posted after", kind: "date" },
      { key: "jobPostedAtMax", label: "Job posted before", kind: "date" },
    ],
  },
];

const LIST_KEYS = new Set(
  ADVANCED_GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "list").map((f) => f.key)),
);
const NUM_KEYS = new Set(
  ADVANCED_GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "num").map((f) => f.key)),
);

/** Raw text inputs → the typed shape CompanySearchSchema expects. Empty values
 *  are dropped entirely, so an untouched Advanced panel never narrows a search. */
function buildAdvanced(raw: Record<string, string>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = value.trim();
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

export function CompanyLookupForm({ onImport }: { onImport: (n: number) => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Step 1 — search inputs
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [website, setWebsite] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, string>>({});

  // Step 2 — companies
  const [companies, setCompanies] = useState<Company[]>([]);
  const [apolloPage, setApolloPage] = useState(0);
  const [viewPage, setViewPage] = useState(0);
  const [totalEntries, setTotalEntries] = useState(0);
  const [creditsSpent, setCreditsSpent] = useState(0);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(null);

  // Step 3 — contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  // Step 4 — batch
  const [batchName, setBatchName] = useState("");
  const [color, setColor] = useState("violet");
  const [batchNameError, setBatchNameError] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [assignMode, setAssignMode] = useState<ImportAssignMode>("manual");
  const employees = useAssignableEmployees(true);

  const activeAdvanced = Object.entries(advanced).filter(([, v]) => v.trim() !== "");

  async function call<T>(url: string, payload: unknown): Promise<T> {
    const token = await getToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    // fail() nests the reason at error.message — reading json.message would
    // surface a bare status code and throw the real cause away.
    if (!res.ok) throw new Error(json?.error?.message ?? `Request failed: ${res.status}`);
    return json?.data as T;
  }

  /** page 1 = a new search (resets results); page > 1 = buy another Apollo page. */
  async function runSearch(page: number) {
    if (!name.trim()) { setError("Enter a company name."); return; }
    setError("");
    setBusy(true);
    try {
      const data = await call<{
        companies: Company[]; page: number; total_entries: number;
        total_pages: number; credits_spent: number;
      }>("/api/v1/leads/company-search", {
        name: name.trim(),
        country: country.trim() || undefined,
        website: website.trim() || undefined,
        page,
        advanced: buildAdvanced(advanced),
      });

      setCompanies((prev) => (page === 1 ? data.companies : [...prev, ...data.companies]));
      setApolloPage(data.page);
      setTotalEntries(data.total_entries);
      setCreditsSpent((c) => c + data.credits_spent);
      if (page === 1) { setViewPage(0); setSelectedCompany(null); }
      setStep(1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadPeople(company: Company) {
    setError("");
    setBusy(true);
    try {
      const data = await call<{ contacts: Contact[] }>("/api/v1/leads/company-people", {
        apollo_org_id: company.apollo_org_id,
      });
      setSelectedCompany(company);
      setContacts(data.contacts);
      setPicked([]);
      if (!batchName.trim() && company.name) setBatchName(company.name);
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!selectedCompany) return;
    if (!batchName.trim()) { setBatchNameError(true); return; }
    setBatchNameError(false);
    setError("");
    setBusy(true);
    try {
      const chosen = contacts.filter((c) => picked.includes(c.apollo_id));
      const data = await call<{ inserted: number }>("/api/v1/leads/company-import", {
        organization: {
          apollo_org_id: selectedCompany.apollo_org_id,
          name: selectedCompany.name ?? "Unknown",
          domain: selectedCompany.domain,
          website: selectedCompany.website,
          industry: selectedCompany.industry,
          employees: selectedCompany.employees,
          city: selectedCompany.city,
          state: selectedCompany.state,
          country: selectedCompany.country,
        },
        contacts: chosen.map((c) => ({
          apollo_id: c.apollo_id,
          first_name: c.first_name,
          title: c.title,
          city: c.city,
          state: c.state,
          country: c.country,
        })),
        batch_name: batchName,
        color,
        ...buildImportAssignment(assignMode, assignTo),
      });
      if (!data.inserted) { setError("No contacts were imported — they may already be in the system."); setBusy(false); return; }
      onImport(data.inserted);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) =>
      prev.includes(id)
        ? prev.filter((p) => p !== id)
        : prev.length >= COMPANY_LOOKUP_MAX_CONTACTS ? prev : [...prev, id],
    );
  }

  const viewStart = viewPage * ROWS_PER_VIEW;
  const visible = companies.slice(viewStart, viewStart + ROWS_PER_VIEW);
  const canBuyMorePages = apolloPage < COMPANY_LOOKUP_MAX_PAGES && companies.length < totalEntries;
  const atPickLimit = picked.length >= COMPANY_LOOKUP_MAX_CONTACTS;

  return (
    <div className="space-y-5">
      <Stepper steps={STEPS} current={step} className="pb-4 mb-6 border-b border-border" />

      {/* ── Step 1 — Find company ─────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Company name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ABC Plastics"
              className="bg-background"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Country <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Kenya" className="bg-background" />
            </div>
            <div className="space-y-1.5">
              <Label>Website <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="abcplastics.com" className="bg-background" />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/30">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left"
            >
              <span className="text-xs font-medium">
                Advanced search
                {activeAdvanced.length > 0 && (
                  <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {activeAdvanced.length} active
                  </span>
                )}
              </span>
              <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
            </button>

            {/* Active filters stay visible when collapsed — results must never be
                narrowed by something the user can't see. */}
            {!advancedOpen && activeAdvanced.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
                {activeAdvanced.map(([k, v]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setAdvanced((a) => ({ ...a, [k]: "" }))}
                    className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    title="Remove filter"
                  >
                    {k}: {v} ✕
                  </button>
                ))}
              </div>
            )}

            {advancedOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                {ADVANCED_GROUPS.map((g) => (
                  <div key={g.group} className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.group}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {g.fields.map((f) => (
                        <div key={f.key} className="space-y-1">
                          <Label className="text-[11px] font-normal text-muted-foreground">{f.label}</Label>
                          <Input
                            value={advanced[f.key] ?? ""}
                            onChange={(e) => setAdvanced((a) => ({ ...a, [f.key]: e.target.value }))}
                            placeholder={f.placeholder}
                            type={f.kind === "date" ? "date" : f.kind === "num" ? "number" : "text"}
                            className="h-8 bg-background text-xs"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">Separate multiple values with commas. Filters change which companies come back — they don&apos;t change the cost.</p>
              </div>
            )}
          </div>

          <p className="text-[11px] text-amber-500">
            Searching costs <strong>1 Apollo credit</strong> per page of up to 100 companies. A search that matches nothing costs nothing.
          </p>
        </div>
      )}

      {/* ── Step 2 — Select company ───────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Showing <strong>{visible.length === 0 ? 0 : viewStart + 1}–{viewStart + visible.length}</strong> of{" "}
            <strong>{companies.length}</strong> retrieved · <strong>{totalEntries.toLocaleString()}</strong> match in Apollo ·{" "}
            <strong>{creditsSpent}</strong> credit{creditsSpent === 1 ? "" : "s"} spent
          </p>

          {companies.length === 0 ? (
            <div className="rounded-lg border border-border bg-secondary/30 px-4 py-6 text-center">
              <Building2 className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No companies matched</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try a shorter name, remove the country, or adjust Advanced search. This search cost nothing.
              </p>
              <Button type="button" variant="outline" className="mt-3 bg-card" onClick={() => setStep(0)}>Refine search</Button>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-secondary/30 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Company</th>
                      <th className="px-3 py-2 text-left font-medium">Location</th>
                      <th className="px-3 py-2 text-right font-medium">Staff</th>
                      <th className="px-3 py-2 text-left font-medium">Website</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((c) => (
                      <tr key={c.apollo_org_id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <span className="font-medium">{c.name ?? "—"}</span>
                          {c.already_in_system && (
                            <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              Already in system
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {[c.city, c.country].filter(Boolean).join(", ") || "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {c.employees?.toLocaleString() ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{c.domain ?? "—"}</td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant={c.already_in_system ? "outline" : "default"}
                            disabled={c.already_in_system || busy}
                            title={c.already_in_system ? "This company is already tracked — Company Lookup adds companies that aren't yet in the system" : undefined}
                            onClick={() => void loadPeople(c)}
                          >
                            {c.already_in_system ? "Unavailable" : "Select"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" className="bg-card"
                    disabled={viewPage === 0}
                    onClick={() => setViewPage((p) => Math.max(0, p - 1))}>Previous</Button>
                  <Button type="button" size="sm" variant="outline" className="bg-card"
                    disabled={viewStart + ROWS_PER_VIEW >= companies.length}
                    onClick={() => setViewPage((p) => p + 1)}>Next</Button>
                  <span className="self-center text-[10px] text-muted-foreground">free</span>
                </div>
                {canBuyMorePages && (
                  <Button type="button" size="sm" variant="outline" className="bg-card" disabled={busy}
                    onClick={() => { if (confirm("Fetch 100 more companies from Apollo? This costs 1 credit.")) void runSearch(apolloPage + 1); }}>
                    Search 100 more (1 credit)
                  </Button>
                )}
              </div>
              {!canBuyMorePages && companies.length < totalEntries && (
                <p className="text-[11px] text-muted-foreground">
                  Page limit reached for this search. Narrow it with a country, website or Advanced filter instead.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Step 3 — Select people ────────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">
              People at <strong>{selectedCompany?.name}</strong> · listing is free
            </p>
            <span className={cn("text-xs font-medium", atPickLimit && "text-primary")}>
              {picked.length} / {COMPANY_LOOKUP_MAX_CONTACTS} selected
            </span>
          </div>

          {contacts.length === 0 ? (
            <div className="rounded-lg border border-border bg-secondary/30 px-4 py-6 text-center">
              <Users className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No contactable people found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Apollo has this company but no people with an available email. The search credit was already spent.
              </p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
              {contacts.map((c) => {
                const blocked = c.already_imported || c.unenrichable;
                const on = picked.includes(c.apollo_id);
                return (
                  <label
                    key={c.apollo_id}
                    className={cn(
                      "flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0",
                      blocked ? "opacity-50" : "cursor-pointer hover:bg-secondary/30",
                    )}
                  >
                    {/* Native input — there is no shared Checkbox in this
                        codebase and one control does not justify adding one. */}
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-primary"
                      checked={on}
                      disabled={blocked || (!on && atPickLimit)}
                      onChange={() => togglePick(c.apollo_id)}
                    />
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="font-medium">
                        {c.first_name ?? "—"} {c.last_name_masked ?? ""}
                      </span>
                      <span className="ml-2 text-muted-foreground">{c.title ?? "—"}</span>
                    </span>
                    {c.already_imported && <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">already imported</span>}
                    {c.unenrichable && <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">no email available</span>}
                  </label>
                );
              })}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Surnames are partly hidden until the email is revealed. Revealing costs{" "}
            <strong>1 credit per contact</strong> — {picked.length} selected = <strong>{picked.length} credit{picked.length === 1 ? "" : "s"}</strong>.
          </p>
        </div>
      )}

      {/* ── Step 4 — Batch & assign ───────────────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-4">
          <BatchNameField
            value={batchName}
            onChange={(v) => { setBatchName(v); if (v.trim()) setBatchNameError(false); }}
            color={color}
            onColorChange={setColor}
            error={batchNameError}
          />
          <AssignStrategyPicker
            employees={employees}
            mode={assignMode}
            onModeChange={setAssignMode}
            assignTo={assignTo}
            onAssignToChange={setAssignTo}
          />
          <p className="text-[11px] text-amber-500">
            Importing {picked.length} contact{picked.length === 1 ? "" : "s"} will spend{" "}
            <strong>{picked.length} Apollo credit{picked.length === 1 ? "" : "s"}</strong> revealing their emails.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button type="button" variant="outline" className="bg-card" disabled={step === 0 || busy}
          onClick={() => { setError(""); setStep((s) => Math.max(0, s - 1)); }}>
          Back
        </Button>

        {step === 0 && (
          <Button type="button" disabled={busy || !name.trim()} className="gap-1.5" onClick={() => void runSearch(1)}>
            <Search className="size-3.5" />
            {busy ? "Searching…" : "Search companies (1 credit)"}
          </Button>
        )}
        {step === 2 && (
          <Button type="button" disabled={busy || picked.length === 0} onClick={() => setStep(3)}>
            Continue
          </Button>
        )}
        {step === 3 && (
          <Button type="button" disabled={busy || picked.length === 0} onClick={() => void submit()}>
            {busy ? "Importing…" : `Import ${picked.length} contact${picked.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>
    </div>
  );
}
