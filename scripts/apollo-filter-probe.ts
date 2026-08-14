/**
 * Apollo filter probe — measures what our search filters actually cost us.
 *
 * Run: npx tsx scripts/apollo-filter-probe.ts
 *
 * SAFETY: this script can only ever call `mixed_people/api_search`, which
 * Apollo documents at **0 credits**. The endpoint is hard-coded and asserted
 * below; there is no code path here that can reach `mixed_companies/search`
 * (1 credit per page) or `people/bulk_match` (1 credit per person). Nothing is
 * written to the database.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  APOLLO_TITLES,
  APOLLO_SENIORITIES,
  EMPLOYEE_RANGES,
  CONTACT_EMAIL_STATUSES,
} from "../lib/constants";

const ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/api_search";
assert.ok(ENDPOINT.endsWith("/mixed_people/api_search"), "probe may only call the free people-search endpoint");

function loadKey(): string {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("APOLLO_API_KEY="));
  if (!line) throw new Error("APOLLO_API_KEY not found in .env.local");
  return line.slice("APOLLO_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const KEY = loadKey();

type Body = Record<string, unknown>;
type Person = {
  id: string;
  first_name?: string | null;
  last_name_obfuscated?: string | null;
  title?: string | null;
  has_email?: boolean;
  organization?: { name?: string | null } | null;
  country?: string | null;
  city?: string | null;
};
type Probe = { total: number; returned: number; withEmail: number; people: Person[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(body: Body): Promise<Probe> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      accept: "application/json",
      "x-api-key": KEY,
    },
    body: JSON.stringify({ per_page: 100, page: 1, ...body }),
  });
  if (!res.ok) {
    throw new Error(`Apollo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { total_entries?: number; people?: Person[] };
  const people = json.people ?? [];
  return {
    total: json.total_entries ?? 0,
    returned: people.length,
    withEmail: people.filter((p) => p.has_email).length,
    people,
  };
}

/** Exactly what production sends today (lib/services/apollo.ts searchPeople). */
function currentFilters(keyword: string, locations: string[]): Body {
  return {
    person_titles: APOLLO_TITLES,
    person_seniorities: APOLLO_SENIORITIES,
    q_keywords: keyword,
    organization_num_employees_ranges: EMPLOYEE_RANGES,
    contact_email_status: CONTACT_EMAIL_STATUSES,
    include_similar_titles: false,
    person_locations: locations,
  };
}

const WIDER_TITLES = [
  ...APOLLO_TITLES,
  "buyer", "purchasing manager", "head of purchasing", "sourcing manager",
  "supply chain manager", "materials manager", "category manager",
  "import manager", "export manager", "general manager", "operations manager",
  "head of procurement", "owner", "director", "ceo", "partner",
];

const WIDER_EMPLOYEES = ["1,10", "11,50", "51,200", "201,1000", "1001,10000"];

function fmt(n: number): string {
  return n.toLocaleString().padStart(9);
}

function sample(p: Probe, n = 5): string {
  return p.people.slice(0, n).map((x) =>
    `      · ${(x.title ?? "—").slice(0, 38).padEnd(38)} @ ${(x.organization?.name ?? "—").slice(0, 28).padEnd(28)} ${x.country ?? ""}`
  ).join("\n");
}

