/**
 * Self-check for the replacement-contact row. The three inherited fields are
 * what keep a replacement in the SAME Instantly sub-campaign and on the SAME
 * mailbox as the thread that bounced — get one wrong and the mail silently
 * leaves from another address. Run with:
 *   npx tsx lib/services/replace-lead.test.ts
 */
import { strict as assert } from "assert";
import { buildReplacementLead } from "./replace-lead";

const BOUNCED = {
  organization_id: "org-amazon",
  assigned_to: "employee-1",
  country: "United States",
};

const row = buildReplacementLead(
  BOUNCED,
  { email: "  Sales@Amazon.COM ", first_name: " Sales Team ", last_name: "  ", title: "Shared company inbox" },
  "manager-9",
);

// Inherited from the bounced lead — never re-derived, never asked for.
assert.equal(row.organization_id, "org-amazon");
assert.equal(row.country, "United States");
assert.equal(row.assigned_to, "employee-1");
assert.ok(row.assigned_at, "an assigned lead must carry assigned_at");

// Email is the identity key every lookup uses — always normalised.
assert.equal(row.email, "sales@amazon.com");

// A blank last name is null, not "" — "Sales Team " + "" must render as
// "Sales Team", and the drafter's greeting fallback reads first_name.
assert.equal(row.first_name, "Sales Team");
assert.equal(row.last_name, null);

// Never came from Apollo, but leads.apollo_id is NOT NULL + unique.
assert.match(row.apollo_id, /^manual_[0-9a-f-]{36}$/);
assert.equal(row.lead_source, "manual");
assert.equal(row.created_by, "manager-9");

// Pool lead (no owner) must not claim an assignment timestamp.
const pooled = buildReplacementLead(
  { ...BOUNCED, assigned_to: null },
  { email: "info@amazon.com", first_name: "Sales Team" },
  "manager-9",
);
assert.equal(pooled.assigned_to, null);
assert.equal(pooled.assigned_at, null);

console.log("replace-lead: all assertions passed");
