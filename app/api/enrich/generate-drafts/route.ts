import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { after } from "next/server";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { safeSecretEqual } from "@/lib/auth/secret";
import {
  fetchDraftTargets,
  generateOneDraft,
  countPendingDrafts,
  logLlmUnavailable,
  logLlmRecovered,
  isProviderOutage,
} from "@/lib/services/generate-drafts";
import { hasUsableLlmKey } from "@/lib/services/provider-keys";

export const maxDuration = 55;

// Stop starting new drafts once this much of the budget is gone.
//
// The batch used to be a flat count of 10, and the self-chain that continues
// the campaign sits AFTER the loop. A draft takes ~6.4s against a 55s ceiling,
// so ten of them need ~64s: the lambda was killed partway through the ninth
// every single time, the chain kickoff was never reached, and generation
// stopped dead. Measured on the client's 100-lead campaign — 8 drafts written
// between 07:36:24 and 07:37:08, the ninth left stuck in "generating" at
// 07:37:15 (55.8s after start), then nothing. Every campaign over ~8 leads had
// been silently capping at 8.
//
// A time budget instead of a count means we never begin a draft we cannot
// finish, and the loop always exits with enough runway to hand off to the next
// invocation. It also self-adjusts if the model gets slower or faster.
const DRAFT_TIME_BUDGET_MS = 40_000;

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({})) as { campaign_id?: string; step_number?: number };
  const campaignId = body.campaign_id;
  const stepNumber = body.step_number ?? 1;
  if (!campaignId) {
    return Response.json({ error: "campaign_id required" }, { status: 400 });
  }

  const db = createAdminClient();

  // Self-heal: reset any stuck drafts/campaigns before proceeding
  try { await db.rpc("reset_stuck_draft_generation", { stale_minutes: 5 }); } catch { /* non-fatal */ }

  const { data: campaign } = await db
    .from("campaigns")
    .select("id, name, human_in_loop, status, ai_prompt_context, company_id")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }

  // This route is triggered internally (shared secret, no user session), so it
  // has no company of its own — the campaign it was handed supplies one. Every
  // draft, prompt read and lead update below goes through a client scoped to
  // it, which is also what stamps company_id on the email_drafts rows.
  const cdb = createScopedClient(campaign.company_id as string);

  // Pre-flight: never start work no provider will serve.
  //
  // Every trigger reaches generation through this route — the user's initial
  // "generate drafts", the self-chain below, and the watchdog — so one guard
  // here covers all three. Without it a dry key produced a failed email_drafts
  // row per lead at ~2.3s each, and three of those permanently capped the
  // lead: 20 of the 100 leads in ANKIT's APOLLO CAMPAIGN 1 were written off on
  // 7 Aug 2026 for an empty billing account that had nothing to do with them.
  //
  // Returning BEFORE fetchDraftTargets is the point. Bailing out later would
  // still have to decide what to do with leads already claimed; bailing here
  // means no lead is touched at all, so nothing needs forgiving afterwards.
  if (!(await hasUsableLlmKey(db, campaign.company_id as string))) {
    // Feeds the red service-health banner. reset_stuck_draft_generation above
    // has already released the campaign from 'processing', so the UI shows a
    // stopped campaign plus a banner saying why, instead of a silent stall.
    await logLlmUnavailable(
      cdb,
      null,
      "Every configured LLM key is out of credits or rejected — draft generation was not started.",
      { campaign_id: campaignId, step: stepNumber },
    );
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "llm_unavailable" });
  }

  // Only STEP-1 runs drive the campaign's status (draft ↔ processing). A
  // follow-up (step > 1) run happens on an already-ACTIVE campaign — flipping
  // its status here dragged live campaigns back to "Draft" in the UI
  // (planning.md Phase 6.4).
  const drivesStatus = stepNumber === 1;

  const targets = await fetchDraftTargets(cdb, campaignId, 10, stepNumber);

  if (targets.length === 0) {
    const pending = await countPendingDrafts(cdb, campaignId);
    if (pending === 0 && drivesStatus && campaign.status === "processing") {
      await cdb.from("campaigns").update({
        status: "draft",
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);
    }
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "no_more_pending" });
  }

  if (drivesStatus && ["draft", "processing"].includes(campaign.status)) {
    await cdb.from("campaigns").update({
      status: "processing",
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
  }

  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();
  let ranOutOfTime = false;
  let llmOutage = false;

  for (const target of targets) {
    if (Date.now() - startedAt > DRAFT_TIME_BUDGET_MS) { ranOutOfTime = true; break; }
    const result = await generateOneDraft(
      cdb,
      target,
      campaignId,
      campaign.human_in_loop,
      campaign.name,
      undefined,
      undefined,
      campaign.ai_prompt_context ?? undefined,
      undefined,
      stepNumber,
    );
    if (result.ok) { succeeded++; continue; }
    failed++;

    // The pre-flight above runs once per batch, so a key that dies on the
    // FIRST lead still leaves nine more to be attempted against a provider we
    // now know is refusing everyone. Those failures are forgiven
    // (rejection_reason carries PROVIDER_UNAVAILABLE, so they don't count
    // toward any lead's retry cap) but they are pointless work that writes
    // rows a human has to read past. Stop the batch.
    //
    // And do NOT self-chain afterwards. Re-entering would rely on the
    // pre-flight to break the cycle, which it cannot promise: it answers "is a
    // key usable?" from provider_keys, so a stale-healthy row or an env-var key
    // that is itself dry passes the check and fails the call, and the route
    // would chain into itself forever. Ending the run is the safe stop — the
    // watchdog re-kicks this campaign within 10 minutes once a key works again.
    if (isProviderOutage(result.reason)) { llmOutage = true; break; }
  }

  const remaining = await countPendingDrafts(cdb, campaignId);

  if (llmOutage) {
    // Leave the campaign released (reset_stuck_draft_generation already put it
    // back to 'draft') and stop. Leads keep their retries; the banner is up;
    // the watchdog owns resuming this.
    return Response.json({
      processed: succeeded + failed, succeeded, failed, remaining, status: "llm_unavailable",
    });
  }

  // Same reason as the follow-up writer: a success row is what clears the
  // "no LLM credits" banner, and only org scraping used to write one.
  if (succeeded > 0) await logLlmRecovered(cdb, campaign.company_id as string);

  if (remaining > 0 || ranOutOfTime) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET!;
    // after() keeps the lambda alive until the next batch kickoff actually leaves
    // the machine, so generation doesn't silently stop mid-campaign. (§1.2)
    after(async () => {
      await fetch(`${baseUrl}/api/enrich/generate-drafts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": secret,
        },
        body: JSON.stringify({ campaign_id: campaignId, step_number: stepNumber }),
      }).catch(() => {});
    });
  } else if (drivesStatus && ["draft", "processing"].includes(campaign.status)) {
    // Only a campaign that was still pre-send drops back to 'draft' when the
    // queue empties. A LIVE campaign must not: drafting one late-added lead
    // (a bounce replacement, a lead added to a running campaign) would
    // otherwise drag the whole campaign back to Draft in the UI while
    // Instantly is mid-sequence. Matches the same guard on the
    // no-targets branch above.
    await cdb.from("campaigns").update({
      status: "draft",
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
  }

  return Response.json({
    processed: succeeded + failed,
    succeeded,
    failed,
    remaining,
  });
}
