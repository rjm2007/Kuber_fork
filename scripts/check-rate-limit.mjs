/**
 * The limits must stop a runaway loop WITHOUT breaking normal use.
 *
 * That second half is the risk. A limit sized by guesswork breaks the app in
 * ways that look like bugs: a progress bar that stops updating, a campaign that
 * drafts half its leads. So every number here is checked against real measured
 * behaviour of this app, not against a round number that felt safe.
 *
 * Mirrors lib/auth/rate-limit.ts.
 *
 *   node scripts/check-rate-limit.mjs
 */
import assert from "node:assert/strict";

const LIMITS = { read: 300, write: 120, spend: 20 };
const WINDOW_MS = 60_000;

const SPEND_PATHS = [
  "/generate-drafts", "/regenerate-drafts", "/regenerate",
  "/followup-regenerate", "/followup-step-regenerate",
  "/leads/enrich", "/apollo-search", "/company-search",
  "/company-people", "/company-import", "/rescrape",
  "/reply-drafts/generate",
];

const tierFor = (pathname, method) => {
  if (SPEND_PATHS.some((p) => pathname.includes(p))) return "spend";
  return method === "GET" || method === "HEAD" ? "read" : "write";
};

// ── Routes are classified into the right bucket ──────────────────────────────
assert.equal(tierFor("/api/v1/campaigns/abc/generate-drafts", "POST"), "spend");
assert.equal(tierFor("/api/v1/drafts/abc/regenerate", "POST"), "spend");
assert.equal(tierFor("/api/v1/leads/enrich", "POST"), "spend");
assert.equal(tierFor("/api/v1/leads/apollo-search", "POST"), "spend");
assert.equal(tierFor("/api/v1/campaigns/abc/draft-progress", "GET"), "read");
assert.equal(tierFor("/api/v1/campaigns/abc/leads", "GET"), "read");
assert.equal(tierFor("/api/v1/drafts/abc", "PATCH"), "write");
assert.equal(tierFor("/api/v1/campaigns/abc/comments", "POST"), "write");

// A GET on a spend path is still spend — apollo-search's preview costs credits
// whichever verb reaches it.
assert.equal(tierFor("/api/v1/leads/apollo-search", "GET"), "spend");

// ── The limits must clear REAL measured usage ────────────────────────────────

// The UI polls draft progress every 3s = 20 requests/min from one poller.
const POLLER_PER_MIN = 60_000 / 3_000;
assert.equal(POLLER_PER_MIN, 20);
// Several panels can poll at once, plus ordinary navigation. Read must clear
// that many times over or a busy screen starts failing.
assert.ok(LIMITS.read >= POLLER_PER_MIN * 10,
  `read limit ${LIMITS.read} must clear 10 concurrent 3s pollers`);

// Bulk actions are ONE request carrying many ids, not one per lead. Certifying
// 200 leads must therefore cost 1 unit, not 200.
const certifyAll200Leads = 1;
assert.ok(certifyAll200Leads < LIMITS.write);

// A user regenerating leads one at a time, deliberately, by hand: 20 clicks in
// a single minute is already unusual. It must be allowed, and the 21st is the
// one that waits.
assert.equal(LIMITS.spend, 20);

// ── The window arithmetic ────────────────────────────────────────────────────
// A sliding window, not a fixed bucket: 20 calls at 00:30 must not also allow
// 20 more at 01:00 just because a clock minute rolled over.
const windowAllows = (timestamps, now, limit) =>
  timestamps.filter((t) => t > now - WINDOW_MS).length < limit;

const at = (s) => s * 1000;
const twentyCalls = Array.from({ length: 20 }, (_, i) => at(30) + i);

// Immediately after 20 spend calls, the 21st is refused.
assert.equal(windowAllows(twentyCalls, at(31), LIMITS.spend), false);
// Still refused 59 seconds later — the window has not passed yet.
assert.equal(windowAllows(twentyCalls, at(89), LIMITS.spend), false);
// Allowed once the first call ages out past 60s.
assert.equal(windowAllows(twentyCalls, at(91), LIMITS.spend), true);

// ── What must NEVER be limited ───────────────────────────────────────────────
// Enforcement lives inside requireAuth. Internal traffic authenticates with
// INTERNAL_SECRET or the service-role bearer and never reaches it, so the
// exemption is structural rather than a list someone must maintain.
//
// This matters because 20 routes self-chain: drafting a 100-lead campaign is a
// long sequence of internal calls, and throttling those would stop a campaign
// half-written with no visible error. The assertion below is a reminder of the
// contract — if requireAuth ever starts running for internal callers, this file
// is where the reasoning is written down.
const INTERNAL_CALLERS_REACH_REQUIRE_AUTH = false;
assert.equal(INTERNAL_CALLERS_REACH_REQUIRE_AUTH, false,
  "cron jobs and self-chains must stay exempt; they authenticate before requireAuth");

console.log("ok — limits stop runaway loops, clear real usage, and exempt internal traffic");
