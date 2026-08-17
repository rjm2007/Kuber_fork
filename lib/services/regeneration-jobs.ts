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
type DraftRef = { id: string; status: string; step_number: number } | { id: string; status: string; step_number: number }[] | null;

function unwrap<T>(raw: T | T[] | null): T | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
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
      id,
      leads!lead_id!inner(id, assigned_to),
      email_drafts(id, status, step_number)
    `)
    .eq("campaign_id", campaignId)
    .eq("leads.is_deleted", false);

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

    const draft = unwrap(row.email_drafts as DraftRef);
    if (!draft) {
      skipped.no_draft++;
      continue;
    }
    // campaign_leads.draft_id tracks step 1; other steps are not bulk-regenerated here.
    if ((draft.step_number ?? 1) !== stepNumber) {
      skipped.other++;
      continue;
    }

    if ((BULK_REGENERATABLE_STATUSES as readonly string[]).includes(draft.status)) {
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
