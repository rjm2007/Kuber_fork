"use client";

import { Fragment, useState, type ReactNode } from "react";
import { AlertCircle, Building2, CalendarIcon, ChevronDown, ChevronRight, Search, Users } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Stepper } from "@/components/ui/stepper";
import { InfoTip } from "@/components/ui/info-tip";
import { LocationsPicker } from "@/components/ui/locations-picker";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/leads/lead-ui";
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

const COMPANY_PAGE_SIZE_OPTIONS = [10, 20] as const;
const CONTACT_PAGE_SIZE_OPTIONS = [10, 20, 30] as const;
const DEFAULT_COMPANY_PAGE_SIZE = 20;
const DEFAULT_CONTACT_PAGE_SIZE = 10;

function LookupPaginationBar({
  label,
  id,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  page,
  totalItems,
  onPageChange,
  middle,
}: {
  label: string;
  id: string;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageSizeChange: (size: number) => void;
  page: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  middle?: ReactNode;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);

  return (
    <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
      <Field orientation="horizontal" className="w-fit">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            onPageSizeChange(Number(v));
            onPageChange(1);
          }}
        >
          <SelectTrigger className="h-8 w-20 text-xs bg-card" id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {pageSizeOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {middle}
      <div className="flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          Page {safePage} of {totalPages}
        </span>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={() => onPageChange(Math.max(1, safePage - 1))}
                disabled={safePage <= 1}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
                disabled={safePage >= totalPages}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}

/** Mirrors the company results table so loading does not jump once data arrives. */
function CompanyTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" aria-busy="true" aria-label="Loading companies">
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
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-7 rounded-md" />
                  <Skeleton className="h-3.5 w-36" />
                </div>
              </td>
              <td className="px-3 py-2.5"><Skeleton className="h-3.5 w-24" /></td>
              <td className="px-3 py-2.5"><Skeleton className="ml-auto h-3.5 w-10" /></td>
              <td className="px-3 py-2.5"><Skeleton className="h-3.5 w-28" /></td>
              <td className="w-10 px-2 py-2.5">
                <Skeleton className="ml-auto size-7 rounded-full" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mirrors the people checklist rows. */
function PeopleListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" aria-busy="true" aria-label="Loading people">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40 max-w-[55%]" />
          </div>
          <Skeleton className="size-4 shrink-0 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

