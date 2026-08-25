import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_ROLE_USER_ID } from "@/lib/constants";

type Db = SupabaseClient;

/**
 * `actor_id` has an FK to profiles, but the service-role bearer's caller id is a
 * synthetic all-zeros UUID with no profile row — writing it fails the constraint,
 * and since logging is fire-and-forget the whole event would vanish silently.
 * The sentinel isn't a person anyway, so null ("system") is the honest value.
 */
function normalizeActorId(actorId: string | null | undefined): string | null {
  if (!actorId || actorId === SERVICE_ROLE_USER_ID) return null;
  return actorId;
}

// Clean, human-readable per-lead activity timeline shown in the lead drawer —
// deliberately separate from enrichment_logs (the raw org-scrape debug trail
// full of HTTP 402 dumps). Only meaningful, user-facing milestones land here.
export type LeadEventType =
  | "created"
  | "enriched"
  | "enrichment_failed"
  | "assigned"
  | "reassigned"
  | "unassigned"
  | "added_to_campaign"
  | "removed_from_campaign"
  | "draft_created"
  | "draft_failed"
  | "draft_approved"
  | "draft_rejected"
  | "draft_edited"
  | "draft_reopened"
  | "draft_sent"
  // Outreach outcomes reported by Instantly's webhook. `draft_sent` above is us
  // handing the lead TO Instantly; `email_delivered` is Instantly confirming it
  // actually went out — they can be minutes or hours apart, so both are logged.
  | "email_delivered"
  | "email_opened"
  | "email_bounced"
  | "reply_received"
  | "interest_changed"
  | "unsubscribed"
  | "status_changed"
  // A bounced contact's identity (name/email/title) was corrected in place —
  // same lead_id, so every campaign referencing it sees the correction too.
  // Distinct from status_changed: this is an identity edit, not a stage move.
  | "contact_corrected";

/**
 * Fire-and-forget: never let activity logging break the actual operation.
 * `detail` is the one-line summary rendered in the drawer.
 */
export async function logLeadEvent(
  db: Db,
  leadId: string,
  event: LeadEventType,
  detail: string,
  opts?: { actorId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    const { error } = await db.from("lead_events").insert({
      lead_id: leadId,
      event,
      detail,
      actor_id: normalizeActorId(opts?.actorId),
      metadata: opts?.metadata ?? null,
      created_at: new Date().toISOString(),
    });
    // Non-fatal, but not invisible: a silently-dropped timeline entry is how the
    // actor_id FK breakage went unnoticed in the first place.
    if (error) console.error(`[lead-events] failed to log "${event}" for lead ${leadId}: ${error.message}`);
  } catch (e) {
    /* activity logging must never throw into the caller */
    console.error(`[lead-events] failed to log "${event}" for lead ${leadId}:`, (e as Error).message);
  }
}

/** Bulk variant for logging the same event across many leads in one insert. */
export async function logLeadEvents(
  db: Db,
  rows: Array<{ leadId: string; event: LeadEventType; detail: string; actorId?: string | null; metadata?: Record<string, unknown> }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { error } = await db.from("lead_events").insert(
      rows.map((r) => ({
        lead_id: r.leadId,
        event: r.event,
        detail: r.detail,
        actor_id: normalizeActorId(r.actorId),
        metadata: r.metadata ?? null,
        created_at: new Date().toISOString(),
      })),
    );
    if (error) console.error(`[lead-events] failed to log ${rows.length} event(s): ${error.message}`);
  } catch (e) {
    /* non-fatal */
    console.error(`[lead-events] failed to log ${rows.length} event(s):`, (e as Error).message);
  }
}
