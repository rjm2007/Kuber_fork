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

/** Fixture result count — enough for UI pagination (20/page → 3 pages) without
 *  needing a second Apollo page. Kept under one paid page size on purpose. */
const MOCK_TOTAL_ENTRIES = 48;

/** Artificial latency so "Searching…" / busy UI is visible in demos. Real
 *  Apollo is slower than this; fixtures would otherwise flash instantly. */
export const MOCK_APOLLO_DELAY_MS = 900;

export function mockApolloDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, MOCK_APOLLO_DELAY_MS));
}

type Seed = {
  suffix: string;
  country: string;
  city: string;
  state: string | null;
  employees: number;
  tld: string;
  industry: string;
};

// Hand-written variety so a search for "ABC" reads like the real
// disambiguation problem: same stem, different country / size / industry.
// Length matches MOCK_TOTAL_ENTRIES so every row is unique (no numeric tiers).
const SEEDS: Seed[] = [
  { suffix: "Plastics Ltd",           country: "Kenya",        city: "Nairobi",     state: null,           employees: 120, tld: "co.ke",  industry: "plastics" },
  { suffix: "Industries",             country: "Kenya",        city: "Mombasa",     state: null,           employees: 80,  tld: "com",    industry: "packaging" },
  { suffix: "Plastic Group",          country: "Nigeria",      city: "Lagos",       state: null,           employees: 450, tld: "com",    industry: "plastics" },
  { suffix: "Polymers Pvt Ltd",       country: "India",        city: "Mumbai",      state: "Maharashtra",  employees: 210, tld: "in",     industry: "polymers" },
  { suffix: "Packaging Solutions",    country: "UAE",          city: "Dubai",       state: null,           employees: 65,  tld: "ae",     industry: "packaging" },
  { suffix: "Moulding Co",            country: "Vietnam",      city: "Hanoi",       state: null,           employees: 310, tld: "vn",     industry: "moulding" },
  { suffix: "Exports",                country: "Turkey",       city: "Istanbul",    state: null,           employees: 95,  tld: "com.tr", industry: "plastics" },
  { suffix: "Recycling",              country: "Egypt",        city: "Cairo",       state: null,           employees: 140, tld: "com.eg", industry: "recycling" },
  { suffix: "Films & Sheets",         country: "India",        city: "Pune",        state: "Maharashtra",  employees: 175, tld: "in",     industry: "films" },
  { suffix: "Compounding",            country: "Germany",      city: "Frankfurt",   state: null,           employees: 220, tld: "de",     industry: "compounding" },
  { suffix: "Bottles Ltd",            country: "South Africa", city: "Johannesburg", state: null,          employees: 90,  tld: "co.za",  industry: "packaging" },
  { suffix: "Injection Works",        country: "China",        city: "Shenzhen",    state: null,           employees: 580, tld: "cn",     industry: "moulding" },
  { suffix: "Resins Trading",         country: "Singapore",    city: "Singapore",   state: null,           employees: 45,  tld: "sg",     industry: "trading" },
  { suffix: "Pipe Systems",           country: "Kenya",        city: "Kisumu",      state: null,           employees: 110, tld: "co.ke",  industry: "pipes" },
  { suffix: "Flexible Packaging",     country: "India",        city: "Ahmedabad",   state: "Gujarat",      employees: 260, tld: "in",     industry: "packaging" },
  { suffix: "Masterbatch",            country: "Italy",        city: "Milan",       state: null,           employees: 130, tld: "it",     industry: "masterbatch" },
  { suffix: "Thermoforming",          country: "Poland",       city: "Warsaw",      state: null,           employees: 155, tld: "pl",     industry: "thermoforming" },
  { suffix: "Additives Co",           country: "USA",          city: "Houston",     state: "Texas",        employees: 340, tld: "com",    industry: "additives" },
  { suffix: "Blow Moulding",          country: "Mexico",       city: "Monterrey",   state: null,           employees: 200, tld: "mx",     industry: "moulding" },
  { suffix: "PVC Profiles",           country: "Turkey",       city: "Ankara",      state: null,           employees: 185, tld: "com.tr", industry: "pvc" },
  { suffix: "Engineering Plastics",   country: "Japan",        city: "Osaka",       state: null,           employees: 420, tld: "jp",     industry: "engineering" },
  { suffix: "Foam Products",          country: "Brazil",       city: "São Paulo",   state: null,           employees: 160, tld: "com.br", industry: "foam" },
  { suffix: "Cable Compounds",        country: "India",        city: "Chennai",     state: "Tamil Nadu",   employees: 145, tld: "in",     industry: "compounds" },
  { suffix: "Agricultural Films",     country: "Spain",        city: "Valencia",    state: null,           employees: 75,  tld: "es",     industry: "films" },
  { suffix: "Medical Polymers",       country: "Ireland",      city: "Dublin",      state: null,           employees: 95,  tld: "ie",     industry: "medical" },
  { suffix: "Consumer Packaging",     country: "UK",           city: "Manchester",  state: null,           employees: 210, tld: "co.uk",  industry: "packaging" },
  { suffix: "Rubber & Plastics",      country: "Thailand",     city: "Bangkok",     state: null,           employees: 290, tld: "co.th",  industry: "rubber" },
  { suffix: "Sheet Extrusion",        country: "Korea",        city: "Busan",       state: null,           employees: 180, tld: "kr",     industry: "extrusion" },
  { suffix: "Industrial Containers",  country: "Nigeria",      city: "Abuja",       state: null,           employees: 70,  tld: "ng",     industry: "containers" },
  { suffix: "Colour Concentrates",    country: "Netherlands",  city: "Rotterdam",   state: null,           employees: 115, tld: "nl",     industry: "concentrates" },
  { suffix: "PET Recycling",          country: "Egypt",        city: "Alexandria",  state: null,           employees: 125, tld: "com.eg", industry: "recycling" },
  { suffix: "Closure Systems",        country: "France",       city: "Lyon",        state: null,           employees: 150, tld: "fr",     industry: "closures" },
  { suffix: "Wire & Cable",           country: "India",        city: "Delhi",       state: "Delhi",        employees: 320, tld: "in",     industry: "cable" },
  { suffix: "Geosynthetics",          country: "Australia",    city: "Melbourne",   state: null,           employees: 85,  tld: "com.au", industry: "geosynthetics" },
  { suffix: "Automotive Plastics",    country: "Germany",      city: "Stuttgart",   state: null,           employees: 510, tld: "de",     industry: "automotive" },
  { suffix: "Food Grade Films",       country: "UAE",          city: "Abu Dhabi",   state: null,           employees: 55,  tld: "ae",     industry: "films" },
  { suffix: "Industrial Hoses",       country: "Kenya",        city: "Nakuru",      state: null,           employees: 60,  tld: "co.ke",  industry: "hoses" },
  { suffix: "Polymer Trading",        country: "Hong Kong",    city: "Hong Kong",   state: null,           employees: 40,  tld: "hk",     industry: "trading" },
  { suffix: "Technical Compounds",    country: "Sweden",       city: "Gothenburg",  state: null,           employees: 100, tld: "se",     industry: "compounds" },
  { suffix: "Stretch Wrap",           country: "Canada",       city: "Toronto",     state: "Ontario",      employees: 135, tld: "ca",     industry: "packaging" },
  { suffix: "Plastic Furniture",      country: "Vietnam",      city: "Ho Chi Minh", state: null,           employees: 240, tld: "vn",     industry: "furniture" },
  { suffix: "Insulation Boards",      country: "Poland",       city: "Kraków",      state: null,           employees: 105, tld: "pl",     industry: "insulation" },
  { suffix: "Labware Plastics",       country: "USA",          city: "Boston",      state: "Massachusetts", employees: 190, tld: "com",   industry: "labware" },
  { suffix: "Marine Polymers",        country: "Norway",       city: "Bergen",      state: null,           employees: 70,  tld: "no",     industry: "marine" },
  { suffix: "Building Materials",     country: "India",        city: "Hyderabad",   state: "Telangana",    employees: 280, tld: "in",     industry: "building" },
  { suffix: "Cosmetic Packaging",     country: "Italy",        city: "Turin",       state: null,           employees: 88,  tld: "it",     industry: "packaging" },
  { suffix: "Agri Irrigation",        country: "Israel",       city: "Tel Aviv",    state: null,           employees: 160, tld: "co.il",  industry: "irrigation" },
  { suffix: "Specialty Resins",       country: "Taiwan",       city: "Taipei",      state: null,           employees: 230, tld: "tw",     industry: "resins" },
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

/** Apollo returns logo_url as a hosted image. Fixtures use a data-URI so the
 *  table can render logos without hitting Apollo (or any other network). */
function mockLogoDataUri(name: string, seed: number): string {
  const initials = name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
  const hue = seed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue} 42% 38%)"/><text x="32" y="40" text-anchor="middle" fill="#fff" font-size="22" font-family="system-ui,sans-serif" font-weight="600">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

  // ~48 companies — enough for the 20-per-page UI paginator (3 pages) while
  // still fitting in one Apollo page, so demos don't need "Search 100 more".
  // Country narrows WHERE the companies are, not HOW MANY — a common-name
  // search in India still returns a full page of Indian matches. Filtering the
  // seed list alone used to collapse "India" to six rows and hide pagination.
  const totalEntries = MOCK_TOTAL_ENTRIES;
  const totalPages = Math.ceil(totalEntries / APOLLO_ORG_PER_PAGE);
  if (page > totalPages) {
    return { organizations: [], pagination: { page, per_page: APOLLO_ORG_PER_PAGE, total_entries: totalEntries, total_pages: totalPages } };
  }

  const startIndex = (page - 1) * APOLLO_ORG_PER_PAGE;
  const countThisPage = Math.min(APOLLO_ORG_PER_PAGE, totalEntries - startIndex);
  const filters = (opts.locations ?? []).map((l) => l.trim()).filter(Boolean);
  const filterLc = filters.map((f) => f.toLowerCase());
  const matchesCountry = (c: string) => filterLc.some((f) => c.toLowerCase().includes(f));
  const filterKey = filters.join(",");

  // Prefer seeds that already match a requested country so cities look real;
  // pad from the rest (relocated) so the page stays full for UI testing.
  const matchedSeeds = filters.length ? SEEDS.filter((s) => matchesCountry(s.country)) : SEEDS;
  const padSeeds = filters.length ? SEEDS.filter((s) => !matchesCountry(s.country)) : [];
  const geoTemplates = matchedSeeds.length > 0
    ? matchedSeeds
    : filters.map((f) => ({ country: f, city: f, state: null as string | null }));

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < countThisPage; i++) {
    const globalIndex = startIndex + i;
    let seed: Seed;
    let relocated = false;
    if (!filters.length) {
      seed = SEEDS[globalIndex % SEEDS.length];
    } else if (globalIndex < matchedSeeds.length) {
      seed = matchedSeeds[globalIndex];
    } else {
      seed = padSeeds[(globalIndex - matchedSeeds.length) % Math.max(1, padSeeds.length)] ?? SEEDS[globalIndex % SEEDS.length];
      relocated = true;
    }

    const tier = filters.length && globalIndex >= matchedSeeds.length
      ? Math.floor((globalIndex - matchedSeeds.length) / Math.max(1, padSeeds.length)) + 2
      : 0;
    const name = tier > 0 ? `${query} ${seed.suffix} ${tier}` : `${query} ${seed.suffix}`;
    const domain = `${slug(query)}${slug(seed.suffix)}${tier > 0 ? tier : ""}.${relocated ? "com" : seed.tld}`;
    const geo = relocated ? geoTemplates[globalIndex % geoTemplates.length] : seed;
    const country = geo.country;
    const city = geo.city;
    const state = geo.state;

    const h = hash(name);
    const handle = slug(name).slice(0, 18) || "company";
    rows.push({
      id: `mock_org_${hash(name + filterKey)}`,
      name,
      primary_domain: domain,
      // Field names match Apollo's Organization Search response
      // (docs.apollo.io/reference/organization-search).
      website_url: `https://www.${domain}`,
      blog_url: h % 5 === 0 ? `https://blog.${domain}` : null,
      angellist_url: h % 7 === 0 ? `https://angel.co/company/${handle}` : null,
      linkedin_url: `https://www.linkedin.com/company/${handle}`,
      twitter_url: `https://twitter.com/${handle}`,
      facebook_url: `https://facebook.com/${handle}`,
      crunchbase_url: `https://www.crunchbase.com/organization/${handle}`,
      logo_url: mockLogoDataUri(name, h),
      founded_year: 1985 + (h % 35),
      phone: null,
      estimated_num_employees: seed.employees + (h % 40),
      country,
      city,
      state,
      industry: seed.industry,
    });
  }

  return {
    organizations: rows.map(normalizeOrg),
    pagination: {
      page,
      per_page: APOLLO_ORG_PER_PAGE,
      total_entries: totalEntries,
      total_pages: totalPages,
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
  // 42–48 people — enough for the 30-per-page UI paginator (2 pages).
  const count = 42 + (seed % 7);

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