interface Company {
  apollo_org_id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  blog_url: string | null;
  angellist_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  crunchbase_url: string | null;
  logo_url: string | null;
  employees: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
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

function companyWebsiteHref(c: Company): string | null {
  const raw = c.website?.trim() || c.domain?.trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function CompanyLogo({ src, name }: { src: string | null; name: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground" aria-hidden>
        <Building2 className="size-3.5" />
      </span>
    );
  }
  return (
    // Fixture logos are data-URIs; live Apollo search already returns logo_url
    // on the same page we paid for — no extra credit.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name ? `${name} logo` : ""}
      className="size-7 shrink-0 rounded-md bg-secondary object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function companyWebsiteLabel(c: Company): string | null {
  const raw = c.website?.trim() || c.domain?.trim();
  return raw || null;
}

function CompanyWebsiteLink({ company }: { company: Company }) {
  const href = companyWebsiteHref(company);
  const label = companyWebsiteLabel(company);
  if (!href || !label) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-60 truncate font-medium text-blue-500 hover:text-blue-600 hover:underline"
      title={label}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}

function companySocialItems(company: Company): { href: string; label: string }[] {
  return [
    { href: company.linkedin_url, label: "LinkedIn" },
    { href: company.twitter_url, label: "Twitter" },
    { href: company.facebook_url, label: "Facebook" },
    { href: company.crunchbase_url, label: "Crunchbase" },
    { href: company.blog_url, label: "Blog" },
    { href: company.angellist_url, label: "AngelList" },
  ].filter((l): l is { href: string; label: string } => typeof l.href === "string" && l.href.trim() !== "");
}

function CompanySocialLinks({ company }: { company: Company }) {
  const items = companySocialItems(company);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {items.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:border-primary/40 hover:text-primary"
          onClick={(e) => e.stopPropagation()}
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

function DetailFact({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs text-foreground">{value}</p>
    </div>
  );
}

function CompanyPreview({ company }: { company: Company }) {
  const location = [company.city, company.state, company.country].filter(Boolean).join(", ");
  const socials = companySocialItems(company);
  const hasFacts = !!(company.industry || company.founded_year || company.domain || location || socials.length);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <DetailFact label="Industry" value={company.industry} />
      <DetailFact label="Founded" value={company.founded_year} />
      <DetailFact label="Domain" value={company.domain} />
      <DetailFact label="Full location" value={location || null} />
      {socials.length > 0 && (
        <div className="min-w-0 sm:col-span-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Also on</p>
          <div className="mt-1">
            <CompanySocialLinks company={company} />
          </div>
        </div>
      )}
      {!hasFacts && (
        <p className="sm:col-span-2 lg:col-span-4 text-[11px] text-muted-foreground">
          No extra details from Apollo for this company.
        </p>
      )}
      {company.already_in_system && (
        <p className="sm:col-span-2 lg:col-span-4 text-[11px] text-muted-foreground">
          Already tracked — Company Lookup only adds companies that are not yet in the system.
        </p>
      )}
    </div>
  );
}

/** Apollo returns surnames obfuscated (e.g. "Sh***a"). Show "Kavish S." instead. */
function formatContactName(firstName: string | null, lastNameMasked: string | null): string {
  const first = firstName?.trim() || "—";
  const initial = lastNameMasked?.trim().match(/[A-Za-z]/)?.[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/** Every Organization Search filter beyond the three basic fields. Comma-separated
 *  text for list params keeps the panel to one control per filter — these are
 *  power-user inputs, not the common path. Location fields use the shared
 *  country picker. Tips follow Instantly SuperSearch help-center wording. */
const ADVANCED_GROUPS: {
  group: string;
  fields: {
    key: string;
    label: string;
    kind: "list" | "num" | "date" | "locations";
    placeholder?: string;
    tip: string;
  }[];
}[] = [
  {
    group: "Company profile",
    fields: [
      { key: "employeeRanges", label: "Employee ranges", kind: "list", placeholder: "10,200   200,1000", tip: "Filter leads by employees size." },
      { key: "keywordTags", label: "Industry keywords", kind: "list", placeholder: "plastics, packaging", tip: "Include or exclude certain industries or keywords." },
      { key: "revenueMin", label: "Revenue min", kind: "num", tip: "Filter leads by revenue." },
      { key: "revenueMax", label: "Revenue max", kind: "num", tip: "Filter leads by revenue." },
      { key: "technologyUids", label: "Technologies used", kind: "list", placeholder: "shopify, sap", tip: "Scan the technologies present on a website. Use it to target companies that use some of your competitor's services." },
    ],
  },
  {
    group: "Location",
    fields: [{ key: "notLocations", label: "Exclude locations", kind: "locations", placeholder: "Select countries to exclude…", tip: "Filter leads by location. Companies in the selected countries are excluded from the results." }],
  },
  {
    group: "Funding",
    fields: [
      { key: "latestFundingAmountMin", label: "Latest funding min", kind: "num", tip: "Funding status of the company. Filter by the size of the latest funding round." },
      { key: "latestFundingAmountMax", label: "Latest funding max", kind: "num", tip: "Funding status of the company. Filter by the size of the latest funding round." },
      { key: "totalFundingMin", label: "Total funding min", kind: "num", tip: "Funding status of the company. Filter by total funding raised." },
      { key: "totalFundingMax", label: "Total funding max", kind: "num", tip: "Funding status of the company. Filter by total funding raised." },
      { key: "latestFundingDateMin", label: "Latest funding after", kind: "date", tip: "Funding status of the company. Filter by when the latest round closed." },
      { key: "latestFundingDateMax", label: "Latest funding before", kind: "date", tip: "Funding status of the company. Filter by when the latest round closed." },
    ],
  },
  {
    group: "Hiring signals",
    fields: [
      { key: "jobTitles", label: "Hiring for titles", kind: "list", placeholder: "export manager", tip: "Search for companies looking to hire specific job roles." },
      { key: "jobLocations", label: "Job locations", kind: "locations", placeholder: "Select countries where they are hiring…", tip: "Filter leads by location. Only companies hiring in the selected countries are included." },
      { key: "numJobsMin", label: "Open jobs min", kind: "num", tip: "Search for companies looking to hire. Filter by how many open roles they have." },
      { key: "numJobsMax", label: "Open jobs max", kind: "num", tip: "Search for companies looking to hire. Filter by how many open roles they have." },
      { key: "jobPostedAtMin", label: "Job posted after", kind: "date", tip: "Search for companies looking to hire specific job roles. Filter by when the jobs were posted." },
      { key: "jobPostedAtMax", label: "Job posted before", kind: "date", tip: "Search for companies looking to hire specific job roles. Filter by when the jobs were posted." },
    ],
  },
];

const LIST_KEYS = new Set(
  ADVANCED_GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "list" || f.kind === "locations").map((f) => f.key)),
);
const NUM_KEYS = new Set(
  ADVANCED_GROUPS.flatMap((g) => g.fields.filter((f) => f.kind === "num").map((f) => f.key)),
);

function csvToList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parseYmd(value: string | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const date = parseYmd(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 w-full justify-start px-3 text-xs font-normal bg-background",
            !date && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="size-3.5 mr-2 shrink-0" />
          {date ? format(date, "MMM d, yyyy") : "Pick a date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            onChange(d ? format(d, "yyyy-MM-dd") : "");
            setOpen(false);
          }}
        />
        <div className="flex items-center justify-between border-t border-border bg-secondary/30 px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => { onChange(""); setOpen(false); }}
          >
            Clear
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => { onChange(format(new Date(), "yyyy-MM-dd")); setOpen(false); }}
          >
            Today
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

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

/**
 * Results are paid for, so they must outlive the component.
 *
 * The wizard lives inside a modal whose tabs unmount it, and a reload wipes
 * React state entirely — so "switch to Excel and back" or "refresh the page"
 * used to mean searching again, and every repeat search is another credit. On
 * 13 Aug 2026 that cost three credits for two distinct searches.
 *
 * sessionStorage is the right scope here: it survives reloads, tab switches
 * and modal close/reopen within the tab, and is discarded when the tab closes,
 * so nobody inherits a stale company list days later. It is per-browser, so it
 * does not stop a second user paying for the same query — a shared server-side
 * cache would, and is the upgrade if that ever shows up in the usage log.
 */
const CACHE_KEY = "kuber:company-lookup:v3";

type CachedState = {
  criteria: string;
  companies: Company[];
  apolloPage: number;
  totalEntries: number;
  creditsSpent: number;
  mock: boolean;
  step: number;
  selectedCompany: Company | null;
  contacts: Contact[];
  picked: string[];
  batchName: string;
};

function readCache(): CachedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedState) : null;
  } catch {
    return null;
  }
}

