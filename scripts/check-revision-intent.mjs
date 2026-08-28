/**
 * Which instructions are allowed to change the shape of the email.
 *
 * The rule this protects: "make it shorter" and "make it more formal" ask for
 * exactly the things the old revision prompt told the model to preserve, so
 * they produced a 5% trim and no tone change at all. Both must classify as
 * global. Surgical edits must not, or a request to fix one line would license a
 * rewrite nobody asked for.
 *
 *   node scripts/check-revision-intent.mjs
 */
import assert from "node:assert/strict";

// Mirrors lib/services/revision-intent.ts — the repo has no TypeScript runner.
const GLOBAL_PATTERNS = [
  /\b(short(er|en)?|brief(er)?|concise|condense|trim|tighten|less wordy|too long)\b/i,
  /\b(long(er)?|expand|elaborate|more detail)\b/i,
  /\b(formal|informal|casual|friendly|warm(er)?|polite|professional|tone|voice|style|softer|firmer|persuasive)\b/i,
  /\b(rewrite|re-write|redo|start over|from scratch|different|not good|improve|better)\b/i,
  /\b(restructure|reorder|reorganise|reorganize|bullet|structure)\b/i,
];
const classify = (t) => {
  const s = (t ?? "").trim();
  if (!s) return "local";
  return GLOBAL_PATTERNS.some((re) => re.test(s)) ? "global" : "local";
};

// The two the client actually typed, which is what started this.
assert.equal(classify("make it shorter"), "global");
assert.equal(
  classify("the draft is not good, kindly change the same and make it more formal"),
  "global",
);

// Other whole-email asks.
for (const t of [
  "make it short and professional", "too long", "condense this",
  "warmer tone please", "more persuasive", "rewrite it",
  "start over", "use bullet points", "restructure the middle",
  "make it longer", "expand the second paragraph a bit",
]) assert.equal(classify(t), "global", t);

// Surgical edits must stay local, or one bad classification rewrites an email
// where the user only wanted a line changed.
for (const t of [
  "remove the last paragraph",
  "add a line about our Dubai warehouse",
  "fix the spelling of their company name",
  "swap Black Masterbatch for White Masterbatch",
  "delete the sentence about awards",
]) assert.equal(classify(t), "local", t);

// Unrecognised wording falls to the conservative side.
assert.equal(classify("mention the trade show in Dubai next month"), "local");
assert.equal(classify(""), "local");
assert.equal(classify(undefined), "local");

console.log("ok — revision intent");
