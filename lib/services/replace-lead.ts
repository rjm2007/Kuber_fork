import crypto from "crypto";

/** The bounced lead a replacement is being created from. */
export type BouncedLeadContext = {
  organization_id: string;
  assigned_to: string | null;
  country: string | null;
};

/** What the employee typed into the Replace dialog. */
export type ReplacementInput = {
  email: string;
  /** A person's first name, or the desk label for a shared inbox ("Sales Team"). */
  first_name: string;
  last_name?: string;
  title?: string;
};

/**
 * The row for a replacement contact, derived from the lead that bounced.
 *
 * Three fields are INHERITED rather than asked for or re-derived, and each for
 * a concrete reason:
 *   • organization_id — the whole point. The company is already enriched, so the
 *     replacement is campaign-ready the moment it lands (the compute_lead_status
 *     trigger reads the org's stage and returns 'enriched' on insert).
 *   • country — sendCampaign buckets leads into Instantly sub-campaigns by
 *     (country, sending mailbox). A null country would open a separate "Other"
 *     bucket instead of joining the one this campaign already sends from.
 *   • assigned_to — same bucket key, other half: the owner decides which mailbox
 *     the mail leaves from. An unassigned replacement would send from the company
 *     default, i.e. a different address than the thread that bounced.
 */
export function buildReplacementLead(
  src: BouncedLeadContext,
  input: ReplacementInput,
  userId: string,
) {
  const now = new Date().toISOString();
  return {
    email: input.email.trim().toLowerCase(),
    first_name: input.first_name.trim(),
    last_name: input.last_name?.trim() || null,
    title: input.title?.trim() || null,
    organization_id: src.organization_id,
    country: src.country,
    assigned_to: src.assigned_to,
    assigned_at: src.assigned_to ? now : null,
    lead_source: "manual",
    // Same shape the manual-add path mints — leads.apollo_id is NOT NULL and
    // unique, and this person was never in Apollo.
    apollo_id: `manual_${crypto.randomUUID()}`,
    created_by: userId,
    created_at: now,
  };
}
