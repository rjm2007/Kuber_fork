import { fetchWithRetry, sleep } from "@/lib/http";
import { requireServiceSecret } from "@/lib/services/service-keys";
import {
  APOLLO_TITLES,
  APOLLO_SENIORITIES,
  CONTACT_EMAIL_STATUSES,
  EMPLOYEE_RANGES,
  LOCATION_MAP,
} from "@/lib/constants";

const BASE = "https://api.apollo.io/api/v1";

// Async because the key now resolves through Settings > Keys (DB first,
// .env.local as the fallback tier) instead of being read straight off
// process.env at module scope.
async function headers() {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    accept: "application/json",
    // "any": one shared Apollo account and credit pool across companies.
    "x-api-key": await requireServiceSecret("apollo", "Apollo", "any"),
  };
}

export interface ApolloSearchPerson {
  id: string;
  first_name: string | null;
  // Apollo masks the surname on SEARCH (e.g. "Do***e") — the real one only
  // arrives with the paid bulk_match. Company Lookup shows this so a person is
  // recognisable before anyone pays; the keyword import ignores it.
  last_name_obfuscated?: string | null;
  title: string | null;
  has_email: boolean;
  // Location comes back on search results too — stored at insert so
  // territory-based assignment can route the batch immediately (Phase 4).
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization: {
    id?: string;
    name: string | null;
  } | null;
}

export interface ApolloSearchResult {
  total_entries: number;
  people: ApolloSearchPerson[];
}

export interface ApolloPeopleAdvancedFilters {
  titles?: string[];
  includeSimilarTitles?: boolean;
  seniorities?: string[];
  organizationLocations?: string[];
  domains?: string[];
  employeeRanges?: string[];
  revenueMin?: number;
  revenueMax?: number;
  technologyAll?: string[];
  technologyAny?: string[];
  technologyNot?: string[];
  jobTitles?: string[];
  jobLocations?: string[];
  numJobsMin?: number;
  numJobsMax?: number;
  jobPostedAtMin?: string;
  jobPostedAtMax?: string;
}

function techUids(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  const out = values
    .map((s) => s.trim().toLowerCase().replace(/[.\s]+/g, "_"))
    .filter(Boolean);
  return out.length ? out : undefined;
}

function mapLocations(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  return values.map((l) => LOCATION_MAP[l] ?? l);
}

/** Apollo wants `"1,10"` pairs. A comma-split UI can flatten that to
 *  `["1","10","11","50"]` — re-pair any run of numbers so the filter still works. */
function employeeRanges(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  const paired = [...values.join(" ").matchAll(/(\d+)\s*,\s*(\d+)/g)].map(
    (m) => `${m[1]},${m[2]}`,
  );
  return paired.length ? paired : undefined;
}