async function run(scenario: string, keyword: string, locations: string[]) {
  console.log(`\n${"=".repeat(90)}\nSCENARIO: ${scenario}   keyword="${keyword}"  locations=${JSON.stringify(locations)}\n${"=".repeat(90)}`);

  const tests: { label: string; body: Body }[] = [
    { label: "A  BROAD — keyword + person location only", body: { q_keywords: keyword, person_locations: locations } },
    { label: "B  CURRENT PRODUCTION (all 7 filters)", body: currentFilters(keyword, locations) },
    { label: "C  PROPOSED — wider titles + similar titles + wider sizes", body: {
        q_keywords: keyword,
        person_titles: WIDER_TITLES,
        person_seniorities: APOLLO_SENIORITIES,
        organization_num_employees_ranges: WIDER_EMPLOYEES,
        contact_email_status: CONTACT_EMAIL_STATUSES,
        include_similar_titles: true,
        person_locations: locations,
      } },

    // ── isolate each production filter, one at a time ──────────────────────
    { label: "B1 current, but include_similar_titles = TRUE", body: { ...currentFilters(keyword, locations), include_similar_titles: true } },
    { label: "B2 current, but NO employee-size filter", body: (() => { const b = currentFilters(keyword, locations); delete b.organization_num_employees_ranges; return b; })() },
    { label: "B3 current, but NO contact_email_status", body: (() => { const b = currentFilters(keyword, locations); delete b.contact_email_status; return b; })() },
    { label: "B4 current, but NO person_titles", body: (() => { const b = currentFilters(keyword, locations); delete b.person_titles; return b; })() },
    { label: "B5 current, but NO seniorities", body: (() => { const b = currentFilters(keyword, locations); delete b.person_seniorities; return b; })() },
    { label: "B6 current, but organization_locations instead of person_locations", body: (() => {
        const b = currentFilters(keyword, locations); delete b.person_locations;
        return { ...b, organization_locations: locations };
      })() },
    { label: "B7 current, but WIDER employee ranges", body: { ...currentFilters(keyword, locations), organization_num_employees_ranges: WIDER_EMPLOYEES } },
    { label: "B8 current, but WIDER titles only", body: { ...currentFilters(keyword, locations), person_titles: WIDER_TITLES } },
  ];

  for (const t of tests) {
    try {
      const r = await probe(t.body);
      console.log(`\n  ${t.label}\n    total_entries: ${fmt(r.total)}   page1: ${r.returned}   has_email: ${r.withEmail}`);
      if (r.people.length > 0) console.log(sample(r));
    } catch (e) {
      console.log(`\n  ${t.label}\n    FAILED: ${(e as Error).message}`);
    }
    await sleep(1200); // be polite to Apollo's rate limiter
  }
}

/** Is an arbitrary "min,max" honoured, or only Apollo's documented buckets? */
async function employeeRangeFormatTest(keyword: string, locations: string[]) {
  console.log(`\n${"=".repeat(90)}\nEMPLOYEE-RANGE FORMAT TEST — are "10,200"/"200,1000" actually honoured?\n${"=".repeat(90)}`);
  const base = { q_keywords: keyword, person_locations: locations };
  const variants: { label: string; ranges?: string[] }[] = [
    { label: "no size filter at all", ranges: undefined },
    { label: 'production values ["10,200","200,1000"]', ranges: EMPLOYEE_RANGES },
    { label: 'documented buckets ["11,20","21,50","51,100","101,200","201,500","501,1000"]', ranges: ["11,20", "21,50", "51,100", "101,200", "201,500", "501,1000"] },
    { label: 'nonsense range ["7,9"] (should be tiny if honoured)', ranges: ["7,9"] },
    { label: 'huge range ["1,100000"] (should ~= no filter if honoured)', ranges: ["1,100000"] },
  ];
  for (const v of variants) {
    try {
      const body: Body = { ...base };
      if (v.ranges) body.organization_num_employees_ranges = v.ranges;
      const r = await probe(body);
      console.log(`  ${fmt(r.total)}   ${v.label}`);
    } catch (e) {
      console.log(`  FAILED    ${v.label} — ${(e as Error).message}`);
    }
    await sleep(1200);
  }
}

async function main() {
  console.log("Apollo filter probe — FREE endpoint only (mixed_people/api_search, 0 credits).");
  console.log("No organization search, no bulk_match, no database writes.\n");

  // The client's two real 13 Aug scenarios.
  await run("Injection moulding, USA (returned 8 new leads)", "molding", ["United States"]);
  await run("Packaging, Africa (returned 28 new leads)", "packaging", ["Kenya", "Nigeria", "South Africa", "Egypt", "Ghana"]);

  await employeeRangeFormatTest("molding", ["United States"]);

  console.log("\nDone. 0 Apollo credits consumed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
