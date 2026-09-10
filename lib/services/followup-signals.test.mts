import { test } from "node:test";
import assert from "node:assert/strict";
import { stepOrderFromInstantly, isOpeningSignal, openingSendToRecord } from "./followup-signals.ts";

test("reads both step formats as 1-based order", () => {
  assert.equal(stepOrderFromInstantly(1), 1);          // webhook
  assert.equal(stepOrderFromInstantly(3), 3);
  assert.equal(stepOrderFromInstantly("0_0_0"), 1);    // synced mail
  assert.equal(stepOrderFromInstantly("0_1_0"), 2);
  assert.equal(stepOrderFromInstantly("0_2_1"), 3);    // A/B variant still step 3
  assert.equal(stepOrderFromInstantly("2"), 2);
  assert.equal(stepOrderFromInstantly(null), null);
  assert.equal(stepOrderFromInstantly("junk"), null);
});

test("only the opening email's signal may start the clock (issue 6)", () => {
  assert.equal(isOpeningSignal(1), true);
  assert.equal(isOpeningSignal(2), false);   // a follow-up 1 signal must NOT set first_sent_at
  assert.equal(isOpeningSignal(3), false);
  assert.equal(isOpeningSignal(null), true); // payload without a step behaves as before
});

test("synced opening email fills a missing first_sent_at (issue 4)", () => {
  assert.equal(openingSendToRecord("sent_campaign", "0_0_0", "2026-09-10T12:06:35Z", null), "2026-09-10T12:06:35Z");
});

test("never overwrites an existing first_sent_at", () => {
  // Webhook arrival (ms) vs Instantly's whole second: must not churn.
  assert.equal(openingSendToRecord("sent_campaign", "0_0_0", "2026-08-18T08:20:03Z", "2026-08-18T08:20:03.568Z"), null);
  // A later anchor is left alone too; the one-off repair handles that case with evidence.
  assert.equal(openingSendToRecord("sent_campaign", "0_0_0", "2026-09-10T12:06:35Z", "2026-09-10T12:24:37Z"), null);
});

test("ignores follow-ups and non-campaign mail", () => {
  assert.equal(openingSendToRecord("sent_campaign", "0_1_0", "2026-09-10T12:24:37Z", null), null);
  assert.equal(openingSendToRecord("received", "0_0_0", "2026-09-10T13:49:38Z", null), null);
  assert.equal(openingSendToRecord("sent_manual", null, "2026-09-10T13:56:57Z", null), null);
  assert.equal(openingSendToRecord("sent_campaign", "0_0_0", null, null), null);
});
