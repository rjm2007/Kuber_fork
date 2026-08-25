/**
 * The two rules that decide which draft a bulk regeneration rewrites.
 *
 * Both existed as bugs: a step-2 run picked whichever draft the Supabase embed
 * returned first (usually the OPENING email, which it would then have
 * rewritten), and 'approved' was excluded at every step, which made the
 * follow-up "Regenerate all" permanently report zero eligible.
 *
 *   node scripts/check-regen-step-targeting.mjs
 */
import assert from "node:assert/strict";

// Mirrors lib/services/regeneration-jobs.ts. Kept as a copy so this runs with
// plain node — the repo has no TypeScript runner. If either function changes
// there, change it here; that is the point of the check.
function draftsForStep(raw, stepNumber) {
  if (!raw) return null;
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.find((d) => (d.step_number ?? 1) === stepNumber) ?? null;
}
function bulkRegeneratableStatuses(stepNumber) {
  return stepNumber > 1 ? ["draft", "failed", "approved"] : ["draft", "failed"];
}

const opening = { id: "d1", status: "approved", step_number: 1 };
const followup = { id: "d2", status: "approved", step_number: 2 };

// A lead with both drafts: step 2 must reach the follow-up, never the opening email.
assert.equal(draftsForStep([opening, followup], 2).id, "d2");
assert.equal(draftsForStep([opening, followup], 1).id, "d1");
// Order must not matter — the embed gives no guarantee.
assert.equal(draftsForStep([followup, opening], 2).id, "d2");
// Single draft comes back as an object, not an array.
assert.equal(draftsForStep(opening, 1).id, "d1");
// No draft for that step is a skip, not a fallback to another step.
assert.equal(draftsForStep([opening], 2), null);
assert.equal(draftsForStep(null, 1), null);
// Legacy rows predate step_number and mean step 1.
assert.equal(draftsForStep([{ id: "d0", status: "draft" }], 1).id, "d0");

// Follow-ups are auto-approved by design, so 'approved' must be rewritable there.
assert.ok(bulkRegeneratableStatuses(2).includes("approved"));
// A certified opening email is a human decision and must survive a bulk click.
assert.ok(!bulkRegeneratableStatuses(1).includes("approved"));
// Nothing already delivered is ever rewritable.
assert.ok(!bulkRegeneratableStatuses(1).includes("sent"));
assert.ok(!bulkRegeneratableStatuses(2).includes("sent"));

console.log("ok — regen step targeting");
