/**
 * When each follow-up step falls due.
 *
 * Instantly's `delay` on a step is the wait AFTER that step, before the next
 * one. Reading it as "wait before this step" put every due date a whole step
 * late: with the client's 7/14/21 ladder, step 2 was computed for day 14 when
 * Instantly sends it on day 7, so the personalised follow-up was written a week
 * after Instantly had already sent the generic fallback.
 *
 *   node scripts/check-followup-due-dates.mjs
 */
import assert from "node:assert/strict";

// Mirrors lib/services/followup-schedule.ts. Copied so this runs under plain
// node — the repo has no TypeScript runner. Change it there, change it here.
function delayInDays(step) {
  const n = step.delay ?? 0;
  switch ((step.delay_unit ?? "days").toLowerCase()) {
    case "minutes": return n / (60 * 24);
    case "hours": return n / 24;
    default: return n;
  }
}
function followupDueAt(firstSentAt, steps, stepOrder) {
  if (!firstSentAt) return null;
  const base = new Date(firstSentAt);
  if (Number.isNaN(base.getTime())) return null;
  const totalDays = steps
    .filter((s) => s.step_order < stepOrder)
    .reduce((sum, s) => sum + delayInDays(s), 0);
  return new Date(base.getTime() + totalDays * 864e5);
}

const daysAfter = (due, sent) => (due - new Date(sent)) / 864e5;

// The client's real ladder, as Instantly holds it (verified via the API).
const ladder = [
  { step_order: 1, delay: 7, delay_unit: "days" },
  { step_order: 2, delay: 14, delay_unit: "days" },
  { step_order: 3, delay: 21, delay_unit: "days" },
];
const sent = "2026-08-01T00:00:00Z";

// Measured against 811 real send pairs: step 2 lands ~7 days after step 1,
// NOT 14. Step 1's delay is what schedules it.
assert.equal(daysAfter(followupDueAt(sent, ladder, 2), sent), 7);
// Step 3 waits step 2's delay on top of that: 7 + 14.
assert.equal(daysAfter(followupDueAt(sent, ladder, 3), sent), 21);

// Never sent means never due.
assert.equal(followupDueAt(null, ladder, 2), null);
assert.equal(followupDueAt("not a date", ladder, 2), null);

// Sub-day units still convert.
assert.equal(daysAfter(followupDueAt(sent, [{ step_order: 1, delay: 48, delay_unit: "hours" }], 2), sent), 2);
assert.equal(daysAfter(followupDueAt(sent, [{ step_order: 1, delay: 720, delay_unit: "minutes" }], 2), sent), 0.5);

// A missing unit means days; a missing delay means no wait.
assert.equal(daysAfter(followupDueAt(sent, [{ step_order: 1, delay: 3 }], 2), sent), 3);
assert.equal(daysAfter(followupDueAt(sent, [{ step_order: 1 }], 2), sent), 0);

// Steps arriving out of order must not change the sum.
assert.equal(daysAfter(followupDueAt(sent, [...ladder].reverse(), 3), sent), 21);

// The old bug, stated as a rule: step 2 must NOT be charged its own delay.
assert.notEqual(daysAfter(followupDueAt(sent, ladder, 2), sent), 14);

console.log("ok — follow-up due dates");
