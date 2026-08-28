import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthedUser } from "@/lib/auth/api-auth";
import { BULK_REGENERATABLE_STATUSES } from "@/lib/services/regenerate-draft";

export type RegenerationTarget = {
  campaign_lead_id: string;
  lead_id: string;
  draft_id: string;
  draft_status: string;
};

export type RegenerationTargets = {
  eligible: RegenerationTarget[];
  /** Why the rest were left out — shown in the confirm modal so the user knows what is protected. */
  skipped: { certified: number; sent: number; no_draft: number; other: number };
};

export type RegenerationJob = {
  id: string;
  campaign_id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  step_number: number;
  custom_instruction: string | null;
  total: number;
  succeeded: number;
  failed: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const JOB_COLUMNS =
  "id, campaign_id, status, step_number, custom_instruction, total, succeeded, failed, created_at, started_at, finished_at";

type LeadRef = { id: string; assigned_to: string | null } | { id: string; assigned_to: string | null }[] | null;
export type DraftRef = { id: string; status: string; step_number: number } | { id: string; status: string; step_number: number }[] | null;

function unwrap<T>(raw: T | T[] | null): T | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

/** The draft belonging to one step. Supabase returns the embed as an array when
 *  a lead has more than one draft, and as an object when it has exactly one. */
export function draftsForStep(raw: DraftRef, stepNumber: number) {
  if (!raw) return null;
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.find((d) => (d.step_number ?? 1) === stepNumber) ?? null;
}

/**
 * Which draft statuses a bulk run may overwrite, for a given step.
 *
 * Step 1 keeps the strict list: 'approved' there means a human read the email
 * and certified it, and one bulk click must not undo 200 of those decisions.
 *
 * Follow-ups are different by design. The client agreed on 21 Aug 2026 that
 * follow-ups are not certified, so write-followups marks every one 'approved'
 * the moment it is written — that status carries no human judgement at all.
 * Excluding it would leave the follow-up "Regenerate all" permanently reporting
 * zero eligible drafts. 'sent' stays excluded at every step: what the customer
 * already received cannot be rewritten.
 */
export function bulkRegeneratableStatuses(stepNumber: number): readonly string[] {
  return stepNumber > 1
    ? [...BULK_REGENERATABLE_STATUSES, "approved"]
    : BULK_REGENERATABLE_STATUSES;
}

/**
 * Which leads in a campaign a bulk regeneration may touch, for THIS caller.
 *
 * Eligibility is deliberately narrow (see BULK_REGENERATABLE_STATUSES): only a
 * live 'draft' or 'failed' draft. Certified and Sent work is protected from a
 * single 200-lead click, and a lead with no draft at all belongs to the
 * generate flow, not the regenerate one.
 *
 * Employees are additionally restricted to leads assigned to them, matching the
 * access model in lib/auth/scope.ts — a campaign is a shared container, so
 * "regenerate all" must never reach into a co-worker's leads. This resolution
 * runs server-side for both the preview counts and the enqueue, so ids posted
 * by a client are filtered, not trusted.
 */
export async function resolveRegenerationTargets(
  db: SupabaseClient,
  user: AuthedUser,
  campaignId: string,
  opts: { stepNumber?: number; campaignLeadIds?: string[] } = {},
): Promise<RegenerationTargets> {
  const stepNumber = opts.stepNumber ?? 1;

  const { data: rows } = await db
    .from("campaign_leads")
    .select(`
      id, lead_id,
      leads!lead_id!inner(id, assigned_to),
      email_drafts(id, status, step_number)
    `)
    .eq("campaign_id", campaignId)
    .eq("leads.is_deleted", false);

  // FOLLOW-UPS CANNOT COME FROM THE EMBED ABOVE. `email_drafts(...)` on
  // campaign_leads resolves through campaign_leads.draft_id — a one-to-one key
  // pointing at the OPENING email — so a step-2 run found no draft for anybody
  // and reported "no drafts are eligible", which reads as "everything is
  // already done". Fetched by (campaign, lead) instead, which is how follow-ups
  // are actually keyed.
  const followupDrafts = stepNumber > 1
    ? (await db
        .from("email_drafts")
        .select("id, lead_id, status, step_number")
        .eq("campaign_id", campaignId)
        .eq("step_number", stepNumber)
        .not("status", "in", "(rejected,failed)")
      ).data ?? []
    : [];
  const followupByLead = new Map(followupDrafts.map((d) => [d.lead_id as string, d]));

  const requested = opts.campaignLeadIds?.length ? new Set(opts.campaignLeadIds) : null;

  const eligible: RegenerationTarget[] = [];
  const skipped = { certified: 0, sent: 0, no_draft: 0, other: 0 };

  for (const row of rows ?? []) {
    const lead = unwrap(row.leads as LeadRef);
    if (!lead) continue;

    // Employee scope: own assigned leads only. Applied before the requested-id
    // filter so a hand-crafted request cannot widen it.
    if (user.role === "employee" && lead.assigned_to !== user.id) continue;

    if (requested && !requested.has(row.id)) continue;

    // Pick the draft for the step being regenerated, not whichever the embed
    // happened to return first. A lead with both an opening email and a
    // follow-up has several rows here, and taking [0] meant a step-2 run kept
    // finding the step-1 draft and counting it as "other" — the follow-up
    // Regenerate all found nothing at all.
    const draft = stepNumber > 1
      ? followupByLead.get(row.lead_id as string) ?? null
      : draftsForStep(row.email_drafts as DraftRef, stepNumber);
    if (!draft) {
      skipped.no_draft++;
      continue;
    }

    if (bulkRegeneratableStatuses(stepNumber).includes(draft.status)) {
      eligible.push({
        campaign_lead_id: row.id,
        lead_id: lead.id,
        draft_id: draft.id,
        draft_status: draft.status,
      });
      continue;
    }

    if (draft.status === "approved") skipped.certified++;
    else if (draft.status === "sent") skipped.sent++;
    else skipped.other++;
  }

  return { eligible, skipped };
}

/** The campaign's live job (queued/running), if any. */
export async function getActiveJob(
  db: SupabaseClient,
  campaignId: string,
  stepNumber = 1,
): Promise<RegenerationJob | null> {
  const { data } = await db
    .from("draft_regeneration_jobs")
    .select(JOB_COLUMNS)
    .eq("campaign_id", campaignId)
    .eq("step_number", stepNumber)
    .in("status", ["queued", "running"])
    .maybeSingle();
  return (data as RegenerationJob | null) ?? null;
}

/** The campaign's live job, else the most recent finished one (so the UI can report the outcome). */
export async function getLatestJob(
  db: SupabaseClient,
  campaignId: string,
  stepNumber = 1,
): Promise<RegenerationJob | null> {
  const active = await getActiveJob(db, campaignId, stepNumber);
  if (active) return active;

  const { data } = await db
    .from("draft_regeneration_jobs")
    .select(JOB_COLUMNS)
    .eq("campaign_id", campaignId)
    .eq("step_number", stepNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RegenerationJob | null) ?? null;
}

/** Remaining work for a job — what the worker chains on and the UI counts down. */
export async function countPendingItems(db: SupabaseClient, jobId: string): Promise<number> {
  const { count } = await db
    .from("draft_regeneration_job_items")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .in("status", ["pending", "running"]);
  return count ?? 0;
}
