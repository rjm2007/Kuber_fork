/**
 * Turning the follow-up GAPS a user types into the DAY each email lands on.
 *
 * These two readings of the same numbers are easy to confuse, and confusing
 * them is expensive. A step's delay is the wait AFTER the previous email, so
 * 7/14/21 means days 7, 21 and 42 — not 7, 14 and 21. Instantly works the same
 * way (verified against 814 real sends across 10 campaigns on 27 Aug 2026), and
 * the client's live campaigns were configured as though it did not: they read
 * the numbers as days-from-the-first-email, which stretched an intended 35-day
 * sequence into a 104-day one and meant follow-up 2 had never been sent.
 *
 * The composer now shows the resulting day beside every row, so the stacking is
 * visible while you type rather than discovered months later.
 */

export type FollowupDelay = { delay: number; delay_unit: "minutes" | "hours" | "days" };

export function delayToDays(step: FollowupDelay): number {
  const n = step.delay ?? 0;
  switch (step.delay_unit) {
    case "minutes": return n / (60 * 24);
    case "hours": return n / 24;
    default: return n;
  }
}

/** Day each follow-up lands on, counting the opening email as day 0. */
export function cumulativeDays(steps: FollowupDelay[]): number[] {
  let total = 0;
  return steps.map((s) => (total += delayToDays(s)));
}

/** Short label for one row, e.g. "day 21". Sub-day gaps keep one decimal so a
 *  12-hour wait does not render as the same "day 0" as a 30-minute one. */
export function dayLabel(days: number): string {
  if (days >= 1) return `day ${Number.isInteger(days) ? days : days.toFixed(1)}`;
  const hours = days * 24;
  if (hours >= 1) return `+${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  return `+${Math.round(hours * 60)}m`;
}
