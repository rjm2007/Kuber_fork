/**
 * Self-check for deliveryBucket — the one place that decides whether a lead is
 * still waiting in Instantly's drip or has actually been mailed. Run with:
 *   npx tsx lib/campaign-status.test.ts
 */
import { strict as assert } from "assert";
import { computeCampaignStats, deliveryBucket } from "./campaign-status";

// crm_status='sent' is the hand-off to Instantly, NOT a delivery.
assert.equal(deliveryBucket({ crm_status: "sent" }), "sending");
// Only the email_sent webhook (→ contacted) promotes it.
assert.equal(deliveryBucket({ crm_status: "sent", contacted: true }), "sent");

// A bounce stands alone and outranks everything, including its own delivery.
assert.equal(deliveryBucket({ crm_status: "failed", contacted: true, bounced: true }), "bounced");
assert.equal(deliveryBucket({ crm_status: "replied", bounced: true }), "bounced");

// 'failed' without a bounce event = Instantly refused the lead; never sent.
assert.equal(deliveryBucket({ crm_status: "failed" }), "send_failed");

// A reply outranks a plain delivery.
assert.equal(deliveryBucket({ crm_status: "replied", contacted: true }), "replied");

// Never handed to Instantly at all.
assert.equal(deliveryBucket({ crm_status: "draft" }), "not_queued");
assert.equal(deliveryBucket({ crm_status: "approved" }), "not_queued");

// The employee-scoped sent_count must count DELIVERED leads, matching what
// campaigns.sent_count is reconciled from. Deriving it from the draft status
// would report 3 here — every lead merely queued at Instantly — and put an
// employee's card above the manager's for the same campaign.
assert.equal(
  computeCampaignStats([
    { crm_status: "sent", email_drafts: { status: "sent" }, first_sent_at: "2026-08-12T00:00:00Z" },
    { crm_status: "sent", email_drafts: { status: "sent" }, first_sent_at: null },
    { crm_status: "sent", email_drafts: { status: "sent" }, first_sent_at: null },
  ]).sent_count,
  1,
);

// A replied lead was necessarily delivered, so it still counts toward sent.
assert.deepEqual(
  computeCampaignStats([
    { crm_status: "replied", email_drafts: { status: "sent" }, first_sent_at: "2026-08-12T00:00:00Z" },
  ]),
  { total_leads: 1, sent_count: 1, replied_count: 1, hot_count: 0, cold_count: 0 },
);

console.log("campaign-status: all delivery bucket checks passed");
