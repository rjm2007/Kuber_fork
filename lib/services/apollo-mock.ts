import {
  normalizeOrg,
  APOLLO_ORG_PER_PAGE,
  type ApolloOrgSearchResult,
  type ApolloSearchResult,
  type ApolloSearchPerson,
} from "@/lib/services/apollo";
import { DEV_COMPANY_ID } from "@/lib/constants";

/**
 * Mock Apollo provider for Company Lookup.
 *
 * Why this exists: every real Organization Search costs the client a credit, so
 * the flow cannot be exercised end to end on the live account without spending
 * their money. The internal/dev workspace therefore runs against fixtures
 * instead of Apollo.
 *
 * Fixtures are used when EITHER the run is non-production (any localhost or
 * preview build) OR the caller is the internal workspace. Both halves matter:
 * the tenant check alone assumed developers log in as the dev company, which
 * is not how the app is actually exercised — on 13 Aug 2026 three real credits
 * were spent discovering that a tester signed in as the live tenant sails
 * straight past it. NODE_ENV is only 'production' on the deployed build, so
 * neither branch can silently disable live Apollo for the client.
 *
 * Shapes here mirror Apollo's documented responses: organization search returns
 * an `organizations` array plus a `pagination` object carrying page, per_page,
 * total_entries and total_pages; people search returns `people` with an
 * obfuscated surname and a has_email flag but no address. Raw rows are pushed
 * through the real normalizeOrg() so the mock exercises our own parser rather
 * than pretending it is already correct.
 */
export function isApolloMockCompany(companyId: string | null | undefined): boolean {
  // Escape hatch for deliberately verifying the real integration from a dev
  // machine. Opt-in only, and it cannot weaken production: there the tenant
  // check below is the only thing that matters.
  if (process.env.APOLLO_FORCE_LIVE === "1") return false;

  // ANY non-production run — localhost included — uses fixtures. This is the
  // rule that actually protects the client: gating on the dev TENANT alone
  // assumed developers log in as the dev company, and on 13 Aug 2026 three real
  // credits were spent proving that assumption wrong. NODE_ENV is 'production'
  // only on the deployed build, so this can never silently disable live Apollo
  // for the client.
  if (process.env.NODE_ENV !== "production") return true;

  // Vercel PREVIEW builds also run with NODE_ENV=production, so the check above
  // does not cover them — a branch deploy signed into as the live tenant would
  // spend real credits, which is the same trap that cost three of them on
  // 13 Aug 2026. VERCEL_ENV separates a preview from the real deployment, and
  // is unset off Vercel, where the tenant check below still applies.
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production") return true;

  // Genuine production: only the internal workspace runs on fixtures.
  return companyId === DEV_COMPANY_ID;
}

/** Query containing this returns zero companies, so the empty state and the
 *  "no results costs nothing" path are demonstrable on demand. */
const NO_MATCH_TOKEN = "zzz";

type Seed = {
  suffix: string;
  country: string;
  city: string;
  state: string | null;
  employees: number;
  tld: string;
  industry: string;
};

// The first few are hand-written so a search for "ABC" reads like the real
// disambiguation problem: same name, different country, different size.
const SEEDS: Seed[] = [
  { suffix: "Plastics Ltd",        country: "Kenya",   city: "Nairobi",  state: null,        employees: 120, tld: "co.ke", industry: "plastics" },
  { suffix: "Industries",          country: "Kenya",   city: "Mombasa",  state: null,        employees: 80,  tld: "com",   industry: "packaging" },
  { suffix: "Plastic Group",       country: "Nigeria", city: "Lagos",    state: null,        employees: 450, tld: "com",   industry: "plastics" },
  { suffix: "Polymers Pvt Ltd",    country: "India",   city: "Mumbai",   state: "Maharashtra", employees: 210, tld: "in",  industry: "polymers" },
  { suffix: "Packaging Solutions", country: "UAE",     city: "Dubai",    state: null,        employees: 65,  tld: "ae",    industry: "packaging" },
  { suffix: "Moulding Co",         country: "Vietnam", city: "Hanoi",    state: null,        employees: 310, tld: "vn",    industry: "moulding" },
  { suffix: "Exports",             country: "Turkey",  city: "Istanbul", state: null,        employees: 95,  tld: "com.tr", industry: "plastics" },
  { suffix: "Recycling",           country: "Egypt",   city: "Cairo",    state: null,        employees: 140, tld: "com.eg", industry: "recycling" },
];

