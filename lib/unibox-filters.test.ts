/**
 * Self-check for the Unibox filters — which conversations a user can see.
 * Run with:
 *   npx tsx lib/unibox-filters.test.ts
 *
 * The rule that matters most: no conversation may fall through every filter.
 * A thread that matches nothing is unreachable, and an unreachable thread with
 * a waiting prospect is the worst outcome this app has.
 */
import { strict as assert } from "assert";
import {
  campaignMatches,
  matchesInterestFilter,
  matchesReadState,
  matchesTab,
  type ThreadFilterState,
  type UniboxReadState,
} from "./unibox-filters";

const state = (o: Partial<ThreadFilterState> = {}): ThreadFilterState => ({
  unread_count: 0,
  has_reply: false,
  needs_reply: false,
  ...o,
});

// ─── The four real shapes a thread can have ──────────────────────────────────
const outboundOnly   = state({ has_reply: false, needs_reply: false });                    // sent, never answered
const waitingOnUs    = state({ has_reply: true,  needs_reply: true, unread_count: 1 });    // they wrote, we haven't
const fullyAnswered  = state({ has_reply: true,  needs_reply: false });                    // everyone answered
// THE regression: prospect + CC'd colleague both wrote, we answered only the
// colleague. Newest message is outbound, so the old rule called this "replied".
const partlyAnswered = state({ has_reply: true,  needs_reply: true, unread_count: 0 });

assert.equal(matchesReadState("no_reply", outboundOnly), true);
assert.equal(matchesReadState("replied", outboundOnly), false, "never answered is not 'replied'");
assert.equal(matchesReadState("needs_reply", outboundOnly), false, "nobody asked us anything");

assert.equal(matchesReadState("needs_reply", waitingOnUs), true);
assert.equal(matchesReadState("replied", waitingOnUs), false);
assert.equal(matchesReadState("no_reply", waitingOnUs), false);

assert.equal(matchesReadState("replied", fullyAnswered), true);
assert.equal(matchesReadState("needs_reply", fullyAnswered), false);

// The one that used to disappear from the queue.
assert.equal(matchesReadState("needs_reply", partlyAnswered), true, "prospect still unanswered");
assert.equal(matchesReadState("replied", partlyAnswered), false, "not replied while someone waits");

// ─── Read / unread is its own axis and must not disturb the others ───────────
assert.equal(matchesReadState("unread", state({ unread_count: 3 })), true);
assert.equal(matchesReadState("read", state({ unread_count: 3 })), false);
assert.equal(matchesReadState("unread", state({ unread_count: 0 })), false);
assert.equal(matchesReadState("read", state({ unread_count: 0 })), true);
// A thread can be read AND still owe someone a reply.
assert.equal(matchesReadState("read", partlyAnswered), true);
assert.equal(matchesReadState("needs_reply", partlyAnswered), true);

// ─── Nothing is unreachable ──────────────────────────────────────────────────
const ALL: UniboxReadState[] = ["unread", "read", "replied", "needs_reply", "no_reply"];
for (const t of [outboundOnly, waitingOnUs, fullyAnswered, partlyAnswered]) {
  assert.ok(ALL.some((f) => matchesReadState(f, t)), `thread matches no filter: ${JSON.stringify(t)}`);
  // read/unread are exact complements — exactly one must hold, always.
  assert.equal(
    Number(matchesReadState("read", t)) + Number(matchesReadState("unread", t)),
    1,
    "read and unread must partition every thread",
  );
}
// Over threads that have a reply, needs_reply and replied are complements too.
for (const t of [waitingOnUs, fullyAnswered, partlyAnswered]) {
  assert.equal(
    Number(matchesReadState("needs_reply", t)) + Number(matchesReadState("replied", t)),
    1,
    "needs_reply and replied must partition answered threads",
  );
}
// An unknown filter value shows everything rather than emptying the inbox.
assert.equal(matchesReadState("bogus" as UniboxReadState, outboundOnly), true);

// ─── Primary / Others ────────────────────────────────────────────────────────
const msg = (o: Partial<{ is_focused: boolean; is_auto_reply: boolean }> = {}) =>
  ({ is_focused: true, is_auto_reply: false, ...o });

assert.equal(matchesTab("primary", msg()), true);
assert.equal(matchesTab("others", msg()), false);
// Auto-replies are Others even when Instantly focused them — they never count
// as someone waiting on us.
assert.equal(matchesTab("primary", msg({ is_auto_reply: true })), false);
assert.equal(matchesTab("others", msg({ is_auto_reply: true })), true);
// Unattributed mail Instantly could not tie to a lead.
assert.equal(matchesTab("primary", msg({ is_focused: false })), false);
assert.equal(matchesTab("others", msg({ is_focused: false })), true);
// Complements: every message is in exactly one tab.
for (const m of [msg(), msg({ is_auto_reply: true }), msg({ is_focused: false }), msg({ is_focused: false, is_auto_reply: true })]) {
  assert.equal(Number(matchesTab("primary", m)) + Number(matchesTab("others", m)), 1);
}

// ─── Instantly status ────────────────────────────────────────────────────────
assert.equal(matchesInterestFilter(1, 1), true);
assert.equal(matchesInterestFilter(1, 2), false);
// "Lead" is Instantly's unclassified state — null, not zero. 0 is Out of office.
assert.equal(matchesInterestFilter("lead", null), true);
assert.equal(matchesInterestFilter("lead", 0), false);
assert.equal(matchesInterestFilter(0, 0), true);
// Negative values are real statuses (not interested / wrong person).
assert.equal(matchesInterestFilter(-1, -1), true);
assert.equal(matchesInterestFilter(-1, null), false);

// ─── Campaign scope ──────────────────────────────────────────────────────────
assert.equal(campaignMatches("c1", {}), true, "no filter shows everything");
assert.equal(campaignMatches(null, {}), true);
assert.equal(campaignMatches("c1", { campaign_id: "c1" }), true);
assert.equal(campaignMatches("c2", { campaign_id: "c1" }), false);
assert.equal(campaignMatches("c2", { campaign_ids: ["c1", "c2"] }), true);
assert.equal(campaignMatches("c3", { campaign_ids: ["c1", "c2"] }), false);
// An unmapped thread can never satisfy an explicit campaign filter.
assert.equal(campaignMatches(null, { campaign_ids: ["c1"] }), false);
assert.equal(campaignMatches(null, { campaign_id: "c1" }), false);
// An empty id list is "no filter", not "match nothing" — otherwise clearing the
// campaign picker would empty the whole inbox.
assert.equal(campaignMatches("c1", { campaign_ids: [] }), true);

console.log("unibox-filters: all filter checks passed");
