/**
 * A draft with no email in it must never be saved.
 *
 * DraftSchema accepts `body: ""` because z.string() does, so a model returning
 * an empty body produced a saved, ready-to-send draft consisting of
 * "Dear <name>," followed immediately by the signature — status 'draft',
 * source 'ai', no error recorded anywhere. It looked completely healthy.
 *
 * Measured 30 Aug 2026 over 18 drafts on the same 6 leads: Haiku 4.5 did it
 * once, Sonnet 5 at effort=low did it once (and three times running on one
 * lead). Not model-specific — nothing stopped OpenAI doing the same.
 *
 * Mirrors the guard in lib/services/generate-drafts.ts.
 *
 *   node scripts/check-empty-body-guard.mjs
 */
import assert from "node:assert/strict";

// Per step: an opening email and a follow-up are not the same shape.
const MIN_BODY_CHARS_OPENING = 120;
const MIN_BODY_CHARS_FOLLOWUP = 60;
const minBodyCharsFor = (stepNumber) =>
  stepNumber > 1 ? MIN_BODY_CHARS_FOLLOWUP : MIN_BODY_CHARS_OPENING;

/** Same shape as the guard: strip tags, trim, measure. Defaults to step 1. */
const tooShort = (body, stepNumber = 1) =>
  body.replace(/<[^>]+>/g, " ").trim().length < minBodyCharsFor(stepNumber);

const MIN_BODY_CHARS = MIN_BODY_CHARS_OPENING;

// ── What the guard exists to catch ───────────────────────────────────────────
assert.equal(tooShort(""), true, "an empty body must be rejected");
assert.equal(tooShort("   "), true);

// The real failure, copied from the live run: greeting + signature, no email.
const greetingPlusSignature =
  "<p>Dear Mounir,<br><br>Ankit Singh<br><strong>Business Head -Americas </strong>" +
  "(North &amp; South America)<br><strong>Contact details: </strong>+91 84485 81064(M)</p>";
// The signature is appended by code AFTER this check, so what the guard sees is
// only what the model returned — which was nothing.
assert.equal(tooShort(""), true);
// And even if a stub arrives with markup, tags must not be counted as content.
assert.equal(tooShort("<p><br><br></p>"), true, "markup alone is not a body");
assert.ok(greetingPlusSignature.length > MIN_BODY_CHARS,
  "raw length would have passed — which is exactly why tags are stripped first");

// ── What it must NOT catch: real emails, including the short ones ────────────
// Shortest legitimate opening email measured live was 515 plain-text chars.
const shortestRealOpening =
  "Kuber Polyplast is an ISO 9001:2015 certified masterbatch manufacturer based in Delhi " +
  "with 30+ years of experience, though we recognise that what we make is likely what " +
  "Perfect Colourants already produces itself, so this may not be relevant to you at all. " +
  "That said, do you ever source any raw materials or compounds from outside suppliers?";
assert.equal(tooShort(shortestRealOpening), false, "a real short email must pass");

// A deliberately terse follow-up nudge runs ~235 chars.
const terseFollowUp =
  "Just following up on my earlier note about Kuber Polyplast's masterbatch and polymer " +
  "compounds. If it is worth a quick look, I would be glad to share details suited to " +
  "your requirements.";
assert.equal(tooShort(terseFollowUp), false, "a terse follow-up must pass");

// Right at the boundary, so the threshold cannot drift unnoticed.
assert.equal(tooShort("x".repeat(MIN_BODY_CHARS - 1)), true);
assert.equal(tooShort("x".repeat(MIN_BODY_CHARS)), false);

// Tags stripped, not counted: 130 real chars wrapped in markup still passes.
assert.equal(tooShort(`<p><strong>${"y".repeat(130)}</strong></p>`), false);

// ── The model explaining itself instead of writing the email ─────────────────
// Asked to write a follow-up to a haircare importer, Claude invented a sentinel
// that appears nowhere in our code or our prompt, and we SAVED it as an
// approved, ready-to-send follow-up (live, 30 Aug 2026).
const looksLikeRefusal = (t) =>
  /[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}/.test(t) ||
  /(?:there is no honest|no honest product match|I cannot (?:write|generate|produce)|I'm unable to (?:write|generate)|as an AI(?: language)? model|fabricating one would)/i.test(t);

const theRealRefusal =
  "Dear Karan, NO_EMAIL_GENERATED: Shimmers Cosmetics is a haircare import and " +
  "distribution house with no plastic manufacturing or packaging production activity " +
  "identified. There is no honest product match from the Kuber Polyplast range, and " +
  "fabricating one would be dishonest.";
assert.equal(looksLikeRefusal(theRealRefusal), true, "the refusal that started this must be caught");
assert.equal(looksLikeRefusal("I cannot write an email for this lead."), true);
assert.equal(looksLikeRefusal("As an AI model, I am unable to help here."), true);

// Real masterbatch copy must never trip it. These are verbatim from live drafts —
// shouty product words, specs with colons and angle brackets, and the signature
// block are all normal here, and none of them contain an ALL_CAPS_SNAKE token.
for (const real of [
  "Kuber Polyplast is an ISO 9001:2015 certified manufacturer with 30 years experience and FREE SAMPLES available.",
  "Our OXO-Biodegradable and UV Stabiliser grades suit outdoor use. Black Masterbatch with <50 PPM grit.",
  "Contact details: +91 84485 81064(M) ankit.singh@kuberpolyplast.com www.kuberpolyplast.com",
  "18,000 MT annual production capacity. 6,670+ clients across 40+ countries.",
]) {
  assert.equal(looksLikeRefusal(real), false, `real copy must pass: ${real.slice(0, 40)}`);
}

// ── A follow-up is MEANT to be short ────────────────────────────────────────
// Measured over 1,366 real AI-written follow-ups: shortest 78, average 260.
// A flat 120 rejected 9 good ones and paid for a needless regeneration each
// time, so the threshold is per step.
const shortestRealFollowUp =
  "Hi Karan, Just following up on my earlier email. Would it be worth a quick look?";
assert.ok(shortestRealFollowUp.length < MIN_BODY_CHARS_OPENING,
  "this real follow-up is shorter than the opening-email floor — that is the point");
assert.equal(tooShort(shortestRealFollowUp, 2), false, "a real short follow-up must pass");
assert.equal(tooShort(shortestRealFollowUp, 1), true, "the same text as an OPENING email is too short");

// The template nudge the safety net writes, at 86 chars, must also survive.
assert.equal(
  tooShort("Hi Sales, Just following up on my previous note — would love your thoughts. Best regards", 2),
  false,
);

// But an empty generation is still caught on a follow-up. The real failure was
// a four-character body, and the signature is appended AFTER this check.
assert.equal(tooShort("", 2), true);
assert.equal(tooShort("Hi.", 2), true);
assert.equal(tooShort("<p><br><br></p>", 2), true);

// Boundaries, so neither threshold can drift unnoticed.
assert.equal(tooShort("x".repeat(59), 2), true);
assert.equal(tooShort("x".repeat(60), 2), false);
assert.equal(tooShort("x".repeat(119), 1), true);
assert.equal(tooShort("x".repeat(120), 1), false);

console.log("ok — empty and stub bodies are rejected, real short emails pass");
console.log("ok — refusals and invented markers are rejected, real copy is not");
console.log("ok — follow-ups may be short; opening emails may not");