/** Deterministic, so the same search always returns the same companies and a
 *  demo can be repeated (and screenshots stay stable). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function mockSearchOrganizations(opts: {
  name: string;
  locations?: string[];
  page?: number;
}): ApolloOrgSearchResult {
  const query = opts.name.trim();
  const page = opts.page ?? 1;

  if (query.toLowerCase().includes(NO_MATCH_TOKEN)) {
    return { organizations: [], pagination: { page, per_page: APOLLO_ORG_PER_PAGE, total_entries: 0, total_pages: 0 } };
  }

  // A realistic "common name" result count: more than one page, so the paging
  // controls and the three-page cap are both reachable in a demo.
  const totalEntries = 137;
  const totalPages = Math.ceil(totalEntries / APOLLO_ORG_PER_PAGE);
  if (page > totalPages) {
    return { organizations: [], pagination: { page, per_page: APOLLO_ORG_PER_PAGE, total_entries: totalEntries, total_pages: totalPages } };
  }

  const startIndex = (page - 1) * APOLLO_ORG_PER_PAGE;
  const countThisPage = Math.min(APOLLO_ORG_PER_PAGE, totalEntries - startIndex);
  const countryFilter = opts.locations?.[0]?.toLowerCase();

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < countThisPage; i++) {
    const globalIndex = startIndex + i;
    const seed = SEEDS[globalIndex % SEEDS.length];
    // Later pages get a numeric suffix so every row is visibly distinct rather
    // than the same eight names repeating.
    const tier = Math.floor(globalIndex / SEEDS.length);
    const name = tier === 0 ? `${query} ${seed.suffix}` : `${query} ${seed.suffix} ${tier + 1}`;
    const domain = `${slug(query)}${slug(seed.suffix)}${tier === 0 ? "" : tier + 1}.${seed.tld}`;

    rows.push({
      id: `mock_org_${hash(name)}`,
      name,
      primary_domain: domain,
      website_url: `https://www.${domain}`,
      linkedin_url: `https://www.linkedin.com/company/${slug(name)}`,
      logo_url: null,
      founded_year: 1985 + (hash(name) % 35),
      phone: null,
      estimated_num_employees: seed.employees + (hash(name) % 40),
      country: seed.country,
      city: seed.city,
      state: seed.state,
      industry: seed.industry,
    });
  }

  // Apollo applies organization_locations server-side; mirror that so the
  // country field on step 1 visibly changes the result set.
  const filtered = countryFilter
    ? rows.filter((r) => String(r.country ?? "").toLowerCase().includes(countryFilter))
    : rows;

  return {
    organizations: filtered.map(normalizeOrg),
    pagination: {
      page,
      per_page: APOLLO_ORG_PER_PAGE,
      total_entries: countryFilter ? filtered.length : totalEntries,
      total_pages: countryFilter ? 1 : totalPages,
    },
  };
}

const FIRST_NAMES = ["Rahul", "Amit", "John", "Priya", "Samuel", "Grace", "David", "Neha", "Joseph", "Fatima", "Daniel", "Anita"];
const SURNAMES = ["Sharma", "Otieno", "Mwangi", "Patel", "Okafor", "Ahmed", "Kimani", "Verma", "Adeyemi", "Nair", "Hassan", "Gupta"];

// Spread across the ranking spectrum on purpose: a demo should visibly show
// senior/commercial titles sorting above junior ones.
const TITLES = [
  "Managing Director",
  "Chief Executive Officer",
  "Export Manager",
  "Procurement Manager",
  "Head of Purchasing",
  "Director of Operations",
  "Sales Executive",
  "Production Supervisor",
  "Warehouse Assistant",
  "Accounts Executive",
  "Business Development Manager",
  "Plant Manager",
];

/** Apollo masks the surname on search — "Sharma" comes back as "Sh***a" — and
 *  the real one only arrives with the paid reveal. Reproduced so the UI is
 *  built against what Apollo actually returns. */
function obfuscate(surname: string): string {
  if (surname.length <= 2) return surname;
  return `${surname[0]}${"*".repeat(Math.max(1, surname.length - 2))}${surname[surname.length - 1]}`;
}

export function mockSearchPeople(opts: {
  organizationIds: string[];
  orgName?: string | null;
}): ApolloSearchResult {
  const orgId = opts.organizationIds[0] ?? "mock_org";
  const seed = hash(orgId);
  // 6–12 people, deterministic per organization.
  const count = 6 + (seed % 7);

  const people: ApolloSearchPerson[] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST_NAMES[(seed + i * 7) % FIRST_NAMES.length];
    const surname = SURNAMES[(seed + i * 11) % SURNAMES.length];
    const title = TITLES[(seed + i * 5) % TITLES.length];
    people.push({
      id: `mock_person_${hash(`${orgId}_${i}`)}`,
      first_name: first,
      last_name_obfuscated: obfuscate(surname),
      title,
      // Apollo's contact_email_status filter means only contactable people come
      // back, so every mock person carries an available email.
      has_email: true,
      city: null,
      state: null,
      country: null,
      organization: { id: orgId, name: opts.orgName ?? null },
    });
  }

  return { total_entries: people.length, people };
}

/** The address the mock "reveal" would have returned. Written directly at
 *  import time so a mock lead never sits in the has_email=true / email=null
 *  state — that state is the instruction to spend a real credit, and the
 *  background watchdog does not know or care that the lead came from a mock. */
export function mockRevealedEmail(firstName: string | null, domain: string | null): string {
  const local = slug(firstName ?? "contact") || "contact";
  return `${local}@${domain ?? "example.com"}`;
}
