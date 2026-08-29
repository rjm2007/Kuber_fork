/**
 * A model saying "I have nothing" must become an absent value, not the word.
 *
 * The extraction prompt asks for JSON `null` when a field cannot be evidenced.
 * Models sometimes return the WORD instead — the string "null" — and `!!"null"`
 * is true, so it passed every check and was stored as the company's own
 * description. Live data on 30 Aug 2026: 2 organisations described themselves
 * as `null`, and 5 said they sell to `null`. That text feeds the email prompt,
 * so a customer could have been written to about a company whose description
 * is the word "null".
 *
 * Mirrors cleanExtracted() in app/api/enrich/scrape-orgs/route.ts.
 *
 *   node scripts/check-extracted-null.mjs
 */
import assert from "node:assert/strict";

function cleanExtracted(value) {
  const text = (value ?? "").trim();
  if (!text) return null;
  return /^(null|none|n\/a|na|unknown|undefined|not available|not specified|-)\.?$/i.test(text)
    ? null
    : text;
}

// ── The exact values found in the database ───────────────────────────────────
assert.equal(cleanExtracted("null"), null);
assert.equal(cleanExtracted("NULL"), null);
assert.equal(cleanExtracted(" null "), null);
assert.equal(cleanExtracted("null."), null);

// ── The other ways a model says nothing ──────────────────────────────────────
for (const empty of ["none", "N/A", "n/a", "na", "unknown", "undefined", "-", "Not available", "not specified"]) {
  assert.equal(cleanExtracted(empty), null, `${empty} must be treated as absent`);
}

// ── Genuinely absent input ───────────────────────────────────────────────────
assert.equal(cleanExtracted(null), null);
assert.equal(cleanExtracted(undefined), null);
assert.equal(cleanExtracted(""), null);
assert.equal(cleanExtracted("   "), null);

// ── Real descriptions must survive untouched, including the awkward ones ─────
// These are the false positives that would matter: a real company whose
// description happens to start with, or contain, one of the words above.
const realDescriptions = [
  "Nanjing Unknown Plastics Co. manufactures colour masterbatch for injection moulding.",
  "None Such Foods Ltd produces preserved fruit fillings for the bakery trade.",
  "NA Chemicals is an Indian producer of polymer additives and UV stabilisers.",
  "Manjushree Technopack manufactures rigid plastic packaging across multiple plants in India.",
  "Deseret Dairy Products supplies milk powders to industrial food manufacturers.",
];
for (const d of realDescriptions) {
  assert.equal(cleanExtracted(d), d, `real description must pass: ${d.slice(0, 40)}`);
}

// Whitespace is trimmed but the text is otherwise returned unchanged.
assert.equal(cleanExtracted("  Kuber Polyplast makes masterbatch.  "), "Kuber Polyplast makes masterbatch.");

// A hyphen alone is nothing; a hyphenated word is not.
assert.equal(cleanExtracted("-"), null);
assert.equal(cleanExtracted("Oxo-biodegradable additive supplier."), "Oxo-biodegradable additive supplier.");

console.log("ok — the word \"null\" is treated as no data, real descriptions pass");
