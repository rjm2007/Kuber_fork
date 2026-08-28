/**
 * Deciding whether there is time for one more LLM call before the lambda dies.
 *
 * Every batch worker here faces the same question and each answered it with a
 * flat number: "stop starting new work after 40 seconds". That is a guess about
 * the AVERAGE call, and it fails on the slow ones. Measured across 41 real
 * drafts on 28 Aug 2026: 6.2s average, 2.1s fastest, 10.5s slowest. A draft
 * that starts at 39.9s and runs for 10.5s finishes at 50.4s, leaving under five
 * seconds for the self-chain kickoff and the response — and on a cold start
 * that tips over. It did: a FUNCTION_INVOCATION_TIMEOUT stranded three drafts
 * mid-flight, which the watchdog later marked failed with no reason recorded.
 *
 * So the budget is measured instead of assumed. Each worker reports how long
 * its calls actually took, and the next one only starts if there is room for
 * another as slow as the slowest seen so far.
 */

/** Hard ceiling the platform enforces. Every route here sets maxDuration = 55. */
const LAMBDA_CEILING_MS = 55_000;

/**
 * Reserved for what happens AFTER the last call: writing results, kicking off
 * the next batch, returning a response. The self-chain lives here — losing it
 * does not just end this batch, it stops the whole campaign until something
 * else notices.
 */
const TAIL_RESERVE_MS = 6_000;

/**
 * Assumed cost of the first call, before there is any evidence. Deliberately
 * above the observed average: guessing high wastes at most one slot, guessing
 * low is what strands a call mid-flight.
 */
const COLD_ESTIMATE_MS = 11_000;

export class BatchBudget {
  private readonly startedAt = Date.now();
  private slowestMs = 0;

  constructor(private readonly ceilingMs: number = LAMBDA_CEILING_MS) {}

  /** True while there is room for another call as slow as the slowest so far. */
  hasRoomForAnother(): boolean {
    const elapsed = Date.now() - this.startedAt;
    const expected = Math.max(this.slowestMs, COLD_ESTIMATE_MS);
    return elapsed + expected + TAIL_RESERVE_MS <= this.ceilingMs;
  }

  /** Time one call. The duration feeds the estimate for the next decision. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.slowestMs = Math.max(this.slowestMs, Date.now() - t0);
    }
  }

  /** For logging: what the worker actually saw. */
  stats() {
    return { elapsedMs: Date.now() - this.startedAt, slowestMs: this.slowestMs };
  }
}
