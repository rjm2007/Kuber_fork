/**
 * Self-check for the delivery model — the one place that decides whether a lead
 * is still waiting in Instantly's drip, has actually been mailed, or ended in a
 * more specific outcome. Run with:
 *   npx tsx lib/campaign-status.test.ts
 */
import { strict as assert } from "assert";
import { campaignOutcomes, computeCampaignStats, deliveryBucket } from "./campaign-status";

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
