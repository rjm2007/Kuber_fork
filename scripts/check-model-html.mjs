/**
 * The model is asked for plain text. Once in 45 drafts it sends HTML anyway.
 *
 * Everything downstream assumes plain text: plainToHtml escapes what it is
 * handed, and the greeting fixer looks for a body starting with "Dear". So a
 * body of "<p>Dear Said,</p>" reached the customer as a literal
 * "&lt;p&gt;Dear Said,&lt;/p&gt;", with a second greeting prepended on top
 * because the escaped text no longer began with one.
 *
 *   node scripts/check-model-html.mjs
 */
import assert from "node:assert/strict";

// Mirrors the detector in lib/services/generate-drafts.ts.
const looksLikeHtml = (body) =>
  /<\/?(p|br|div|span|strong|em|b|i|u|ul|ol|li|a|h[1-6])\b[^>]*>/i.test(body);

// The case this exists for.
assert.equal(looksLikeHtml("<p>Dear Said,</p><p>Following up...</p>"), true);
assert.equal(looksLikeHtml("Dear Said,<br><br>Following up..."), true);
assert.equal(looksLikeHtml("Use <strong>White Masterbatch</strong>."), true);
assert.equal(looksLikeHtml("</p>"), true);

// Ordinary plain text is left alone.
assert.equal(looksLikeHtml("Dear Said,\n\nFollowing up on my note."), false);
assert.equal(looksLikeHtml("Use **White Masterbatch** for opacity."), false);

// A "<" that is not markup must NOT trigger the stripper — running these
// through an HTML parser would silently eat the rest of the sentence, which is
// worse than the bug being fixed. Masterbatch copy is full of these.
assert.equal(looksLikeHtml("Processing under <200 C keeps dispersion stable."), false);
assert.equal(looksLikeHtml("Moisture <0.1% and ash <2%."), false);
assert.equal(looksLikeHtml("Their margin is < ours."), false);

// The word boundary is what makes that work. Without \b, the "p" branch
// matches "<production>" and a perfectly good body gets stripped.
assert.equal(looksLikeHtml("Our <production> capacity is 18,000 MT."), false);
assert.equal(looksLikeHtml("<pipeline> and <blowing> lines"), false);

console.log("ok — model html detection");
