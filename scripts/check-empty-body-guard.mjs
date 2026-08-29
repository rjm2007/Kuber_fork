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

const MIN_BODY_CHARS = 120;

/** Same shape as the guard: strip tags, trim, measure. */
const tooShort = (body) => body.replace(/<[^>]+>/g, " ").trim().length < MIN_BODY_CHARS;

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

console.log("ok — empty and stub bodies are rejected, real short emails pass");
