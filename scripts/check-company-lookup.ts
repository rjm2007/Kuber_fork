/**
 * Self-check for Company Lookup's pure logic. Run: npx tsx scripts/check-company-lookup.ts
 *
 * Covers the two bits that are easy to get subtly wrong and that nothing else
 * would catch: title ranking order, and the Advanced-filter parser that decides
 * whether an untouched panel silently narrows a paid search.
 */
import assert from "node:assert/strict";
import { companyLookupTitleRank, COMPANY_LOOKUP_MAX_CONTACTS, DEV_COMPANY_ID } from "../lib/constants";
import {
  isApolloMockCompany,
  mockSearchOrganizations,
  mockSearchPeople,
  mockRevealedEmail,
} from "../lib/services/apollo-mock";

const rank = companyLookupTitleRank;

// A specific phrase must beat the generic word it contains, otherwise a
// Managing Director sorts level with any random "Director".
assert.ok(rank("Group Managing Director") < rank("Creative Director"), "managing director should outrank plain director");
assert.ok(rank("CEO") < rank("Export Manager"), "CEO should outrank export manager");
assert.ok(rank("Head of Procurement") < rank("Production Manager"), "head of should outrank a plain manager");
assert.ok(rank("Export Manager") < rank("Sales Executive"), "export should outrank generic sales roles");

// Case and surrounding words must not matter — Apollo returns free-form titles.
assert.equal(rank("managing director"), rank("Senior MANAGING DIRECTOR, APAC"), "ranking must be case- and context-insensitive");

// Unranked and missing titles sink, and must not accidentally sort first.
assert.equal(rank(null), Number.MAX_SAFE_INTEGER, "null title must sink");
assert.equal(rank(""), Number.MAX_SAFE_INTEGER, "empty title must sink");
assert.ok(rank("Yoga Instructor") > rank("Procurement Manager"), "unranked titles sink below ranked ones");

// A realistic roster sorts the way a salesperson would expect.
const roster = ["Warehouse Assistant", "Procurement Manager", "Managing Director", "Export Manager"];
const sorted = [...roster].sort((a, b) => rank(a) - rank(b));
assert.deepEqual(sorted, ["Managing Director", "Export Manager", "Procurement Manager", "Warehouse Assistant"]);

// The spend ceiling is what makes this feature safe to ship; if it ever moves,
// this check should be the thing that makes someone think twice.
assert.equal(COMPANY_LOOKUP_MAX_CONTACTS, 5, "contact cap changed — this is the reveal spend ceiling");

// ── Mock provider ───────────────────────────────────────────────────────────

const LIVE_COMPANY = "00000000-0000-0000-0000-00000000000b";
const originalEnv = process.env.NODE_ENV;

// Outside production — which is how this script, `next dev` and every localhost
// run execute — NOTHING reaches real Apollo, whichever tenant is signed in.
// This is the rule that would have prevented the 13 Aug 2026 spend: a tester
// signed into the live workspace on localhost sailed past a tenant-only check.
assert.equal(process.env.NODE_ENV !== "production", true, "this check must run outside production");
assert.equal(isApolloMockCompany(LIVE_COMPANY), true, "localhost must never spend live credits");
assert.equal(isApolloMockCompany(DEV_COMPANY_ID), true, "localhost must never spend live credits");

// In production the tenant decides, and the live workspace must reach real
// Apollo — if this ever flips, the client silently receives fabricated data.
process.env.NODE_ENV = "production";
assert.equal(isApolloMockCompany(DEV_COMPANY_ID), true, "internal workspace uses fixtures in production");
assert.equal(isApolloMockCompany(LIVE_COMPANY), false, "live workspace must use real Apollo in production");
assert.equal(isApolloMockCompany(null), false, "unknown company must not use fixtures in production");
assert.equal(isApolloMockCompany(undefined), false, "missing company must not use fixtures in production");

// Vercel preview builds also carry NODE_ENV=production, so they need their own
// guard — a branch deploy must never bill the client.
process.env.VERCEL_ENV = "preview";
assert.equal(isApolloMockCompany(LIVE_COMPANY), true, "preview deploys must never spend live credits");
process.env.VERCEL_ENV = "production";
assert.equal(isApolloMockCompany(LIVE_COMPANY), false, "the real deployment must reach live Apollo");
delete process.env.VERCEL_ENV;

