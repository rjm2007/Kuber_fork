/**
 * Gaps in, landing days out.
 *
 * The composer asks for the wait AFTER the previous email, and those waits
 * stack. Reading them as days-from-the-first-email instead is what turned the
 * client's intended 35-day sequence into a 104-day one and meant follow-up 2
 * was never sent. The day shown beside each row comes from cumulativeDays, so
 * these assertions are what keep that number honest.
 *
 *   node scripts/check-followup-schedule-preview.mjs
 */
import assert from "node:assert/strict";

// Mirrors lib/followup-schedule-preview.ts — the repo has no TypeScript runner.
function delayToDays(s) {
  const n = s.delay ?? 0;
  switch (s.delay_unit) {
    case "minutes": return n / (60 * 24);
    case "hours": return n / 24;
    default: return n;
  }
}
function cumulativeDays(steps) {
  let t = 0;
  return steps.map((s) => (t += delayToDays(s)));
}
const d = (n, u = "days") => ({ delay: n, delay_unit: u });

// The client's real ladder, entered as GAPS, must land on their intended days.
assert.deepEqual(cumulativeDays([d(7), d(7), d(7), d(7), d(7)]), [7, 14, 21, 28, 35]);

// The same numbers read as a running total is the mistake: 7/14/21 as gaps
// lands on 7, 21, 42 — which is what was actually configured and sent.
assert.deepEqual(cumulativeDays([d(7), d(14), d(21)]), [7, 21, 42]);

// Campaign 1's uneven ladder round-trips too.
assert.deepEqual(cumulativeDays([d(11), d(7), d(7), d(3), d(7)]), [11, 18, 25, 28, 35]);

// A trailing zero-delay step lands on the same day as the one before it.
assert.deepEqual(cumulativeDays([d(7), d(7), d(0)]), [7, 14, 14]);

// Sub-day units convert rather than rounding to zero.
assert.deepEqual(cumulativeDays([d(12, "hours"), d(12, "hours")]), [0.5, 1]);
assert.deepEqual(cumulativeDays([d(1440, "minutes")]), [1]);

// A missing unit means days.
assert.deepEqual(cumulativeDays([{ delay: 3 }]), [3]);
// An empty ladder is not an error.
assert.deepEqual(cumulativeDays([]), []);

console.log("ok — follow-up schedule preview");
