/**
 * The matched product must end up in bold, whoever put it there.
 *
 * The prompt asks for it and the model mostly complies — but "make it shorter"
 * makes trimming and emphasis pull against each other, and brevity wins:
 * measured 9 of 15 on a regeneration run against 15 of 15 on first drafts.
 * A mechanical rule with one right answer should not depend on the model.
 *
 *   node scripts/check-product-emphasis.mjs
 */
import assert from "node:assert/strict";

// Mirrors ensureProductEmphasis in lib/services/generate-drafts.ts.
function ensureProductEmphasis(body, productMatch) {
  if (!productMatch?.trim()) return body;
  if (body.includes("**")) return body;
  const name = productMatch.trim();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  const found = body.match(re);
  if (!found) return body;
  return body.replace(re, `**${found[0]}**`);
}

// The case this exists for: shortened email, product named, no emphasis left.
assert.equal(
  ensureProductEmphasis("For that, Additive Masterbatch is the fit.", "Additive Masterbatch"),
  "For that, **Additive Masterbatch** is the fit.",
);

// The library stores names in caps; the model writes them in title case. An
// exact-case search would miss exactly the emails this is meant to repair.
assert.equal(
  ensureProductEmphasis("We suggest Colour Masterbatch here.", "COLOR MASTERBATCH"),
  "We suggest Colour Masterbatch here.",           // different spelling: left alone
);
assert.equal(
  ensureProductEmphasis("We suggest COLOR MASTERBATCH here.", "color masterbatch"),
  "We suggest **COLOR MASTERBATCH** here.",
);

// Never second-guess an email the model already emphasised.
assert.equal(
  ensureProductEmphasis("Try **White Masterbatch** and Black Masterbatch.", "Black Masterbatch"),
  "Try **White Masterbatch** and Black Masterbatch.",
);

// Only the FIRST mention — bolding every occurrence is the over-bolding this
// is trying to avoid.
assert.equal(
  ensureProductEmphasis("Black Masterbatch, then more Black Masterbatch.", "Black Masterbatch"),
  "**Black Masterbatch**, then more Black Masterbatch.",
);

// Inserting a product the model chose to leave out would be writing the email,
// not formatting it.
assert.equal(
  ensureProductEmphasis("Nothing relevant here.", "Black Masterbatch"),
  "Nothing relevant here.",
);
assert.equal(ensureProductEmphasis("Some text", ""), "Some text");
assert.equal(ensureProductEmphasis("Some text", undefined), "Some text");

// A name with regex characters must not blow up.
assert.equal(
  ensureProductEmphasis("Our Superblend® (A+) helps.", "Superblend® (A+)"),
  "Our **Superblend® (A+)** helps.",
);

console.log("ok — product emphasis");
