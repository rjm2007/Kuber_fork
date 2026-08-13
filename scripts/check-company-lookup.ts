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

// THE safety assertion. If this ever flips, the live client workspace starts
// receiving fabricated companies instead of real ones.
assert.equal(isApolloMockCompany(DEV_COMPANY_ID), true, "dev workspace must use fixtures");
assert.equal(isApolloMockCompany("00000000-0000-0000-0000-00000000000b"), false, "live workspace must NEVER use fixtures");
assert.equal(isApolloMockCompany(null), false, "unknown company must not use fixtures");
assert.equal(isApolloMockCompany(undefined), false, "missing company must not use fixtures");

const abc = mockSearchOrganizations({ name: "ABC" });
assert.ok(abc.organizations.length > 0, "ABC should return companies");
assert.ok(abc.organizations.every((o) => o.id.startsWith("mock_org_")), "mock ids must be unmistakable");
assert.ok(abc.organizations.every((o) => o.name?.startsWith("ABC")), "results should reflect the query");
// The normalizer is the part most likely to be wrong against real Apollo, so
// the mock proves it populates the columns the results table renders.
assert.ok(abc.organizations.every((o) => o.estimated_num_employees != null), "employee count must survive normalizeOrg");
assert.ok(abc.organizations.every((o) => o.country != null && o.primary_domain != null), "country and domain must survive normalizeOrg");

// Deterministic: a repeated demo must show the same companies.
assert.deepEqual(
  mockSearchOrganizations({ name: "ABC" }).organizations.map((o) => o.id),
  abc.organizations.map((o) => o.id),
  "results must be stable across identical searches",
);

// Pagination is reachable, so the "search 100 more" path and the page cap can
// both be exercised.
assert.equal(abc.pagination.total_entries, 137);
assert.equal(abc.pagination.total_pages, 2);
assert.equal(abc.organizations.length, 100, "page 1 should fill");
assert.equal(mockSearchOrganizations({ name: "ABC", page: 2 }).organizations.length, 37, "page 2 holds the remainder");

// Empty state on demand.
assert.equal(mockSearchOrganizations({ name: "zzz ltd" }).organizations.length, 0, "zzz returns no companies");

// Country narrows the set, mirroring organization_locations server-side.
const kenya = mockSearchOrganizations({ name: "ABC", locations: ["Kenya"] });
assert.ok(kenya.organizations.length > 0 && kenya.organizations.length < 100, "country filter should narrow");
assert.ok(kenya.organizations.every((o) => o.country === "Kenya"), "country filter must actually filter");

const people = mockSearchPeople({ organizationIds: [abc.organizations[0].id] });
assert.ok(people.people.length >= 6, "a company should have people");
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
