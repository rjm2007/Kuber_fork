/**
 * Reading Instantly's step numbers, and deciding which "sent" signal is allowed
 * to start a lead's follow-up clock.
 *
 * Two formats reach us. The webhook sends a 1-based number (1 = opening email).
 * Synced mail carries Instantly's "{sequence}_{stepIndex}_{variant}" string,
 * where stepIndex is 0-based ("0_0_0" = opening, "0_1_0" = follow-up 1).
 */

/** 1-based step order from either format, or null when it cannot be read. */
export function stepOrderFromInstantly(step: string | number | null | undefined): number | null {
  if (step === null || step === undefined || step === "") return null;
  if (typeof step === "number") return Number.isFinite(step) && step >= 1 ? step : null;
  const parts = step.split("_");
  if (parts.length >= 2) {
    const index = Number(parts[1]);
    return Number.isFinite(index) && index >= 0 ? index + 1 : null;
  }
  const n = Number(step);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Whether a webhook email_sent signal may set campaign_leads.first_sent_at.
 *
 * Only the OPENING email's. Before 2026-09-10 any first-arriving signal did:
 * one lead's opening went out at 12:06 while the webhook was disabled, his
 * follow-up 1 signal arrived at 12:24, and 12:24 became his "first sent" - his
 * clock started 18 minutes late and the opening vanished from his history. A
 * signal with no step at all is still accepted, so a payload that omits it
 * behaves as it always did.
 */
export function isOpeningSignal(step: string | number | null | undefined): boolean {
  const n = stepOrderFromInstantly(step);
  return n === null || n === 1;
}

/**
 * The first_sent_at to record when synced mail shows an opening email left, or
 * null to leave the lead alone.
 *
 * The recovery path for a lost webhook signal: the email_sent webhook used to
 * be the ONLY thing that set first_sent_at, so one lost delivery left a lead
 * with no follow-up clock forever and its follow-ups went out as the generic
 * fallback. Now the synced copy of the opening email fills the gap.
 *
 * FILLS ONLY. It never overwrites an existing value, deliberately: the webhook
 * stamps arrival time with milliseconds while Instantly's copy is whole
 * seconds, so a "move it earlier" rule rewrote 959 correct leads by under a
 * second in a dry run, and pulled one re-sent lead's clock back a whole month.
 * With isOpeningSignal in place a lost opening signal leaves the value empty,
 * so filling is all the live path ever needs.
 */
export function openingSendToRecord(
  direction: string,
  step: string | number | null | undefined,
  sentAt: string | null | undefined,
  current: string | null | undefined,
): string | null {
  if (direction !== "sent_campaign" || !sentAt || current) return null;
  return stepOrderFromInstantly(step) === 1 ? sentAt : null;
}