export async function searchPeople(opts: {
  keyword?: string;
  locations?: string[];
  page: number;
  perPage?: number;
  titles?: string[];
  seniorities?: string[];
  advanced?: ApolloPeopleAdvancedFilters;
  /** Apollo organization ids. Passing these switches the call to ROSTER MODE:
   *  everyone at those companies, with none of the segment filters below.
   *
   *  The keyword import narrows hard on purpose — it is mining a whole industry
   *  and every extra person it returns is a person it might pay to reveal.
   *  Company Lookup is the opposite: the company is already chosen, the search
   *  is free, and a title filter here would silently hide the one contact the
   *  client actually wanted. `contact_email_status` is the only filter kept,
   *  because a person Apollo holds no email for cannot be actioned at all. */
  organizationIds?: string[];
}): Promise<ApolloSearchResult> {
  const rosterMode = (opts.organizationIds?.length ?? 0) > 0;
  const a = opts.advanced ?? {};

  const body: Record<string, unknown> = {
    contact_email_status: CONTACT_EMAIL_STATUSES,
    per_page: opts.perPage ?? 100,
    page: opts.page,
  };

  const setList = (key: string, value?: string[]) => {
    if (value && value.length > 0) body[key] = value;
  };
  const setRange = (key: string, min?: number | string, max?: number | string) => {
    const range: Record<string, number | string> = {};
    if (min !== undefined && min !== "") range.min = min;
    if (max !== undefined && max !== "") range.max = max;
    if (Object.keys(range).length > 0) body[key] = range;
  };

  if (rosterMode) {
    body.organization_ids = opts.organizationIds;
  } else {
    body.person_titles = a.titles?.length ? a.titles : (opts.titles ?? APOLLO_TITLES);
    // Measured inert as a default: removing person_seniorities changed the
    // result count by exactly 0 because person_titles already implies the
    // seniority. Still sent (costs nothing) unless Advanced overrides it.
    body.person_seniorities = a.seniorities?.length ? a.seniorities : (opts.seniorities ?? APOLLO_SENIORITIES);
    // The keyword describes the COMPANY we want ("blown film", "masterbatch"),
    // so it belongs on the company's keyword tags, not q_keywords.
    //
    // q_keywords matches free text on the PERSON, so it only hit someone whose
    // own profile happened to contain "stretch film" — which is almost nobody.
    // Measured live against the free people-search endpoint on 19 Aug 2026,
    // same titles, same email statuses, Latin America, the client's own
    // keyword list from the Apollo requirements doc:
    //
    //   film extrusion   q_keywords 0    org tags  92
    //   plastic film     q_keywords 0    org tags  90
    //   stretch film     q_keywords 6    org tags 155
    //   ... 10 keywords  q_keywords 8    org tags 388
    //
    // That 8 is not a coincidence: it is exactly the "asked for 25, received 8"
    // the client reported on 13 Aug, and it survived the 14 Aug widening of
    // titles and employee ranges because neither was ever the bottleneck.
    //
    // Checked for regression across all 22 terms in INDUSTRY_KEYWORD_CATEGORIES
    // before switching: org tags returned more on 12 of 12 sampled, fewer on
    // none. The catalog's short `query` values were tuned for q_keywords and
    // work at least as well here, so no catalog change is needed.
    if (opts.keyword) body.q_organization_keyword_tags = [opts.keyword];
    body.organization_num_employees_ranges = employeeRanges(a.employeeRanges) ?? EMPLOYEE_RANGES;
    body.include_similar_titles = a.includeSimilarTitles ?? true;
    setList("organization_locations", mapLocations(a.organizationLocations));
    setList("q_organization_domains_list", a.domains);
    setList("currently_using_all_of_technology_uids", techUids(a.technologyAll));
    setList("currently_using_any_of_technology_uids", techUids(a.technologyAny));
    setList("currently_not_using_any_of_technology_uids", techUids(a.technologyNot));
    setList("q_organization_job_titles", a.jobTitles);
    setList("organization_job_locations", mapLocations(a.jobLocations));
    setRange("revenue_range", a.revenueMin, a.revenueMax);
    setRange("organization_num_jobs_range", a.numJobsMin, a.numJobsMax);
    setRange("organization_job_posted_at_range", a.jobPostedAtMin, a.jobPostedAtMax);
  }

  if ((opts.locations?.length ?? 0) > 0) {
    body.person_locations = opts.locations;
  }

  const res = await fetchWithRetry(
    "apollo",
    `${BASE}/mixed_people/api_search`,
    { method: "POST", headers: await headers(), body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Apollo search ${res.status}: ${text}`), {
      status: res.status,
    });
  }

  return res.json();
}

// ── Organization search (Company Lookup) ────────────────────────────────────
// Unlike people search, this endpoint COSTS 1 credit per page — charged per
// page requested, not per result returned, so always ask for the biggest page
// we are allowed.
//
// A page matching nothing is free. That was an assumption until 18 Aug 2026,
// when it was measured against the live account: balance 3959 before and 3959
// after a zero-match page (scripts/apollo-zero-result-credit-probe.ts). It is
// load-bearing — the wizard tells the client an empty search cost nothing, and
// the route writes no paid ledger row for one — so if this endpoint's billing
// ever changes, re-run that probe rather than trusting this comment.

export interface ApolloPagination {
  page: number;
  per_page: number;
  total_entries: number;
  total_pages: number;
}

export interface ApolloOrganization {
  id: string;
  name: string | null;
  primary_domain: string | null;
  website_url: string | null;
  blog_url: string | null;
  angellist_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  crunchbase_url: string | null;
  logo_url: string | null;
  founded_year: number | null;
  phone: string | null;
  // ALWAYS NULL from mixed_companies/search. Apollo's Organization Search
  // response does not carry these five fields at all — verified against the
  // published schema on 18 Aug 2026, after a client demo showed a dash in the
  // Location and Staff column of all 100 results. Nothing on our side strips
  // them; the endpoint never sends them.
  //
  // They are reachable three ways, none of them cheap enough to use at search
  // time: organizations/enrich (1 credit PER company, so 100 per page),
  // people/bulk_match (already paid for at import — this is how the values land
  // on the organization row today, see enrich-leads.ts), or the free people
  // search, which returns only has_city / has_employee_count BOOLEANS and not
  // the values themselves.
  //
  // Kept on the type because the mock provider and company-import both carry
  // them, and because a future enrich step would populate exactly these. Do not
  // render them off a search result — that is the bug this comment replaces.
  estimated_num_employees: number | null;
  country: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  /** Full Apollo row, kept for persistence — not sent to the browser. */
  raw: Record<string, unknown>;
}

export interface ApolloOrgSearchResult {
  organizations: ApolloOrganization[];
  pagination: ApolloPagination;
}

/** Every Organization Search filter beyond the three basic fields. All are
 *  documented on the endpoint; the UI surfaces them under Advanced Search. */
export interface ApolloOrgAdvancedFilters {
  employeeRanges?: string[];
  keywordTags?: string[];
  revenueMin?: number;
  revenueMax?: number;
  technologyUids?: string[];
  notLocations?: string[];
  latestFundingAmountMin?: number;
  latestFundingAmountMax?: number;
  totalFundingMin?: number;
  totalFundingMax?: number;
  latestFundingDateMin?: string;
  latestFundingDateMax?: string;
  jobTitles?: string[];
  jobLocations?: string[];
  numJobsMin?: number;
  numJobsMax?: number;
  jobPostedAtMin?: string;
  jobPostedAtMax?: string;
}

type RawOrg = Record<string, unknown>;

function firstString(row: RawOrg, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function firstNumber(row: RawOrg, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Exported so the mock provider can build raw Apollo-shaped rows and run them
 *  through this exact parser rather than bypassing it.
 *
 *  Note what that does and does not prove: running fixtures through the real
 *  parser catches a renamed key, but it cannot catch a field Apollo never sends,
 *  because the fixtures decide what is there. Until 18 Aug 2026 the mock filled
 *  city/country/employees on every row and the self-check asserted they
 *  survived — a green test over a field the live endpoint omits entirely. The
 *  fixtures now mirror the documented response, absences included. */
export function normalizeOrg(row: RawOrg): ApolloOrganization {
  return {
    id: String(row.id ?? ""),
    name: firstString(row, ["name"]),
    primary_domain: firstString(row, ["primary_domain", "domain"]),
    website_url: firstString(row, ["website_url", "website"]),
    blog_url: firstString(row, ["blog_url"]),
    angellist_url: firstString(row, ["angellist_url"]),
    linkedin_url: firstString(row, ["linkedin_url"]),
    twitter_url: firstString(row, ["twitter_url"]),
    facebook_url: firstString(row, ["facebook_url"]),
    crunchbase_url: firstString(row, ["crunchbase_url"]),
    logo_url: firstString(row, ["logo_url"]),
    founded_year: firstNumber(row, ["founded_year"]),
    phone: firstString(row, ["phone", "primary_phone", "sanitized_phone"]),
    estimated_num_employees: firstNumber(row, ["estimated_num_employees", "employee_count", "num_employees"]),
    country: firstString(row, ["country", "organization_country"]),
    city: firstString(row, ["city", "organization_city"]),
    state: firstString(row, ["state", "organization_state"]),
    industry: firstString(row, ["industry"]),
    raw: row,
  };
}

/** Apollo's own page ceiling. Asking for less does NOT cost less — the credit
 *  is charged per page — so the request always uses the maximum. */
export const APOLLO_ORG_PER_PAGE = 100;

export async function searchOrganizations(opts: {
  name: string;
  locations?: string[];
  domains?: string[];
  page?: number;
  advanced?: ApolloOrgAdvancedFilters;
}): Promise<ApolloOrgSearchResult> {
  const a = opts.advanced ?? {};
  const body: Record<string, unknown> = {
    q_organization_name: opts.name,
    page: opts.page ?? 1,
    per_page: APOLLO_ORG_PER_PAGE,
  };

  const setList = (key: string, value?: string[]) => {
    if (value && value.length > 0) body[key] = value;
  };
  const setRange = (key: string, min?: number | string, max?: number | string) => {
    const range: Record<string, number | string> = {};
    if (min !== undefined && min !== "") range.min = min;
    if (max !== undefined && max !== "") range.max = max;
    if (Object.keys(range).length > 0) body[key] = range;
  };

  setList("organization_locations", opts.locations);
  setList("q_organization_domains_list", opts.domains);
  setList("organization_num_employees_ranges", a.employeeRanges);
  setList("q_organization_keyword_tags", a.keywordTags);
  setList("currently_using_any_of_technology_uids", a.technologyUids);
  setList("organization_not_locations", a.notLocations);
  setList("q_organization_job_titles", a.jobTitles);
  setList("organization_job_locations", a.jobLocations);
  setRange("revenue_range", a.revenueMin, a.revenueMax);
  setRange("latest_funding_amount_range", a.latestFundingAmountMin, a.latestFundingAmountMax);
  setRange("total_funding_range", a.totalFundingMin, a.totalFundingMax);
  setRange("latest_funding_date_range", a.latestFundingDateMin, a.latestFundingDateMax);
  setRange("organization_num_jobs_range", a.numJobsMin, a.numJobsMax);
  setRange("organization_job_posted_at_range", a.jobPostedAtMin, a.jobPostedAtMax);

  const res = await fetchWithRetry(
    "apollo",
    `${BASE}/mixed_companies/search`,
    { method: "POST", headers: await headers(), body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Apollo org search ${res.status}: ${text.slice(0, 300)}`), {
      status: res.status,
    });
  }

  const raw = await res.json() as { organizations?: RawOrg[]; pagination?: Partial<ApolloPagination> };
  const organizations = (raw.organizations ?? []).map(normalizeOrg).filter((o) => o.id !== "");

  return {
    organizations,
    pagination: {
      page: raw.pagination?.page ?? opts.page ?? 1,
      per_page: raw.pagination?.per_page ?? APOLLO_ORG_PER_PAGE,
      total_entries: raw.pagination?.total_entries ?? organizations.length,
      total_pages: raw.pagination?.total_pages ?? 1,
    },
  };
}

