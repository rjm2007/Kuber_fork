import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { safeSecretEqual } from "@/lib/auth/secret";
import { regenerateOneDraft } from "@/lib/services/regenerate-draft";
import { countPendingItems, bulkRegeneratableStatuses } from "@/lib/services/regeneration-jobs";

export const maxDuration = 55;

/**
 * Which draft this job item means, resolved NOW rather than at enqueue time —
 * the user may have edited, or the generator replaced it, during the minutes the
 * job sat queued.
 *
 * Step 1 follows campaign_leads.draft_id, which is the pointer to the live
 * opening email. That column tracks ONLY step 1, so a follow-up job must look
 * the draft up by (campaign, lead, step) instead. Using draft_id for a step-2
 * job would have quietly regenerated everyone's opening email when the user
 * clicked Regenerate all on a follow-up.
 */
async function resolveDraftId(
  db: ReturnType<typeof createScopedClient>,
  campaignId: string,
  item: { campaign_lead_id: string; lead_id: string },
  stepNumber: number,
): Promise<string | null> {
  if (stepNumber === 1) {
    const { data: cl } = await db
      .from("campaign_leads")
      .select("draft_id")
      .eq("id", item.campaign_lead_id)
      .maybeSingle();
    return (cl?.draft_id as string | null) ?? null;
  }

  // Excludes 'rejected', which are superseded historical versions rather than
  // the live draft for this step.
  const { data: draft } = await db
    .from("email_drafts")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("lead_id", item.lead_id)
    .eq("step_number", stepNumber)
    .neq("status", "rejected")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (draft?.id as string | null) ?? null;
}

// Regeneration is one LLM call per lead and the single-draft route budgets 60s
// for one of them, so five sequential calls is the safe ceiling for a 55s
// invocation. The job self-chains, so a small batch costs nothing but an extra
// round trip.
const BATCH_SIZE = 5;

/**
 * Batch worker for bulk draft regeneration.
 *
 * Claims a few pending items, regenerates each through the same routine the
 * single-draft route uses (so version history is identical), then re-triggers
 * itself until the job is finished. Mirrors /api/enrich/generate-drafts.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { job_id?: string };
  const jobId = body.job_id;
  if (!jobId) return Response.json({ error: "job_id required" }, { status: 400 });

  const db = createAdminClient();

  const { data: job } = await db
    .from("draft_regeneration_jobs")
    .select("id, campaign_id, status, custom_instruction, requested_by, succeeded, failed, company_id, step_number")
    .eq("id", jobId)
    .maybeSingle();

  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });

  // Internal trigger (shared secret, no user session): the job row supplies the
  // company, and everything below writes through a client scoped to it.
  const cdb = createScopedClient(job.company_id as string);

  // Cancelled between batches — stop without touching anything further.
  if (job.status === "cancelled" || job.status === "completed" || job.status === "failed") {
    return Response.json({ processed: 0, status: job.status });
  }

  const now = new Date().toISOString();
  if (job.status === "queued") {
    await cdb.from("draft_regeneration_jobs").update({
      status: "running",
      started_at: now,
      heartbeat_at: now,
    }).eq("id", jobId);
  }

  const { data: items } = await cdb
    .from("draft_regeneration_job_items")
    .select("id, campaign_lead_id, lead_id")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (!items || items.length === 0) {
    await finishJob(cdb, jobId);
    return Response.json({ processed: 0, status: "no_more_pending" });
  }

  await cdb
    .from("draft_regeneration_job_items")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .in("id", items.map((i) => i.id));

  let succeeded = 0;
  let failed = 0;

  const stepNumber = (job.step_number as number | null) ?? 1;

  for (const item of items) {
    const draftId = await resolveDraftId(cdb, job.campaign_id as string, item, stepNumber);

    if (!draftId) {
      await markItem(cdb, item.id, "skipped", "Lead no longer has a draft for this step");
      continue;
    }

    const result = await regenerateOneDraft(cdb, draftId, {
      userId: job.requested_by ?? undefined,
      customInstruction: job.custom_instruction ?? undefined,
      bulkJobId: jobId,
      // Re-checked per lead, not just at enqueue: a draft certified or sent
      // while the job was queued must not be overwritten by it. Follow-ups
      // widen this to include 'approved' — see bulkRegeneratableStatuses.
      allowedStatuses: bulkRegeneratableStatuses(stepNumber),
    });

    if (result.ok) {
      await markItem(cdb, item.id, "done", null);
      succeeded++;
    } else if (result.code === "CONFLICT") {
      await markItem(cdb, item.id, "skipped", result.reason);
    } else {
      await markItem(cdb, item.id, "failed", result.reason);
      failed++;
    }
  }

  const { data: fresh } = await cdb
    .from("draft_regeneration_jobs")
    .select("status, succeeded, failed")
    .eq("id", jobId)
    .maybeSingle();

  await cdb.from("draft_regeneration_jobs").update({
    succeeded: (fresh?.succeeded ?? 0) + succeeded,
    failed: (fresh?.failed ?? 0) + failed,
    heartbeat_at: new Date().toISOString(),
  }).eq("id", jobId);

  // Cancellation lands while a batch is in flight; honour it before chaining.
  if (fresh?.status === "cancelled") {
    return Response.json({ processed: items.length, succeeded, failed, status: "cancelled" });
  }

  const remaining = await countPendingItems(cdb, jobId);

  if (remaining > 0 && process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    // after() keeps the lambda alive until the next kickoff leaves the machine,
    // so a long run doesn't silently stop halfway.
    after(async () => {
      await fetch(`${baseUrl}/api/enrich/regenerate-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ job_id: jobId }),
      }).catch(() => {});
    });
  } else if (remaining === 0) {
    await finishJob(cdb, jobId);
  }

  return Response.json({ processed: items.length, succeeded, failed, remaining });
}

async function markItem(
  db: ReturnType<typeof createAdminClient>,
  itemId: string,
  status: "done" | "failed" | "skipped",
  error: string | null,
) {
  await db.from("draft_regeneration_job_items").update({
    status,
    error,
    updated_at: new Date().toISOString(),
  }).eq("id", itemId);
}

/** Close out a job, unless it was cancelled — that status is the user's, not ours to overwrite. */
async function finishJob(db: ReturnType<typeof createAdminClient>, jobId: string) {
  await db.from("draft_regeneration_jobs").update({
    status: "completed",
    finished_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}