function writeCache(state: CachedState) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch {
    // Quota or private-mode failure is not worth breaking the flow over —
    // the worst case is the pre-existing behaviour.
  }
}

export function CompanyLookupForm({ onImport }: { onImport: (n: number) => void }) {
  const cached = readCache();
  const [step, setStep] = useState(cached?.step ?? 0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which list is mid-fetch — drives skeleton UI while mock delay / Apollo runs. */
  const [loadingList, setLoadingList] = useState<"companies" | "people" | null>(null);

  // Step 1 — search inputs
  const [name, setName] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [website, setWebsite] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advanced, setAdvanced] = useState<Record<string, string>>({});

  // Step 2 — companies
  const [companies, setCompanies] = useState<Company[]>(cached?.companies ?? []);
  const [apolloPage, setApolloPage] = useState(cached?.apolloPage ?? 0);
  const [companyPage, setCompanyPage] = useState(1);
  const [companyPageSize, setCompanyPageSize] = useState(DEFAULT_COMPANY_PAGE_SIZE);
  const [totalEntries, setTotalEntries] = useState(cached?.totalEntries ?? 0);
  const [creditsSpent, setCreditsSpent] = useState(cached?.creditsSpent ?? 0);
  // Set by the server when this workspace runs on fixtures instead of Apollo.
  const [mock, setMock] = useState(cached?.mock ?? false);
  const [selectedCompany, setSelectedCompany] = useState<Company | null>(cached?.selectedCompany ?? null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Step 3 — contacts
  const [contacts, setContacts] = useState<Contact[]>(cached?.contacts ?? []);
  const [contactPage, setContactPage] = useState(1);
  const [contactPageSize, setContactPageSize] = useState(DEFAULT_CONTACT_PAGE_SIZE);
  const [picked, setPicked] = useState<string[]>(cached?.picked ?? []);

  // Step 4 — batch
  const [batchName, setBatchName] = useState(cached?.batchName ?? "");
  const [color, setColor] = useState("violet");
  const [batchNameError, setBatchNameError] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [assignMode, setAssignMode] = useState<ImportAssignMode>("manual");
  const employees = useAssignableEmployees(true);

  const activeAdvanced = Object.entries(advanced).filter(([, v]) => v.trim() !== "");

  /** Identity of a search. Two searches with the same criteria return the same
   *  companies, so re-running one is a credit spent for nothing. */
  const criteria = JSON.stringify({
    name: name.trim().toLowerCase(),
    country: [...countries].map((c) => c.toLowerCase()).sort().join(","),
    website: website.trim().toLowerCase(),
    advanced: buildAdvanced(advanced) ?? null,
  });

  /** Persist whatever has been paid for, so a reload or a tab switch never
   *  forces the manager to buy the same page twice. */
  function persist(next: Partial<CachedState>) {
    writeCache({
      criteria,
      companies,
      apolloPage,
      totalEntries,
      creditsSpent,
      mock,
      step,
      selectedCompany,
      contacts,
      picked,
      batchName,
      ...next,
    });
  }

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

    // Already bought this exact search — show what we have instead of paying
    // for the same answer again. Only for page 1: asking for a further page is
    // always a deliberate, separately confirmed purchase.
    if (page === 1 && cached && cached.criteria === criteria && cached.companies.length > 0) {
      setCompanies(cached.companies);
      setApolloPage(cached.apolloPage);
      setTotalEntries(cached.totalEntries);
      setCreditsSpent(cached.creditsSpent);
      setMock(cached.mock);
      setCompanyPage(1);
      setError("");
      setPreviewId(null);
      setStep(1);
      return;
    }

    setError("");
    setBusy(true);
    setLoadingList("companies");
    // Jump to the results step immediately so the table skeleton is visible
    // during the mock delay / real Apollo round-trip — otherwise busy only
    // flips the search button label on the form the user just left.
    if (page === 1) {
      setCompanies([]);
      setCompanyPage(1);
      setSelectedCompany(null);
      setPreviewId(null);
      setContacts([]);
      setPicked([]);
      setStep(1);
    }
    try {
      const data = await call<{
        companies: Company[]; page: number; total_entries: number;
        total_pages: number; credits_spent: number; mock?: boolean;
      }>("/api/v1/leads/company-search", {
        name: name.trim(),
        country: countries.length ? countries : undefined,
        website: website.trim() || undefined,
        page,
        advanced: buildAdvanced(advanced),
      });

      const merged = page === 1 ? data.companies : [...companies, ...data.companies];
      const spent = creditsSpent + data.credits_spent;
      setMock(!!data.mock);
      setCompanies(merged);
      setApolloPage(data.page);
      setTotalEntries(data.total_entries);
      setCreditsSpent(spent);
      if (page === 1) { setCompanyPage(1); setSelectedCompany(null); }
      setStep(1);
      // Written the moment the credit is spent, not on unmount — a crash or a
      // hard reload between the two would otherwise lose what was paid for.
      persist({
        criteria, companies: merged, apolloPage: data.page,
        totalEntries: data.total_entries, creditsSpent: spent,
        mock: !!data.mock, step: 1,
        ...(page === 1 ? { selectedCompany: null, contacts: [], picked: [] } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
      if (page === 1) setStep(0);
    } finally {
      setBusy(false);
      setLoadingList(null);
    }
  }

  async function loadPeople(company: Company) {
    setError("");
    setBusy(true);
    setLoadingList("people");
    setSelectedCompany(company);
    setContacts([]);
    setContactPage(1);
    setPicked([]);
    setStep(2);
    try {
      const data = await call<{ contacts: Contact[] }>("/api/v1/leads/company-people", {
        apollo_org_id: company.apollo_org_id,
      });
      const nextBatch = !batchName.trim() && company.name ? company.name : batchName;
      setContacts(data.contacts);
      setBatchName(nextBatch);
      persist({ selectedCompany: company, contacts: data.contacts, picked: [], step: 2, batchName: nextBatch });
    } catch (e) {
      setError((e as Error).message);
      setSelectedCompany(null);
      setStep(1);
    } finally {
      setBusy(false);
      setLoadingList(null);
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
      // The cached company list is stale the moment an import lands: the
      // company we just took is now "already in system". Drop it so the next
      // lookup starts clean rather than showing a list that lies.
      if (typeof window !== "undefined") sessionStorage.removeItem(CACHE_KEY);
      onImport(data.inserted);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    const next = picked.includes(id)
      ? picked.filter((p) => p !== id)
      : picked.length >= COMPANY_LOOKUP_MAX_CONTACTS ? picked : [...picked, id];
    setPicked(next);
    persist({ picked: next });
  }

  const companyTotalPages = Math.max(1, Math.ceil(companies.length / companyPageSize));
  const safeCompanyPage = Math.min(companyPage, companyTotalPages);
  const companyStart = (safeCompanyPage - 1) * companyPageSize;
  const visibleCompanies = companies.slice(companyStart, companyStart + companyPageSize);

  const contactTotalPages = Math.max(1, Math.ceil(contacts.length / contactPageSize));
  const safeContactPage = Math.min(contactPage, contactTotalPages);
  const contactStart = (safeContactPage - 1) * contactPageSize;
  const visibleContacts = contacts.slice(contactStart, contactStart + contactPageSize);

  const canBuyMorePages = apolloPage < COMPANY_LOOKUP_MAX_PAGES && companies.length < totalEntries;
  const atPickLimit = picked.length >= COMPANY_LOOKUP_MAX_CONTACTS;

  return (
    <div className="space-y-5">
      <Stepper steps={STEPS} current={step} className="pb-4 mb-6 border-b border-border" />

      {mock && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          <strong>Test mode</strong> — this workspace runs Company Lookup against sample data. No Apollo
          credits are spent, and imported contacts carry placeholder emails rather than real ones.
        </div>
      )}

      {/* ── Step 1 — Find company ─────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label>Company name</Label>
              <InfoTip side="right" text="Include or exclude certain company names." />
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ABC Plastics"
              className="bg-card"
            />
          </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label>Website <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <InfoTip side="right" text="Use the Lookalike domain if you want the results to be similar to the domain you entered." />
              </div>
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="abcplastics.com" className="bg-card" />
            </div>
            <LocationsPicker
              label="Country"
              helpText="Filter leads by location. Select one or more countries to narrow results, or leave empty to search worldwide."
              placeholder="Any country"
              selected={countries}
              onChangeSelected={setCountries}
            />

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
                    className="rounded border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
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
                        f.kind === "locations" ? (
                          <div key={f.key} className="col-span-2">
                            <LocationsPicker
                              label={f.label}
                              helpText={f.tip}
                              placeholder={f.placeholder ?? "Select countries…"}
                              selected={csvToList(advanced[f.key])}
                              onChangeSelected={(v) => setAdvanced((a) => ({ ...a, [f.key]: v.join(", ") }))}
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
                              value={advanced[f.key] ?? ""}
                              onChange={(v) => setAdvanced((a) => ({ ...a, [f.key]: v }))}
                            />
                          </div>
                        ) : (
                          <div key={f.key} className="space-y-1">
                            <div className="flex items-center gap-0.5">
                              <Label className="text-[11px] font-normal text-muted-foreground">{f.label}</Label>
                              <InfoTip side="right" text={f.tip} />
                            </div>
                            <Input
                              value={advanced[f.key] ?? ""}
                              onChange={(e) => setAdvanced((a) => ({ ...a, [f.key]: e.target.value }))}
                              placeholder={f.placeholder}
                              type={f.kind === "num" ? "number" : "text"}
                              className="h-8 bg-background text-xs"
                            />
                          </div>
                        )
                      ))}
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">Separate multiple values with commas. Location filters use the country picker. Filters change which companies come back — they don&apos;t change the cost.</p>
              </div>
            )}
          </div>

          {cached && cached.criteria === criteria && cached.companies.length > 0 ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
              You already searched this — <strong>{cached.companies.length}</strong> companies are saved.
              Searching again reuses them and costs nothing.
            </p>
          ) : (
            <p className="text-[11px] text-amber-500">
              Searching costs <strong>1 Apollo credit</strong> per page of up to 100 companies. A search that matches nothing costs nothing.
            </p>
          )}
        </div>
      )}

      {/* ── Step 2 — Select company ───────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-3">
          {loadingList === "companies" ? (
            <>
              <Skeleton className="h-3 w-72 max-w-full" />
              <CompanyTableSkeleton rows={Math.min(companyPageSize, 8)} />
            </>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                Showing <strong>{visibleCompanies.length === 0 ? 0 : companyStart + 1}–{companyStart + visibleCompanies.length}</strong> of{" "}
                <strong>{companies.length}</strong> retrieved · <strong>{totalEntries.toLocaleString()}</strong> match in Apollo ·{" "}
                <strong>{creditsSpent}</strong> credit{creditsSpent === 1 ? "" : "s"} spent
                {" "}· click a row for details, the arrow to select
              </p>

              {companies.length === 0 ? (
                <div className="rounded-lg border border-border bg-secondary/30 px-4 py-6 text-center">
                  <Building2 className="mx-auto mb-2 size-5 text-muted-foreground" />
                  <p className="text-sm font-medium">No companies matched</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try a shorter name, clear countries, or adjust Advanced search. This search cost nothing.
                  </p>
                  <Button type="button" variant="outline" className="mt-3 bg-card" onClick={() => setStep(0)}>Refine search</Button>
                </div>
              ) : (
                <>
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
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
                        {visibleCompanies.map((c) => {
                          const unavailable = c.already_in_system || busy;
                          const open = previewId === c.apollo_org_id;
                          return (
                            <Fragment key={c.apollo_org_id}>
                            <tr
                              className={cn(
                                "border-t border-border transition-colors cursor-pointer",
                                open ? "bg-secondary/30" : "hover:bg-secondary/30",
                                c.already_in_system && "opacity-60",
                              )}
                              title={`View details for ${c.name ?? "company"}`}
                              aria-expanded={open}
                              onClick={() => setPreviewId(open ? null : c.apollo_org_id)}
                            >
                              <td className="px-3 py-2.5">
                                <div className="flex min-w-0 items-center gap-2">
                                  <CompanyLogo src={c.logo_url} name={c.name} />
                                  <span className="min-w-0">
                                    <span className="font-medium">{c.name ?? "—"}</span>
                                    {c.already_in_system && (
                                      <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        Already in system
                                      </span>
                                    )}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-muted-foreground">
                                {[c.city, c.country].filter(Boolean).join(", ") || "—"}
                              </td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                                {c.employees?.toLocaleString() ?? "—"}
                              </td>
                              <td className="px-3 py-2.5">
                                <CompanyWebsiteLink company={c} />
                              </td>
                              <td className="w-10 px-2 py-2.5 text-right">
                                <button
                                  type="button"
                                  disabled={unavailable}
                                  className={cn(
                                    "ml-auto flex size-7 items-center justify-center rounded-full",
                                    c.already_in_system
                                      ? "bg-secondary text-muted-foreground/40"
                                      : "bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground",
                                  )}
                                  title={c.already_in_system ? "Already in system" : `Select ${c.name ?? "company"}`}
                                  aria-label={c.already_in_system ? "Unavailable" : `Select ${c.name ?? "company"}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!unavailable) void loadPeople(c);
                                  }}
                                >
                                  <ChevronRight className="size-3.5" aria-hidden />
                                </button>
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-t border-border bg-secondary/30">
                                <td colSpan={5} className="px-3 py-3">
                                  <CompanyPreview company={c} />
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <LookupPaginationBar
                    id="company-lookup-per-page"
                    label="Companies per page"
                    pageSize={companyPageSize}
                    pageSizeOptions={COMPANY_PAGE_SIZE_OPTIONS}
                    onPageSizeChange={(size) => {
                      setCompanyPageSize(size);
                      setPreviewId(null);
                    }}
                    page={companyPage}
                    totalItems={companies.length}
                    onPageChange={(page) => {
                      setCompanyPage(page);
                      setPreviewId(null);
                    }}
                    middle={
                      canBuyMorePages ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          className="h-8 text-xs bg-card"
                          onClick={() => {
                            if (confirm("Fetch 100 more companies from Apollo? This costs 1 credit.")) {
                              void runSearch(apolloPage + 1);
                            }
                          }}
                        >
                          Search 100 more (1 credit)
                        </Button>
                      ) : undefined
                    }
                  />
                  {!canBuyMorePages && companies.length < totalEntries && (
                    <p className="text-[11px] text-muted-foreground">
                      Page limit reached for this search. Narrow it with a country, website or Advanced filter instead.
                    </p>
                  )}
                </>
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
            {loadingList === "people" ? (
              <Skeleton className="h-3.5 w-16" />
            ) : (
              <span className={cn("text-xs font-medium", atPickLimit && "text-primary")}>
                {picked.length} / {COMPANY_LOOKUP_MAX_CONTACTS} selected
              </span>
            )}
          </div>

          {loadingList === "people" ? (
            <PeopleListSkeleton rows={Math.min(contactPageSize, 8)} />
          ) : contacts.length === 0 ? (
            <div className="rounded-lg border border-border bg-secondary/30 px-4 py-6 text-center">
              <Users className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No contactable people found</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Apollo has this company but no people with an available email. The search credit was already spent.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {visibleContacts.map((c) => {
                  const blocked = c.already_imported || c.unenrichable;
                  const on = picked.includes(c.apollo_id);
                  const displayName = formatContactName(c.first_name, c.last_name_masked);
                  return (
                    <label
                      key={c.apollo_id}
                      className={cn(
                        "flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0",
                        blocked ? "opacity-50" : "cursor-pointer hover:bg-secondary/30",
                      )}
                    >
                      <Avatar name={displayName} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-snug truncate">
                          {displayName}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground truncate">
                          {c.title ?? "—"}
                        </span>
                      </span>
                      {c.already_imported && (
                        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          already imported
                        </span>
                      )}
                      {c.unenrichable && (
                        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          no email available
                        </span>
                      )}
                      {/* Native input — there is no shared Checkbox in this
                          codebase and one control does not justify adding one. */}
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-primary"
                        checked={on}
                        disabled={blocked || (!on && atPickLimit)}
                        onChange={() => togglePick(c.apollo_id)}
                      />
                    </label>
                  );
                })}
              </div>

              <LookupPaginationBar
                id="company-lookup-contacts-per-page"
                label="Leads per page"
                pageSize={contactPageSize}
                pageSizeOptions={CONTACT_PAGE_SIZE_OPTIONS}
                onPageSizeChange={setContactPageSize}
                page={contactPage}
                totalItems={contacts.length}
                onPageChange={setContactPage}
              />
            </>
          )}

          {loadingList !== "people" && (
            <p className="text-[11px] text-muted-foreground">
              Surnames show as an initial until the email is revealed.{" "}
              {mock ? (
                <>Test mode — revealing these costs nothing and produces placeholder emails.</>
              ) : (
                <>Revealing costs <strong>1 credit per contact</strong> — {picked.length} selected ={" "}
                <strong>{picked.length} credit{picked.length === 1 ? "" : "s"}</strong>.</>
              )}
            </p>
          )}
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
            {mock ? (
              <>Test mode — importing {picked.length} contact{picked.length === 1 ? "" : "s"} spends no credits and writes placeholder emails.</>
            ) : (
              <>Importing {picked.length} contact{picked.length === 1 ? "" : "s"} will spend{" "}
              <strong>{picked.length} Apollo credit{picked.length === 1 ? "" : "s"}</strong> revealing their emails.</>
            )}
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
