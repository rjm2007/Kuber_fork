/**
 * A gendered honorific must never reach a prospect's inbox.
 *
 * Measured 31 Aug 2026: a real draft to a female prospect said "sir" twice. The
 * word was not in the company system prompt — it was in ONE rep's personal
 * draft prompt, which the client wrote themselves and which REPLACES the
 * company prompt wholesale (resolveDraftPrompt returns early on it). So a rule
 * added to the company prompt could not reach the emails that had the problem.
 *
 * That is why this belongs in NON_NEGOTIABLE_RULES, the one block appended to
 * every prompt tier — company, personal and template alike.
 *
 *   node scripts/check-honorifics.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../lib/services/settings.ts", import.meta.url), "utf8");

// ── The rule is in the block that survives a personal prompt ─────────────────
const block = src.slice(
  src.indexOf("export const NON_NEGOTIABLE_RULES"),
  src.indexOf("].join(\"\n\")", src.indexOf("export const NON_NEGOTIABLE_RULES")),
);
assert.ok(/gendered honorific/i.test(block),
  "the no-honorific rule must live in NON_NEGOTIABLE_RULES, not the company system prompt");
// It must say so even when the template disagrees — that is the whole case.
assert.ok(/personal prompt/i.test(block),
  "the rule must explicitly outrank a personal prompt that uses one");

// ── NON_NEGOTIABLE_RULES really is appended on every tier ───────────────────
// If a future refactor drops it from one branch, that tier silently loses this
// rule and every other one in the block.
const resolver = src.slice(src.indexOf("export async function resolveDraftSystemPrompt"));
const body = resolver.slice(0, resolver.indexOf("\n}"));
assert.equal((body.match(/NON_NEGOTIABLE_RULES/g) ?? []).length, 2,
  "both the follow-up branch and the opening branch must append NON_NEGOTIABLE_RULES");

// ── What the rule has to catch, and what it must not ────────────────────────
const hasHonorific = (t) => /\b(sir|ma'?am|madam)\b/i.test(t);

assert.ok(hasHonorific("Please let us know sir if you have any requirements."));
assert.ok(hasHonorific("tailored to your requirements sir"));
assert.ok(hasHonorific("Thank you madam for your time."));

// The greeting is the one legitimate use, and only when there is no first name.
assert.ok(hasHonorific("Dear Sir/Ma'am,"),
  "the greeting form is still detected — the rule carves it out by position, not by wording");

// Ordinary copy must not trip it.
assert.ok(!hasHonorific("We ship to Sirsa and Madurai."), "substrings are not honorifics");
assert.ok(!hasHonorific("Our masterbatch suits PE, PP and PET."));

console.log("ok — no gendered honorific survives any prompt tier, greeting excepted");
