/**
 * Guards the one rule that broke lead quality on 2026-09-04: a catalog `query`
 * must describe what the company MAKES, never the market it sells into.
 *
 * "dairy" found dairies, "shipping" found shipping lines, "agriculture" found
 * farms — the client listed exactly those industries as irrelevant, because
 * Kuber sells masterbatch to the converter, not to the brand that fills the pack.
 *
 * Run: npx tsx lib/keyword-catalog.test.mts
 */
import { strict as assert } from "assert";
import { DEFAULT_INDUSTRY_KEYWORD_GROUPS, resolveApolloKeyword } from "./constants";

/** Bare end-market words. Each one shipped, and each one produced a complaint. */
const BANNED = new Set([
  "dairy", "shipping", "agriculture", "solar", "bottling", "cosmetics",
  "pharmaceuticals", "containers", "recycling", "automotive", "furniture",
  "toys", "textile", "tanks", "closures", "molding", "pallets",
]);

const queries = DEFAULT_INDUSTRY_KEYWORD_GROUPS.flatMap((c) => c.keywords.map((k) => k.query));
assert.ok(queries.length > 0, "catalog must not be empty");

for (const q of queries) {
  assert.ok(!BANNED.has(q.toLowerCase()),
    `"${q}" is a bare end-market term — it finds the customer's customer, not a masterbatch buyer`);
}

// Labels are what the user picks; they must resolve to the query, not to themselves.
for (const cat of DEFAULT_INDUSTRY_KEYWORD_GROUPS) {
  for (const k of cat.keywords) {
    assert.equal(resolveApolloKeyword(DEFAULT_INDUSTRY_KEYWORD_GROUPS, k.label), k.query,
      `label "${k.label}" does not resolve to its query`);
  }
}

// A term nobody selected must fall through unchanged (free-typed custom keyword).
assert.equal(resolveApolloKeyword(DEFAULT_INDUSTRY_KEYWORD_GROUPS, "some custom term"), "some custom term");

// The five that caused the complaint must now resolve to a process term.
const fixed: [string, string][] = [
  // "Blown Film" is now its own labelled entry in the section, so Milk Pouch
  // points at the broader process term. Still a process, never a market.
  ["Milk Pouch & Food Films", "plastic film"],
  ["Blown Film", "blown film"],
  ["Courier Bags & Industrial Bags", "plastic bags"],
  ["Agricultural Films (Mulch/Silage/Greenhouse)", "agricultural film"],
  ["Beverage Bottles (Water/Juice/CSD)", "pet bottles"],
  ["Automotive Blow Molded Parts", "automotive components"],
];
for (const [label, expected] of fixed) {
  assert.equal(resolveApolloKeyword(DEFAULT_INDUSTRY_KEYWORD_GROUPS, label), expected, `${label} should now send "${expected}"`);
}

// The client asks for this section by name; a 2026-09-04 rename removed the
// words "Blown Film" from the UI without removing any keyword, and nobody
// noticed until they did.
assert.ok(
  DEFAULT_INDUSTRY_KEYWORD_GROUPS.some((c) => /blown film/i.test(c.label)),
  'a category label must still contain "Blown Film" — the client looks for it by name',
);

console.log(`keyword-catalog: ${queries.length} queries, none are bare end-market terms — all checks passed`);