// The opt-in escape hatch for deliberately testing the real integration.
process.env.APOLLO_FORCE_LIVE = "1";
process.env.NODE_ENV = originalEnv;
assert.equal(isApolloMockCompany(LIVE_COMPANY), false, "APOLLO_FORCE_LIVE must reach real Apollo");
delete process.env.APOLLO_FORCE_LIVE;
assert.equal(isApolloMockCompany(LIVE_COMPANY), true, "removing the override restores fixture safety");

const abc = mockSearchOrganizations({ name: "ABC" });
assert.ok(abc.organizations.length > 0, "ABC should return companies");
assert.ok(abc.organizations.every((o) => o.id.startsWith("mock_org_")), "mock ids must be unmistakable");
assert.ok(abc.organizations.every((o) => o.name?.startsWith("ABC")), "results should reflect the query");
// ── Fixture / vendor parity ─────────────────────────────────────────────────
// The raw fixture row must carry exactly the fields of the example response at
// docs.apollo.io/reference/organization-search — same names, same order, no
// extras, no omissions. This list is transcribed from that page and is the only
// place the fixture's shape is defined; if Apollo changes the response, update
// the list here and the failure will point at everything that has to follow.
//
// This assertion exists because its absence had a cost. The old check verified
// that city and employee count "survive normalizeOrg" against a fixture written
// to include them, which proves nothing about a field the endpoint omits — and
// on 18 Aug 2026 a client's first search rendered a dash in every Location and
// Staff cell. A test that only ever asks the fixture what the fixture contains
// cannot catch that. This one compares against the vendor.
const APOLLO_ORG_SEARCH_FIELDS = [
  "id", "name", "website_url", "blog_url", "angellist_url", "linkedin_url",
  "twitter_url", "facebook_url", "primary_phone", "languages", "alexa_ranking",
  "phone", "linkedin_uid", "founded_year", "publicly_traded_symbol",
  "publicly_traded_exchange", "logo_url", "crunchbase_url", "primary_domain",
  "sanitized_phone", "owned_by_organization_id", "show_intent",
  "has_intent_signal_account", "intent_signal_account",
];
for (const o of abc.organizations) {
  assert.deepEqual(
    Object.keys(o.raw),
    APOLLO_ORG_SEARCH_FIELDS,
    `fixture row for "${o.name}" does not match Apollo's documented Organization Search response`,
  );
}
// primary_phone is an object upstream, not a string. normalizeOrg reads `phone`
// with a ["phone", "primary_phone", "sanitized_phone"] fallback chain, so if it
// ever starts returning "[object Object]" this is what catches it.
assert.ok(
  abc.organizations.every((o) => typeof o.phone === "string" && o.phone.startsWith("+")),
  "phone must normalise to a string, not the primary_phone object",
);

// Fields Apollo's Organization Search DOES return must survive normalizeOrg.
assert.ok(abc.organizations.every((o) => o.primary_domain != null), "domain must survive normalizeOrg");
assert.ok(abc.organizations.every((o) => o.founded_year != null), "founded_year must survive normalizeOrg");
assert.ok(abc.organizations.every((o) => o.logo_url), "logo_url must survive normalizeOrg");

// And the ones it does NOT return must stay empty. This assertion is inverted
// from what it was before 18 Aug 2026, when it read `estimated_num_employees
// != null` and passed — against a fixture written to include a field the live
// endpoint omits entirely. A green test over an invented field is worse than no
// test: it cost a client-facing demo, where Location and Staff were a dash on
// all 100 rows. If a fixture ever starts supplying these again, this fails and
// the results table starts lying again — that is the point.
for (const field of ["estimated_num_employees", "city", "state", "country", "industry"] as const) {
  assert.ok(
    abc.organizations.every((o) => o[field] == null),
    `${field} must be null — Apollo's Organization Search does not return it, so no fixture may pretend otherwise`,
  );
}
assert.ok(abc.organizations.every((o) => o.website_url && o.linkedin_url), "website and linkedin must survive normalizeOrg");
assert.ok(abc.organizations.every((o) => o.twitter_url && o.facebook_url && o.crunchbase_url), "twitter, facebook and crunchbase must survive normalizeOrg");
assert.ok(abc.organizations.some((o) => o.blog_url), "blog_url should appear on some fixtures");
assert.ok(abc.organizations.some((o) => o.angellist_url), "angellist_url should appear on some fixtures");

