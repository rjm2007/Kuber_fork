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
import { DEFAULT_INDUSTRY_KEYWORD_GROUPS, resolveApolloKeyword, parseIndustryKeywordGroups } from "./constants";

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

// ── The seeded taxonomy must match the constant ──────────────────────────────
// From 2026-09-07 the app reads Settings > Industry Segments out of the
// database, not this constant — so every assertion above stopped protecting the
// thing that actually runs the moment the migration seeded a different list.
// It did: the seed shipped the PRE-restoration taxonomy, with the group renamed
// back to "Flexible Packaging", the standalone "Blown Film" entry gone, and
// "barrier film" (measured 2026-09-05 at 227 results, 0% noise) absent
// entirely. Every test here passed while the live workspace had lost them.
//
// So the seed itself is checked against the constant. A future edit to one
// without the other fails here rather than in front of the client.
import { readFileSync } from "node:fs";

const seedSql = readFileSync("supabase/migrations/2026_09_07_industry_keyword_groups_setting.sql", "utf8");
const seedJson = seedSql.match(/\$json\$([\s\S]*?)\$json\$/)?.[1];
assert.ok(seedJson, "seed migration must still carry a $json$...$json$ payload");
const seeded = JSON.parse(seedJson!) as typeof DEFAULT_INDUSTRY_KEYWORD_GROUPS;

assert.deepEqual(
  seeded,
  DEFAULT_INDUSTRY_KEYWORD_GROUPS,
  "the seeded taxonomy has drifted from DEFAULT_INDUSTRY_KEYWORD_GROUPS — a new company would start with a different keyword list than the code says it has",
);

// Belt and braces on the one the client names out loud, asserted against the
// SEED rather than the constant.
assert.ok(
  seeded.some((c) => /blown film/i.test(c.label)),
  'the SEEDED taxonomy must contain a group labelled "Blown Film" — this is what a real company gets',
);
assert.ok(
  seeded.some((c) => c.keywords.some((k) => k.query === "barrier film")),
  'the SEEDED taxonomy must still contain "barrier film" (227 results, 0% noise, measured 2026-09-05)',
);

// ── Malformed settings must not take the import down ────────────────────────
// industry_keyword_groups is edited by hand in Settings, so nothing guarantees
// its shape at write time. A group saved without a keywords array used to make
// resolveApolloKeyword throw, which fails the whole Apollo import before a
// single search runs.
for (const junk of [
  '[{"id":"x","label":"X"}]',                  // no keywords array at all
  '[{"id":"x","label":"X","keywords":null}]',  // keywords not an array
  '[1,2,3]',                                   // not objects
  '[]',                                        // empty
  '{"not":"an array"}',                        // not an array
  'definitely not json',
  '',
]) {
  const parsed = parseIndustryKeywordGroups(junk);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, `parse must fall back for ${junk}`);
  assert.doesNotThrow(() => resolveApolloKeyword(parsed, "Blown Film"), `resolve must survive ${junk}`);
}

// The exact row found live in Kuber Polyplast's Recyclers group on 2026-09-07:
// someone clicked "add keyword" and saved it empty. It rendered as an empty
// option and would have sent an empty q_keywords to Apollo.
const withBlank = parseIndustryKeywordGroups(JSON.stringify([
  { id: "r", label: "Recyclers", emoji: "♻️", keywords: [
    { id: "ok", label: "PE/PP Recyclers & Reclaimers", query: "plastic recycling" },
    { id: "2f01df03", label: "", query: "" },
  ] },
]));
assert.equal(withBlank[0].keywords.length, 1, "blank keyword rows must be dropped");
assert.equal(resolveApolloKeyword(withBlank, ""), "", "an empty label must not match a blank row");

// A real customization still wins over the built-in taxonomy.
const custom = parseIndustryKeywordGroups(JSON.stringify([
  { id: "c", label: "Custom", emoji: "", keywords: [{ id: "c1", label: "My Term", query: "my query" }] },
]));
assert.equal(resolveApolloKeyword(custom, "My Term"), "my query");

console.log(`keyword-catalog: ${queries.length} queries, none are bare end-market terms; seed matches the constant — all checks passed`);
