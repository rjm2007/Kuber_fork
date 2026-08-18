/**
 * Self-check for the delivery model — the one place that decides whether a lead
 * is still waiting in Instantly's drip, has actually been mailed, or ended in a
 * more specific outcome. Run with:
 *   npx tsx lib/campaign-status.test.ts
 */
import { strict as assert } from "assert";
import { campaignOutcomes, computeCampaignStats, deliveryBucket, deliveryLabel, sequenceStepLabel } from "./campaign-status";

const DELIVERED = "2026-08-12T00:00:00Z";

// crm_status='sent' is the hand-off to Instantly, NOT a delivery.
assert.equal(deliveryBucket({ crm_status: "sent" }), "sending");
// Only the email_sent webhook (→ first_sent_at) promotes it.
assert.equal(deliveryBucket({ crm_status: "sent", first_sent_at: DELIVERED }), "sent");

// 'failed' means two opposite things; first_sent_at is the only thing that
// separates "we mailed them and it bounced" from "it was never sent at all".
assert.equal(deliveryBucket({ crm_status: "failed", first_sent_at: DELIVERED }), "bounced");
assert.equal(deliveryBucket({ crm_status: "failed", first_sent_at: null }), "send_failed");

// A replied lead is replied, not also sent — the buckets are exclusive.
assert.equal(deliveryBucket({ crm_status: "replied", first_sent_at: DELIVERED }), "replied");

// Never handed to Instantly at all.
assert.equal(deliveryBucket({ crm_status: "draft" }), "not_queued");
assert.equal(deliveryBucket({ crm_status: "approved" }), "not_queued");

// The tiles must not double-count: one replied and one bounced lead leave the
// sent figure, but both still count as delivered (the mail did reach them).
const stats = computeCampaignStats([
  { crm_status: "sent",    first_sent_at: DELIVERED, email_drafts: { status: "sent" } },
  { crm_status: "sent",    first_sent_at: DELIVERED, email_drafts: { status: "sent" } },
  { crm_status: "replied", first_sent_at: DELIVERED, email_drafts: { status: "sent" } },
  { crm_status: "failed",  first_sent_at: DELIVERED, email_drafts: { status: "sent" } },
  { crm_status: "sent",    first_sent_at: null,      email_drafts: { status: "sent" } }, // still queued
  { crm_status: "draft",   first_sent_at: null,      email_drafts: { status: "draft" } },
]);
assert.deepEqual(stats, {
  total_leads: 6,
  sent_count: 2,
  delivered_count: 4,
  replied_count: 1,
  bounced_count: 1,
  hot_count: 0,
  cold_count: 0,
});
// The three outcome tiles account for every delivered mail exactly once.
assert.equal(stats.sent_count + stats.replied_count + stats.bounced_count, stats.delivered_count);

// The stored-counter split must agree with the row-by-row tally above.
assert.deepEqual(
  campaignOutcomes({ sent_count: 4, replied_count: 1, bounced_count: 1 }),
  { sent: 2, delivered: 4, replied: 1, bounced: 1 },
);
// Counter drift must never render a negative tile.
assert.equal(campaignOutcomes({ sent_count: 0, replied_count: 2 }).sent, 0);

console.log("campaign-status: all delivery checks passed");

// ── Follow-up badge ──────────────────────────────────────────────────────────
// first_sent_at is stamped once, on the opening mail, and never moves again, so
// the step number is the ONLY thing that can tell a lead three follow-ups deep
// from one that was contacted this morning.
assert.equal(deliveryLabel({ crm_status: "sent", first_sent_at: DELIVERED }), "Sent 🤝");
assert.equal(deliveryLabel({ crm_status: "sent", first_sent_at: DELIVERED, last_step_sent: 1 }), "Sent 🤝");
// Instantly step N is follow-up N-1: step 2 is the FIRST follow-up.
assert.equal(deliveryLabel({ crm_status: "sent", first_sent_at: DELIVERED, last_step_sent: 2 }), "Follow-up 1 sent");
assert.equal(deliveryLabel({ crm_status: "sent", first_sent_at: DELIVERED, last_step_sent: 4 }), "Follow-up 3 sent");

// A campaign holding a single follow-up simply never produces a step 3, so the
// badge tops out at "Follow-up 1 sent" on its own — there is no cap to set.

// Still queued in the drip: no step has landed, so no follow-up may be claimed.
assert.equal(deliveryLabel({ crm_status: "sent", last_step_sent: null }), "Sending");
// More specific endings keep their own label even when a follow-up triggered
// them — which step it was is timeline detail, not the headline.
assert.equal(deliveryLabel({ crm_status: "replied", first_sent_at: DELIVERED, last_step_sent: 3 }), "Replied");
assert.equal(deliveryLabel({ crm_status: "failed", first_sent_at: DELIVERED, last_step_sent: 2 }), "Bounced");

// Which mail the address rejected. Dead from the start (never chased again)...
assert.equal(deliveryLabel({ crm_status: "failed", first_sent_at: DELIVERED, bounced_step: 1 }), "Bounced");
assert.equal(deliveryLabel({ crm_status: "failed", first_sent_at: DELIVERED }), "Bounced");
// ...versus a mailbox that was alive for the opening mail and gone by the
// follow-up. Same red badge before; only this one is worth rechecking the contact.
assert.equal(
  deliveryLabel({ crm_status: "failed", first_sent_at: DELIVERED, last_step_sent: 2, bounced_step: 2 }),
  "Bounced on follow-up 1",
);
// A send that never left cannot have bounced on anything.
assert.equal(deliveryLabel({ crm_status: "failed", first_sent_at: null, bounced_step: 2 }), "Send failed");

// ── Sequence step naming ─────────────────────────────────────────────────────
// Instantly's "sequence_step_variant"; the middle segment is a ZERO-based step.
assert.equal(sequenceStepLabel("0_0_0"), "Opening email");
assert.equal(sequenceStepLabel("0_1_0"), "Follow-up 1");
assert.equal(sequenceStepLabel("0_3_0"), "Follow-up 3");
// reply_events.step is a plain ONE-based number and must land on the same name.
assert.equal(sequenceStepLabel(1), "Opening email");
assert.equal(sequenceStepLabel(2), "Follow-up 1");
assert.equal(sequenceStepLabel("2"), "Follow-up 1");
// A manual reply is not a sequence step — no badge at all.
assert.equal(sequenceStepLabel(null), null);
assert.equal(sequenceStepLabel(undefined), null);
assert.equal(sequenceStepLabel(""), null);
assert.equal(sequenceStepLabel("nonsense"), null);