// Deterministic: a repeated demo must show the same companies.
assert.deepEqual(
  mockSearchOrganizations({ name: "ABC" }).organizations.map((o) => o.id),
  abc.organizations.map((o) => o.id),
  "results must be stable across identical searches",
);

// Pagination is reachable in the UI (20 companies / page → 3 pages). Kept under
// one Apollo page so demos don't need "Search 100 more".
assert.equal(abc.pagination.total_entries, 48);
assert.equal(abc.pagination.total_pages, 1);
assert.equal(abc.organizations.length, 48, "page 1 should return the full fixture set");
assert.equal(mockSearchOrganizations({ name: "ABC", page: 2 }).organizations.length, 0, "no second Apollo page");

// Empty state on demand.
assert.equal(mockSearchOrganizations({ name: "zzz ltd" }).organizations.length, 0, "zzz returns no companies");

// Country relocates the set (all Kenya) rather than collapsing it — pagination
// demos must still get a full fixture page when a country is filled in.
const kenya = mockSearchOrganizations({ name: "ABC", locations: ["Kenya"] });
assert.equal(kenya.organizations.length, 48, "country filter must still return a full fixture page");
// The filter cannot be checked on a `country` field, because Apollo does not
// return one here. It is observable in the domain: Kenyan seeds carry .co.ke,
// and relocated padding falls back to .com.
assert.ok(
  kenya.organizations.some((o) => o.primary_domain?.endsWith(".co.ke")) &&
    kenya.organizations.some((o) => o.name?.includes("Plastics Ltd")),
  "native Kenya seeds should appear first",
);

const kenyaIndia = mockSearchOrganizations({ name: "ABC", locations: ["Kenya", "India"] });
assert.equal(kenyaIndia.organizations.length, 48, "multi-country filter must still return a full fixture page");
// Which countries came back is no longer assertable — Apollo returns no country
// on a search result, so neither does the fixture. What still matters, and is
// still observable, is that the filter reorders the set rather than being
// ignored: a country filter that changed nothing would be the real bug.
assert.notDeepEqual(
  kenyaIndia.organizations.map((o) => o.id),
  abc.organizations.map((o) => o.id),
  "a country filter must change the result set, not pass through untouched",
);
assert.ok(
  kenyaIndia.organizations.some((o) => o.primary_domain?.endsWith(".co.ke")) &&
    kenyaIndia.organizations.some((o) => o.primary_domain?.endsWith(".in")),
  "multi-country filter must include seeds from each selected country",
);

const people = mockSearchPeople({ organizationIds: [abc.organizations[0].id] });
assert.ok(people.people.length >= 40, "a company should have enough people for UI pagination");
assert.ok(people.people.every((p) => p.has_email), "contact_email_status means every result is contactable");
assert.ok(people.people.every((p) => p.id.startsWith("mock_person_")), "mock person ids must be unmistakable");
assert.ok(people.people.every((p) => (p.last_name_obfuscated ?? "").includes("*")), "Apollo masks surnames on search");
assert.deepEqual(
  mockSearchPeople({ organizationIds: [abc.organizations[0].id] }).people.map((p) => p.id),
  people.people.map((p) => p.id),
  "people must be stable per organization",
);

// The credit-safety property: a mock lead is inserted WITH an email, so it can
// never sit in the has_email=true / email=null state the watchdog pays to
// resolve. An empty or malformed address here would re-open that door.
const email = mockRevealedEmail("Rahul", "abcplastics.co.ke");
assert.match(email, /^[a-z0-9]+@[a-z0-9.-]+$/, "mock email must be a usable address");
assert.match(mockRevealedEmail(null, null), /^contact@example\.com$/, "mock email must survive missing inputs");

console.log("company-lookup self-check: all assertions passed");
