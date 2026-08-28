/**
 * Stop starting work there is no time to finish.
 *
 * The flat 40s budget was tuned to the 6.2s average call and stranded the
 * 10.5s ones: a draft starting at 39.9s finished at 50.4s, leaving under five
 * seconds for the self-chain kickoff, and a cold start tipped it over. Three
 * drafts were left mid-flight and later marked failed with no reason recorded.
 *
 *   node scripts/check-batch-budget.mjs
 */
import assert from "node:assert/strict";

const TAIL_RESERVE_MS = 6_000;
const COLD_ESTIMATE_MS = 11_000;

class BatchBudget {
  constructor(ceilingMs = 55_000, now = () => Date.now()) {
    this.ceilingMs = ceilingMs;
    this.now = now;
    this.startedAt = now();
    this.slowestMs = 0;
  }
  hasRoomForAnother() {
    const elapsed = this.now() - this.startedAt;
    const expected = Math.max(this.slowestMs, COLD_ESTIMATE_MS);
    return elapsed + expected + TAIL_RESERVE_MS <= this.ceilingMs;
  }
  observe(ms) { this.slowestMs = Math.max(this.slowestMs, ms); }
}

// A fake clock, so the assertions are about the arithmetic and not the machine.
let t = 0;
const clock = () => t;
const b = new BatchBudget(55_000, clock);

// Fresh budget: room for a call, using the cautious cold estimate.
assert.equal(b.hasRoomForAnother(), true);

// Fast calls keep the estimate at the cold floor, not below it — guessing low
// is what strands a call.
t = 12_000; b.observe(2_100);
assert.equal(b.hasRoomForAnother(), true);       // 12 + 11 + 6 = 29 <= 55

// Once a slow call is seen, the estimate rises and the door closes earlier.
t = 30_000; b.observe(10_500);
assert.equal(b.hasRoomForAnother(), true);       // 30 + 10.5 + 6 = 46.5 <= 55
t = 39_000;
assert.equal(b.hasRoomForAnother(), false);      // 39 + 10.5 + 6 = 55.5 > 55

// This is the case that actually broke: the OLD flat rule allowed a start at
// 39.9s, which the measured budget refuses.
const old = (elapsed) => elapsed <= 40_000;
assert.equal(old(39_900), true);
t = 39_900;
assert.equal(b.hasRoomForAnother(), false);

// The tail reserve is what protects the self-chain: without it, a batch could
// finish its last call exactly at the ceiling and never kick off the next one.
t = 44_000; 
assert.equal(b.hasRoomForAnother(), false);      // 44 + 10.5 > 55 - 6

console.log("ok — batch budget");
