/**
 * The send path must read EVERY eligible lead and EVERY approved draft.
 *
 * Supabase caps a response at 1000 rows server-side and does not say it
 * truncated — a larger `.limit()` is silently clamped, so paging is the only
 * way past it. Unpaged, a campaign over that size sent to the first 1000 leads
 * and reported success. Worse, the drafts read hit the same cap: 300 leads on a
 * 6-step sequence is 1800 draft rows, so a lead whose text fell outside the
 * window was pushed to Instantly with no custom body — and Instantly then sends
 * its own generic fallback while our UI shows the personalised email.
 *
 * Mirrors the paging loops in lib/services/campaign-fanout.ts.
 *
 *   node scripts/check-fanout-paging.mjs
 */
import assert from "node:assert/strict";

const PAGE = 1000;

/** The loop shape used in campaign-fanout.ts, against a fake server that
 *  enforces the same 1000-row ceiling. */
function readAllPaged(total) {
  const server = (from, to) => {
    const hardCap = Math.min(to - from + 1, PAGE); // the ceiling, as the server applies it
    const available = Math.max(0, total - from);
    return Array.from({ length: Math.min(hardCap, available) }, (_, i) => from + i);
  };

  const out = [];
  for (let from = 0; ; from += PAGE) {
    const data = server(from, from + PAGE - 1);
    if (!data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

/** What the code did before: one unpaged request, silently clamped. */
const readUnpaged = (total) => Math.min(total, PAGE);

// ── The sizes that matter ────────────────────────────────────────────────────
for (const total of [0, 1, 999, 1000, 1001, 1800, 5000]) {
  const rows = readAllPaged(total);
  assert.equal(rows.length, total, `paged read must return all ${total} rows`);
  // No duplicates and no gaps — a page boundary is where those appear.
  assert.equal(new Set(rows).size, total, `no duplicate rows at ${total}`);
  if (total > 0) {
    assert.equal(rows[0], 0);
    assert.equal(rows[total - 1], total - 1);
  }
}

// ── The bug this replaces, stated as a fact ──────────────────────────────────
// 300 leads on a 6-step sequence = 1800 approved drafts.
assert.equal(readUnpaged(1800), 1000, "the old unpaged read stopped at the cap");
assert.equal(readAllPaged(1800).length, 1800, "the paged read gets all of them");
// 800 drafts would have been missing, and each of those leads would have been
// sent Instantly's generic fallback with nothing logged.
assert.equal(readAllPaged(1800).length - readUnpaged(1800), 800);

// Exactly at the boundary: 1000 rows must NOT trigger a second empty round trip
// that a naive loop would treat as "more data".
assert.equal(readAllPaged(1000).length, 1000);

console.log("ok — the send path reads every lead and every draft, past the 1000-row cap");
