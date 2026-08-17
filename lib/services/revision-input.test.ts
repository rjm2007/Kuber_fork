/**
 * Self-check for the regenerate-box parser — the thing that decides whether
 * what the user typed is an instruction, an example email, or both. Getting it
 * wrong is what put "Astral Ltd" in 97 of 100 emails. Run with:
 *   npx tsx lib/services/revision-input.test.ts
 *
 * Cases below are real rows from draft_regeneration_jobs, trimmed.
 */
import { strict as assert } from "assert";
import { splitInstruction, customerProducts, DEFAULT_TEMPLATE_CHANGE } from "./revision-input";

const KUBER_PITCH =
  "I’m reaching out from Kuber Polyplast, an ISO 9001:2015 certified Indian manufacturer with 30 years " +
  "of experience in masterbatches and specialty compounds.\n\nI came across Butyl Products and wanted to " +
  "introduce our company and product range.\n\nWe can support with our Black Masterbatch, White Masterbatch, " +
  "Colour Masterbatch and Additive Masterbatch range, and help identify the best solution for your specific " +
  "requirements.\n\n- 18,000 MT annual production capacity\n- 6,670+ clients across 40+ countries\n" +
  "- 57,000+ unique formulations developed\n\nPlease let us know sir if you have any current requirements.";

// ── Pure instructions: never split, no matter what words they contain ────────
for (const plain of [
  "make it shorter",
  "don't write APOLLO - only write client company name",
  "Don’t write “Butyl Products” in every email. Write the customer’s exact company name and mention what they make.",
  // Contains "Dear c..." — the exact false positive the length+Kuber guards exist for.
  "never write this- ( write about customer company and their products for masterbatch )\n\nwrite actual client name instead of Dear cheris.",
  "everything is okay just write some more about of customer company ( around in one line extra)",
]) {
  const out = splitInstruction(plain);
  assert.equal(out.example, "", `must not split: ${plain.slice(0, 40)}`);
  assert.equal(out.change, plain.trim());
}

// ── Instruction followed by a pasted email: split at the opener ──────────────
const withPreamble = splitInstruction(
  "Write every email only like this, but make sure that when you write about “I came across your website”, " +
  "you also write about the customer’s company and their products\n\n" + KUBER_PITCH,
);
assert.ok(withPreamble.change.startsWith("Write every email only like this"));
assert.ok(!withPreamble.change.includes("Butyl Products"), "example must not leak into the change");
assert.ok(withPreamble.example.startsWith("I’m reaching out from Kuber Polyplast"));
assert.ok(withPreamble.example.includes("Butyl Products"));

// Run together with no newline — how the client actually types it.
const runOn = splitInstruction("WRITE ALL THE EMAIL ONLY LIKE THIS-" + KUBER_PITCH);
assert.equal(runOn.change, "WRITE ALL THE EMAIL ONLY LIKE THIS-");
assert.ok(runOn.example.startsWith("I’m reaching out"));

// ── Example email with no covering instruction: change falls back ────────────
const bare = splitInstruction("Dear (write client name),\n\n" + KUBER_PITCH);
assert.equal(bare.change, DEFAULT_TEMPLATE_CHANGE);
assert.ok(bare.example.startsWith("Dear (write client name),"));

// The 2,526-char paste that produced 97/100 "Astral Ltd" emails.
const ashish = splitInstruction(
  "Please make all the email like same, full email is mentined below \n\n" +
  "I hope this message finds you well.\nMy name is Ashish Sharma, and I lead the Europe Business Division " +
  "(Masterbatch) at Kuber Polyplast Pvt. Ltd., an ISO 9001:2015 certified and globally recognized masterbatch " +
  "manufacturer from India. With over three decades of expertise, Kuber Polyplast stands as a trusted partner " +
  "for high-performance color and additive solutions.\n\nOur Core Product Range:\n- White Masterbatches: Up to " +
  "80% TiO₂\n- Black Masterbatches: High jetness and UV stability\n- Colour Masterbatches: Over 10,000 shades\n\n" +
  "I would be delighted to schedule a brief MS Teams meeting to explore how Kuber Polyplast can add value to " +
  "Astral Ltd’ product line.\n\nWarm Regards\n\nAshish Sharma",
);
assert.equal(ashish.change, "Please make all the email like same, full email is mentined below");
assert.ok(ashish.example.startsWith("I hope this message finds you well."));
assert.ok(ashish.example.includes("Astral Ltd"), "the poisoned name stays quarantined in the example block");

// A long paste that never mentions Kuber is a content directive, not an email.
assert.equal(
  splitInstruction("reframe and write very precise and topic wise( key point) ".repeat(12)).example,
  "",
);

// ── customerProducts ────────────────────────────────────────────────────────
// Real Pipeco keywords: filler dropped, capped, real products kept.
const pipeco = customerProducts({
  keywords: [
    "b2b", "services", "grp water tanks", "manufacturing", "pressed steel water tanks",
    "construction", "sectional water tanks", "productivity", "water tank installation",
    "custom water tanks", "industrial water tanks", "water storage", "tank maintenance services",
    "water level indicators", "elevated tank structures", "distribution", "water supply",
  ],
  industry: "construction",
});
assert.ok(pipeco.startsWith("grp water tanks, pressed steel water tanks"));
assert.ok(!pipeco.includes("b2b") && !pipeco.includes("productivity"), "filler dropped");
assert.ok(pipeco.split(", ").length <= 12, "capped at 12");

// Nothing usable → fall back to industry, never to an empty string.
assert.equal(customerProducts({ keywords: ["b2b", "services"], industry: "automotive" }), "automotive");
assert.equal(customerProducts(null), "");

console.log("revision-input: all assertions passed");
