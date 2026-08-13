/**
 * Self-check for partial schedule patches. Instantly REPLACES campaign_schedule
 * wholesale rather than deep-merging it, so anything left out of the payload is
 * wiped. This is the rule that stops "change the daily limit" from also
 * rewriting every country's timezone (docs/campaign-timezone-rca.md). Run with:
 *   npx tsx lib/services/instantly-schedule.test.ts
 */
import { strict as assert } from "assert";
import { mergeInstantlySchedule, type InstantlySchedule } from "./instantly";

// What Instantly currently holds for an India sub-campaign.
const LIVE: InstantlySchedule = {
  name: "Default",
  timing: { from: "10:00", to: "18:00" },
  days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
  timezone: "Asia/Kolkata",
};

// ── Only window_from changed → everything else survives ──────────────────────
const fromOnly = mergeInstantlySchedule(LIVE, { windowFrom: "11:00" });
assert.equal(fromOnly.timing?.from, "11:00");
assert.equal(fromOnly.timing?.to, "18:00", "window_to must not be blanked");
assert.equal(fromOnly.timezone, "Asia/Kolkata", "timezone must not be blanked");
assert.deepEqual(fromOnly.days, LIVE.days, "send days must not be blanked");
assert.equal(fromOnly.name, "Default");

// ── Only window_to changed ───────────────────────────────────────────────────
const toOnly = mergeInstantlySchedule(LIVE, { windowTo: "20:00" });
assert.equal(toOnly.timing?.from, "10:00");
assert.equal(toOnly.timing?.to, "20:00");
assert.equal(toOnly.timezone, "Asia/Kolkata");

// ── Only send days changed; named keys convert to Instantly's numeric keys ───
const daysOnly = mergeInstantlySchedule(LIVE, {
  sendDays: { monday: true, tuesday: false, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
});
assert.equal(daysOnly.days?.["2"], false, "Tuesday should be off");
assert.equal(daysOnly.days?.["1"], true);
assert.equal(daysOnly.timezone, "Asia/Kolkata", "timezone must not be blanked");
assert.equal(daysOnly.timing?.from, "10:00");
assert.equal(daysOnly.timing?.to, "18:00");

// ── The regression this whole fix exists for ─────────────────────────────────
// The Options screen sends window + days + limit and NO timezone. Germany must
// stay Germany.
const GERMANY: InstantlySchedule = { ...LIVE, timezone: "Europe/Bucharest" };
const optionsSave = mergeInstantlySchedule(GERMANY, {
  windowFrom: "10:00",
  windowTo: "18:00",
  sendDays: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false },
});
assert.equal(optionsSave.timezone, "Europe/Bucharest", "an Options save must never move a country's timezone");

// ── An explicit timezone change still works, and maps to Instantly's enum ────
const explicitTz = mergeInstantlySchedule(LIVE, { timezone: "Europe/Berlin" });
assert.equal(explicitTz.timezone, "Europe/Bucharest", "Europe/Berlin maps to Instantly's CET zone");
assert.equal(explicitTz.timing?.from, "10:00", "an explicit tz change must not move the window");
assert.deepEqual(explicitTz.days, LIVE.days);

// ── Several fields at once: all applied, nothing else touched ────────────────
const multi = mergeInstantlySchedule(LIVE, { windowFrom: "09:00", windowTo: "17:00" });
assert.equal(multi.timing?.from, "09:00");
assert.equal(multi.timing?.to, "17:00");
assert.equal(multi.timezone, "Asia/Kolkata");

// ── A campaign with no schedule yet still gets a usable one ──────────────────
const fresh = mergeInstantlySchedule({}, { windowFrom: "10:00", timezone: "Asia/Kolkata" });
assert.equal(fresh.name, "Default");
assert.equal(fresh.timing?.from, "10:00");
assert.equal(fresh.timezone, "Asia/Kolkata");

console.log("instantly-schedule: all assertions passed");