export interface ApolloBulkMatchPerson {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_status: string | null;
  headline: string | null;
  linkedin_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  time_zone: string | null;
  email_domain_catchall: boolean | null;
  seniority: string | null;
  departments: string[] | null;
  is_likely_to_engage: boolean | null;
  organization_id: string | null;
  organization: {
    id: string | null;
    name: string | null;
    primary_domain: string | null;
    website_url: string | null;
    industry: string | null;
    keywords: string[] | null;
    estimated_num_employees: number | null;
    city: string | null;
    country: string | null;
  } | null;
}

export interface ApolloBulkMatchResult {
  status: string;
  unique_enriched_records: number;
  missing_records: number;
  credits_consumed: number;
  matches: ApolloBulkMatchPerson[];
}

export async function bulkMatch(
  details: Array<{ id: string; first_name?: string | null; organization_name?: string | null }>
): Promise<ApolloBulkMatchResult> {
  const res = await fetchWithRetry(
    "apollo",
    `${BASE}/people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false`,
    {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify({
        details: details.map((d) => ({
          id: d.id,
          ...(d.first_name ? { first_name: d.first_name } : {}),
          ...(d.organization_name ? { organization_name: d.organization_name } : {}),
        })),
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Apollo bulk_match ${res.status}: ${text}`), {
      status: res.status,
    });
  }

  return res.json();
}

// Per-endpoint rate limit snapshot as Apollo returns it — one entry per
// ["resource", "action"] pair, e.g. ["people", "bulk_match"]. Keyed by a
// JSON-stringified array in the raw response (see parseApiUsageStats).
export interface ApolloEndpointUsage {
  resource: string;
  action: string;
  day: { limit: number; consumed: number; left_over: number };
  hour: { limit: number; consumed: number; left_over: number };
  minute: { limit: number; consumed: number; left_over: number };
}

type RawUsageWindow = { limit: number; consumed: number; left_over: number };
type RawUsageStats = Record<string, { day: RawUsageWindow; hour: RawUsageWindow; minute: RawUsageWindow }>;

function parseApiUsageStats(raw: RawUsageStats): ApolloEndpointUsage[] {
  const out: ApolloEndpointUsage[] = [];
  for (const [key, windows] of Object.entries(raw)) {
    let resource = key;
    let action = "";
    try {
      const parsed = JSON.parse(key) as [string, string];
      resource = parsed[0]?.replace(/^api\/v1\//, "") ?? key;
      action = parsed[1] ?? "";
    } catch { /* leave resource as the raw key */ }
    out.push({ resource, action, ...windows });
  }
  return out;
}

/** Apollo's rate-limit/usage endpoint — a per-endpoint call-rate snapshot,
 *  separate from the account's actual credit balance (see getCreditUsageStats
 *  for that). Requires a Master API key; a scoped key 403s, which is
 *  surfaced as a normal error for the UI to show rather than throw on. */
export async function getApiUsageStats(): Promise<ApolloEndpointUsage[]> {
  const res = await fetch(`${BASE}/usage_stats/api_usage_stats`, {
    method: "POST",
    headers: await headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Apollo usage_stats ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  }
  const raw = await res.json() as RawUsageStats;
  return parseApiUsageStats(raw);
}

// The real team credit balance for the current billing cycle — same numbers
// shown on Apollo's own Settings > Usage page. `lead_credit` is the shared
// pool Apollo calls "Team credit usage" (spent on exports + email/phone
// reveals); the rest are separate per-feature allowances.
export interface ApolloCreditWindow {
  limit: number;
  consumed: number;
  left_over: number;
}

export interface ApolloCreditUsageStats {
  lead_credit: ApolloCreditWindow;
  direct_dial_credit: ApolloCreditWindow;
  export_credit: ApolloCreditWindow;
  conversation_credit: ApolloCreditWindow;
  ai_credit: ApolloCreditWindow;
  power_up_credit: ApolloCreditWindow;
  inbound_website_visitor_credit: ApolloCreditWindow;
  dialer: ApolloCreditWindow;
  web_search_record_credit: ApolloCreditWindow;
  contact_website_visitor_credit: ApolloCreditWindow;
}

export interface ApolloCreditCycle {
  start_date: string;
  end_date: string;
}

export interface ApolloCreditUsageResponse {
  credit_usage_stats: ApolloCreditUsageStats;
  current_credit_cycle: ApolloCreditCycle;
}

/** Requires a Master API key, same as getApiUsageStats. */
export async function getCreditUsageStats(): Promise<ApolloCreditUsageResponse> {
  const res = await fetch(`${BASE}/usage_stats/credit_usage_stats`, {
    method: "POST",
    headers: await headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Apollo credit_usage_stats ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  }
  return res.json();
}

/** Chunk an array and run bulk_match with 500ms sleep between chunks */
export async function bulkMatchChunked(
  details: Array<{ id: string; first_name?: string | null; organization_name?: string | null }>,
  chunkSize = 10
): Promise<{ results: ApolloBulkMatchResult[]; totalCredits: number }> {
  const results: ApolloBulkMatchResult[] = [];
  let totalCredits = 0;

  for (let i = 0; i < details.length; i += chunkSize) {
    const chunk = details.slice(i, i + chunkSize);
    const result = await bulkMatch(chunk);
    results.push(result);
    totalCredits += result.credits_consumed ?? 0;
    if (i + chunkSize < details.length) await sleep(500);
  }

  return { results, totalCredits };
}
