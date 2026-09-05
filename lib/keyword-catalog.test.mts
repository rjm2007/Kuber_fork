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
import { INDUSTRY_KEYWORD_CATEGORIES, resolveApolloKeyword } from "./constants";

/** Bare end-market words. Each one shipped, and each one produced a complaint. */
const BANNED = new Set([
  "dairy", "shipping", "agriculture", "solar", "bottling", "cosmetics",
  "pharmaceuticals", "containers", "recycling", "automotive", "furniture",
  "toys", "textile", "tanks", "closures", "molding", "pallets",
]);

const queries = INDUSTRY_KEYWORD_CATEGORIES.flatMap((c) => c.keywords.map((k) => k.query));
assert.ok(queries.length > 0, "catalog must not be empty");

for (const q of queries) {
  assert.ok(!BANNED.has(q.toLowerCase()),
    `"${q}" is a bare end-market term — it finds the customer's customer, not a masterbatch buyer`);
}

// Labels are what the user picks; they must resolve to the query, not to themselves.
for (const cat of INDUSTRY_KEYWORD_CATEGORIES) {
  for (const k of cat.keywords) {
    assert.equal(resolveApolloKeyword(k.label), k.query,
      `label "${k.label}" does not resolve to its query`);
  }
}

// A term nobody selected must fall through unchanged (free-typed custom keyword).
assert.equal(resolveApolloKeyword("some custom term"), "some custom term");

// The five that caused the complaint must now resolve to a process term.
const fixed: [string, string][] = [
  ["Milk Pouch & Food Films", "blown film"],
  ["Courier Bags & Industrial Bags", "plastic bags"],
  ["Agricultural Films (Mulch/Silage/Greenhouse)", "agricultural film"],
  ["Beverage Bottles (Water/Juice/CSD)", "pet bottles"],
  ["Automotive Blow Molded Parts", "automotive components"],
];
for (const [label, expected] of fixed) {
  assert.equal(resolveApolloKeyword(label), expected, `${label} should now send "${expected}"`);
}

console.log(`keyword-catalog: ${queries.length} queries, none are bare end-market terms — all checks passed`);
