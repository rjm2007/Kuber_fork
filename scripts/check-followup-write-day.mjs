/**
 * Follow-ups are written on the last WORKING day (IST) before they are due.
 *
 * The flat one-day lead time put every Sunday- and Monday-due follow-up in
 * front of a reviewer on a day the office is shut, and by Monday morning
 * Instantly is already sending. This is the arithmetic that fixes it.
 *
 * Mirrors writeByAt() in lib/services/followup-schedule.ts.
 *
 *   node scripts/check-followup-write-day.mjs
 */
import assert from "node:assert/strict";

const FOLLOWUP_LEAD_TIME_DAYS = 1;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayStart(at) {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted;
}
function isWorkingDay(istDay) {
  const dow = istDay.getUTCDay();
  return dow >= 1 && dow <= 5;
}
function writeByAt(dueAt) {
  const earliest = new Date(dueAt.getTime() - FOLLOWUP_LEAD_TIME_DAYS * 24 * 60 * 60 * 1000);
  const day = istDayStart(earliest);
  for (let i = 0; i < 7 && !isWorkingDay(day); i++) {
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return new Date(day.getTime() - IST_OFFSET_MS);
}

/** An IST wall-clock moment as a real UTC instant. */
const ist = (y, m, d, hh = 10, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS);

/** The IST calendar date of an instant, as "YYYY-MM-DD". */
const istDateOf = (at) =>
  new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// ── The weekend cases this exists for ────────────────────────────────────────
// August 2026: 29th is a Saturday, 30th Sunday, 31st Monday.

// Due Monday 31 Aug -> written from Friday 28 Aug, not Sunday 30th.
assert.equal(istDateOf(writeByAt(ist(2026, 8, 31, 11))), "2026-08-28");

// Due Sunday 30 Aug -> Friday 28th.
assert.equal(istDateOf(writeByAt(ist(2026, 8, 30, 11))), "2026-08-28");

// Due Saturday 29 Aug -> Friday 28th.
assert.equal(istDateOf(writeByAt(ist(2026, 8, 29, 11))), "2026-08-28");

// ── Ordinary midweek is unchanged: exactly one day of lead time ──────────────
// Due Tuesday 1 Sep -> Monday 31 Aug.
assert.equal(istDateOf(writeByAt(ist(2026, 9, 1, 11))), "2026-08-31");
// Due Friday 4 Sep -> Thursday 3 Sep.
assert.equal(istDateOf(writeByAt(ist(2026, 9, 4, 11))), "2026-09-03");

// ── The write-by moment is 00:00 IST of that day ─────────────────────────────
// So the sweep may write any time during the working day, not at some odd hour.
const by = writeByAt(ist(2026, 8, 31, 11));
assert.equal(new Date(by.getTime() + IST_OFFSET_MS).toISOString().slice(11, 19), "00:00:00");

// ── isDueForWriting behaviour ────────────────────────────────────────────────
const isDueForWriting = (dueAt, now) => now >= writeByAt(dueAt);

const dueMonday = ist(2026, 8, 31, 11);
// Thursday: too early, the reviewer would be looking at it 4 days out.
assert.equal(isDueForWriting(dueMonday, ist(2026, 8, 27, 12)), false);
// Friday morning: yes — this is the whole point.
assert.equal(isDueForWriting(dueMonday, ist(2026, 8, 28, 9)), true);
// Saturday, office shut, but already written by Friday's run — still true so a
// missed Friday run catches up rather than skipping the follow-up entirely.
assert.equal(isDueForWriting(dueMonday, ist(2026, 8, 29, 9)), true);
// Overdue must always be writable, or a missed run loses the follow-up.
assert.equal(isDueForWriting(dueMonday, ist(2026, 9, 5, 9)), true);

// ── An IST boundary that a naive UTC implementation gets wrong ───────────────
// 04:00 IST Monday is 22:30 UTC *Sunday*. Truncating in UTC would call this
// Sunday and step back to Friday a day early; in IST it is Monday, so the
// answer is still Friday — but via the Monday branch, not the weekend one.
assert.equal(istDateOf(writeByAt(ist(2026, 8, 31, 4))), "2026-08-28");
// And 23:00 IST Tuesday is 17:30 UTC the same day — no boundary crossed.
assert.equal(istDateOf(writeByAt(ist(2026, 9, 1, 23))), "2026-08-31");

console.log("ok — follow-ups are written on the last working day (IST)");
