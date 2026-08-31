/**
 * Which text a follow-up falls back to when it cannot be personalised.
 *
 * Two situations reach the fallback and they mean the same thing — the lead has
 * no company data, or the AI failed. Before this, they used two DIFFERENT
 * texts: one read a global setting, the other was a constant hardcoded in
 * generate-drafts.ts that named "Kuber Polyplast" in the source and could not be
 * edited anywhere.
 *
 * Mirrors resolveFollowupTemplate() in lib/services/followup-template.ts.
 *
 *   node scripts/check-followup-template.mjs
 */
import assert from "node:assert/strict";

const BUILT_IN =
  "Just following up on my earlier note. If it is worth a quick look, " +
  "I would be glad to share details suited to your requirements.";

/** The resolution order, with the same trim-and-fall-through rules. */
function resolve({ perStep, fromSettings }, stepOrder) {
  if (stepOrder > 1) {
    const s = (perStep ?? "").trim();
    if (s) return s;
  }
  const g = (fromSettings ?? "").trim();
  if (g) return g;
  return BUILT_IN;
}

const STEP = "Following up on the 10% introductory offer — worth a look?";
const SETTINGS = "Just circling back on my note — would love your thoughts.";

// ── Most specific wins ───────────────────────────────────────────────────────
assert.equal(resolve({ perStep: STEP, fromSettings: SETTINGS }, 2), STEP);
assert.equal(resolve({ perStep: null, fromSettings: SETTINGS }, 2), SETTINGS);
assert.equal(resolve({ perStep: null, fromSettings: null }, 2), BUILT_IN);

// ── Empty and whitespace mean "inherit", not "send nothing" ──────────────────
// This is the one that matters: a user clearing the box must fall back to the
// default, never send a blank email.
assert.equal(resolve({ perStep: "", fromSettings: SETTINGS }, 2), SETTINGS);
assert.equal(resolve({ perStep: "   ", fromSettings: SETTINGS }, 2), SETTINGS);
assert.equal(resolve({ perStep: "\n\n", fromSettings: SETTINGS }, 2), SETTINGS);
assert.equal(resolve({ perStep: "", fromSettings: "" }, 2), BUILT_IN);

// ── Per STEP, so different follow-ups can say different things ───────────────
const steps = { 2: "Second nudge.", 3: null, 4: "Final note before I close this off." };
assert.equal(resolve({ perStep: steps[2], fromSettings: SETTINGS }, 2), "Second nudge.");
assert.equal(resolve({ perStep: steps[3], fromSettings: SETTINGS }, 3), SETTINGS);
assert.equal(resolve({ perStep: steps[4], fromSettings: SETTINGS }, 4), steps[4]);

// ── Step 1 is NOT a follow-up ────────────────────────────────────────────────
// The opening email has its own generic template in Settings; a per-step
// follow-up text must never hijack it.
assert.equal(resolve({ perStep: STEP, fromSettings: SETTINGS }, 1), SETTINGS);

// ── The built-in must name no specific company ───────────────────────────────
// The constant this replaces said "Kuber Polyplast" in the source, so a second
// client on this system would have sent emails naming the wrong company.
assert.ok(!/kuber|polyplast/i.test(BUILT_IN),
  "the last-resort text must not name a company");

// ── Placeholders ─────────────────────────────────────────────────────────────
const fill = (text, vars) =>
  text.replace(/\{\{\s*(first_name|name|company)\s*\}\}/gi, (_m, k) =>
    k.toLowerCase() === "company" ? vars.company : vars.first_name);

assert.equal(fill("Hi {{first_name}}, still worth a look?", { first_name: "Karan", company: "Shimmers" }),
  "Hi Karan, still worth a look?");
assert.equal(fill("A note for {{company}}.", { first_name: "", company: "Shimmers" }),
  "A note for Shimmers.");
// Text with no placeholder is returned untouched.
assert.equal(fill(BUILT_IN, { first_name: "X", company: "Y" }), BUILT_IN);

console.log("ok — per-step template wins, empty inherits, step 1 is untouched");

// ── A template follow-up gets no signature ───────────────────────────────────
// The AI path already omitted it; the template path appended it regardless, so
// the same lead's follow-up carried a full signature block if it fell back and
// none if it did not. On a ~200 character nudge that is more footer than email,
// and it threads directly under a message whose signature is already visible.
// Both paths in generate-drafts.ts now use this rule.
const signatureFor = (stepNumber, signatureBlock) => (stepNumber > 1 ? "" : signatureBlock);
const SIG = "Ankit Singh\nBusiness Head";

assert.equal(signatureFor(1, SIG), SIG, "the opening email keeps its signature");
assert.equal(signatureFor(2, SIG), "", "a follow-up threads as a reply — no second signature");
assert.equal(signatureFor(3, SIG), "");

console.log("ok — a template follow-up carries no signature, the opening still does");
