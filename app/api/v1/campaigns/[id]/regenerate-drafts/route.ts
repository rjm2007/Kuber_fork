import { NextRequest, after } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { BulkRegenerateSchema } from "@/lib/validators/drafts";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { getActiveJob, resolveRegenerationTargets } from "@/lib/services/regeneration-jobs";
import { SERVICE_ROLE_USER_ID } from "@/lib/constants";
import { dbForUser } from "@/lib/supabase/scoped";

/**
 * Enqueue a bulk draft regeneration for a campaign.
 *
 * Body: { campaign_lead_ids?, custom_instruction?, step_number? }. Omitting the
 * ids means "all eligible" — the same code path either way, because the target
 * list is always resolved server-side under the caller's scope (an employee
 * only ever reaches their own assigned leads).
 *
 * Returns immediately: the actual work happens in /api/enrich/regenerate-drafts,
 * which processes small batches and self-chains until the job is done.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = BulkRegenerateSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const stepNumber = parsed.data.step_number;

  const existing = await getActiveJob(db, id, stepNumber);
  if (existing) {
    return fail(409, "CONFLICT", "A regeneration is already running for this campaign.");
  }

  // Rewriting every follow-up while Instantly is still sending is a race nobody
  // can win: the job takes minutes, sends continue throughout, and each one that
  // goes out mid-run carries the old text while the screen reports success.
  //
  // Checking each lead against Instantly first would be one HTTP call per lead —
  // a hundred calls for a hundred leads. Holding sending removes the race
  // outright instead of measuring it, and a hold is free: measured live, held
  // mail is delayed and released intact, never lost.
  //
  // Follow-ups only. Opening emails are regenerated before a campaign starts
  // sending, so the same gate there would block the normal drafting flow.
  if (stepNumber && stepNumber > 1) {
    const { data: campaignRow } = await db
      .from("campaigns")
      .select("status, sending_held_at")
      .eq("id", id)
      .maybeSingle();

    const sending = campaignRow?.status === "active" || campaignRow?.status === "processing";
    if (sending && !campaignRow?.sending_held_at) {
      return fail(
        409,
        "HOLD_REQUIRED",
        "Hold sending before regenerating every follow-up — otherwise some can go out with the old text while this runs.",
      );
    }
  }

  const { eligible, skipped } = await resolveRegenerationTargets(db, user, id, {
    stepNumber,
    campaignLeadIds: parsed.data.campaign_lead_ids,
  });

  if (eligible.length === 0) {
    return fail(400, "NO_TARGETS", "No drafts are eligible for regeneration.", { skipped });
  }

  const instruction = parsed.data.custom_instruction?.trim() || null;

  // requested_by has an FK to profiles, but the service-role bearer's caller id
  // is a synthetic all-zeros UUID with no profile row — writing it fails the
  // constraint outright. The sentinel isn't a person anyway, so null ("system")
  // is the honest value. Same treatment as lib/services/lead-events.ts.
  const requestedBy = user.id === SERVICE_ROLE_USER_ID ? null : user.id;

  const { data: job, error: jobErr } = await db
    .from("draft_regeneration_jobs")
    .insert({
      campaign_id: id,
      requested_by: requestedBy,
      step_number: stepNumber,
      custom_instruction: instruction,
      status: "queued",
      total: eligible.length,
    })
    .select("id")
    .single();

  // uq_draft_regen_active_job — someone else started a run between the check above
  // and this insert. Report it as the conflict it is rather than a 500.
  if (jobErr || !job) {
    if (jobErr?.code === "23505") {
      return fail(409, "CONFLICT", "A regeneration is already running for this campaign.");
    }
    return fail(500, "INTERNAL", jobErr?.message ?? "Failed to create regeneration job");
  }

  const { error: itemsErr } = await db.from("draft_regeneration_job_items").insert(
    eligible.map((t) => ({
      job_id: job.id,
      campaign_lead_id: t.campaign_lead_id,
      lead_id: t.lead_id,
      status: "pending",
    })),
  );

  if (itemsErr) {
    // Without items the job can never progress, and it would hold the
    // active-job unique index forever. Fail it immediately.
    await db.from("draft_regeneration_jobs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
    }).eq("id", job.id);
    return fail(500, "INTERNAL", itemsErr.message);
  }

  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    // after() keeps the function alive until the kickoff actually leaves the
    // machine — a plain un-awaited fetch can be dropped when the lambda freezes.
    after(async () => {
      await fetch(`${baseUrl}/api/enrich/regenerate-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ job_id: job.id }),
      }).catch(() => {});
    });
  }

  return ok({ job_id: job.id, total: eligible.length, skipped });
}

/** Preview counts for the confirm modal: what a run would touch, and what it would protect. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const url = new URL(req.url);
  const idsParam = url.searchParams.get("campaign_lead_ids");
  const campaignLeadIds = idsParam ? idsParam.split(",").filter(Boolean) : undefined;

  // Defaults to 1 so existing callers (the Outbox header) are unchanged; the
  // Sequences pane passes the follow-up step it is showing.
  const stepNumber = Number(url.searchParams.get("step_number") ?? 1) || 1;

  const { eligible, skipped } = await resolveRegenerationTargets(db, user, id, { campaignLeadIds, stepNumber });

  return ok({
    eligible: eligible.length,
    by_status: {
      draft: eligible.filter((t) => t.draft_status === "draft").length,
      failed: eligible.filter((t) => t.draft_status === "failed").length,
    },
    skipped,
  });
}
