import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_ENRICH_ATTEMPTS } from "@/lib/services/enrich-leads";
import { countPendingDrafts, logLlmUnavailable } from "@/lib/services/generate-drafts";
import { hasUsableLlmKey, hasUsableServiceKey } from "@/lib/services/provider-keys";
import { checkInstantlyCredits } from "@/lib/services/provider-credits";

type Db = SupabaseClient;

/** Nudge the scrape worker so its watchdogs (stuck scraping / stale queued)
 *  run even on an otherwise idle day. */
export function triggerScrapeWatchdog(baseUrl: string) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return;
  void fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
    method: "POST",
    headers: { "x-internal-secret": secret },
  }).catch(() => {});
}

/** Resume email-reveal (`/api/v1/leads/enrich`) for any Apollo import whose
 *  self-chain died mid-run (server restart, redeploy, function timeout) — the
 *  same kind of silent stall that org-scraping's watchdog above already guards
 *  against, but for the enrich stage, which has no other safety net.
 *
 *  DELIBERATELY NOT part of runEnrichmentWatchdog. This is the only background
 *  job in the app that can spend money, and it used to ride along with the
 *  15-minute watchdog: 96 chances a day for a defect to become a charge, which
 *  is precisely how one unresolvable lead cost ~420 credits in July 2026. It
 *  now runs on its own once-a-day schedule (cron job `resume-apollo-reveal`),
 *  so the blast radius of anything going wrong here is 1 pass instead of 96.
 *
 *  Waiting up to a day costs nothing real: the import's own self-chain already
 *  handles the normal case within seconds, and this is only the safety net for
 *  when that chain dies. Leads that arrive a day later are still leads. */
export async function triggerEnrichWatchdog(baseUrl: string, db: Db) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return;

  const { data: pending } = await db
    .from("leads")
    .select("import_id")
    .eq("lead_source", "apollo")
    .eq("has_email", true)
    // Deleted leads can never be claimed (claim_unenriched_leads refuses them),
    // so an import full of them stays "pending" forever and permanently holds
    // one of the five slots below — starving imports that could actually run.
    .eq("is_deleted", false)
    // Same circuit breaker as the enrich route: a lead that has already been
    // asked about three times must not keep waking this job up. Without it, one
    // permanently-unresolvable lead re-triggers a paid Apollo call every 15
    // minutes forever — 96 credits a day, which is exactly what happened
    // between 15 and 26 July 2026.
    .lt("enrich_attempts", MAX_ENRICH_ATTEMPTS)
    .is("email", null)
    .not("import_id", "is", null);

  // ONE import per kick — not five in parallel. Concurrent kicks meant up to
  // five bulk_match streams hitting Apollo at once, which can rate-limit each
  // other, and Apollo bills a 429-rejected request the same as a served one.
  // The enrich route walks the rest serially on its own: it self-chains
  // through the import's batches, and (service-role callers only) chains on to
  // the next pending import once this one is finished. A chain that dies is
  // resumed by tomorrow's pass — this is the safety net, not the fast path.
  const importId = [...new Set((pending ?? []).map((r) => r.import_id as string))][0];
  if (!importId) return;

  // OVERLAP GUARD. Safe at 15 minutes, mandatory at 30: this job now runs often
  // enough to fire while the previous pass is still mid-reveal. claim_unenriched_leads
  // already stops two callers paying for the SAME lead, but nothing stopped two
  // bulk_match streams running at once on different leads — and concurrent streams
  // rate-limit each other, which matters because Apollo bills a 429-rejected
  // request exactly like a served one.
  //
  // `enrich_locked_at` is the existing claim marker and self-expires after 10
  // minutes, so a pass killed by the function timeout unblocks itself rather than
  // wedging the queue shut. No new table, no new column.
  const { data: inFlight } = await db
    .from("leads")
    .select("id")
    .not("enrich_locked_at", "is", null)
    .gt("enrich_locked_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .is("email", null)
    .limit(1);
  if (inFlight && inFlight.length > 0) return;

  // A dropped kick used to vanish: `.catch(() => {})` swallowed it, so a stalled
  // import looked identical to a finished one and nobody knew until someone
  // counted the leads by hand. It stays non-throwing (this is a background
  // nudge, not the caller's problem) but it no longer stays silent.
  // AWAITED, not fire-and-forget. `void fetch(...)` here meant the kick was
  // still in flight when the route returned its response — and a serverless
  // instance is frozen the moment it responds, so the request was killed before
  // it landed. The job reported {"triggered": true} every single time and
  // revealed nothing: 200 leads sat unrevealed for 26 hours across ~50 "successful"
  // passes on 4-5 Sep 2026. The self-chain two files over already got this right
  // via after(); this one was written with a bare void and never worked from cron.
  await fetch(`${baseUrl}/api/v1/leads/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
    body: JSON.stringify({ import_id: importId }),
  }).catch(async (e) => {
    console.error("resume-apollo-reveal: kick failed", importId, e);
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "ENRICH_RESUME_KICK_FAILED",
      payload: { import_id: importId, error: (e as Error)?.message ?? String(e) },
    }).then(() => {}, () => {});
  });
}

/** A running regeneration job is considered stalled once its heartbeat is this old. */
const REGEN_STALE_MINUTES = 5;

/** A job still stalling this long after it was created is not coming back on
 *  its own — by then every watchdog pass has already re-kicked it dozens of
 *  times. Fail it instead of kicking it forever: an unbounded kick loop burns
 *  a lambda per pass, can keep paying LLM providers for completions that
 *  finish server-side after our timeout, and holds uq_draft_regen_active_job
 *  so no fresh run can ever be started on that campaign. */
const REGEN_EXPIRE_HOURS = 24;

/** Revive bulk draft-regeneration jobs whose batch self-chain died mid-run —
 *  the same failure mode the two watchdogs above exist for. Each batch bumps
 *  heartbeat_at, so a 'running' job that has gone quiet lost its chain: reset
 *  the items it had claimed and kick it again. Without this, a job stalls
 *  forever AND holds uq_draft_regen_active_job, blocking every future run on
 *  that campaign. */
export async function triggerRegenerationWatchdog(baseUrl: string, db: Db) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return;

  const staleBefore = new Date(Date.now() - REGEN_STALE_MINUTES * 60 * 1000).toISOString();
  const expiredBefore = new Date(Date.now() - REGEN_EXPIRE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: stalled } = await db
    .from("draft_regeneration_jobs")
    .select("id, company_id, created_at")
    .in("status", ["queued", "running"])
    .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
    .lt("created_at", staleBefore)
    .limit(5);

  // Same per-company cache the draft-generation watchdog below uses: no
  // provider will serve the batch, so kicking it just marks items failed for
  // nothing and chews through the job's leads during an outage.
  const companyHasUsableLlm = new Map<string, boolean>();

  for (const job of stalled ?? []) {
    const now = new Date().toISOString();

    if (job.created_at && (job.created_at as string) < expiredBefore) {
      // Out of patience (see REGEN_EXPIRE_HOURS). Items the job never finished
      // are failed with a reason the UI can show; the job row leaves
      // queued/running so the unique active-job index releases and a human can
      // start a fresh, deliberate run.
      await db
        .from("draft_regeneration_job_items")
        .update({ status: "failed", error: `Watchdog: job stalled for over ${REGEN_EXPIRE_HOURS}h`, updated_at: now })
        .eq("job_id", job.id)
        .in("status", ["pending", "running"]);
      await db
        .from("draft_regeneration_jobs")
        .update({ status: "failed", finished_at: now, heartbeat_at: now })
        .eq("id", job.id);
      continue;
    }

    const companyId = job.company_id as string | null;
    if (companyId) {
      let usable = companyHasUsableLlm.get(companyId);
      if (usable === undefined) {
        usable = await hasUsableLlmKey(db, companyId);
        companyHasUsableLlm.set(companyId, usable);
      }
      // Leave the job queued/running untouched: when a key comes back, the
      // next pass revives it. The 24h ceiling above bounds how long that
      // waiting can go on. (The outage banner is already raised per company by
      // the draft-generation watchdog below.)
      if (!usable) continue;
    }

    // Items left 'running' belong to the batch that died; put them back in the
    // queue. Anything already done/failed keeps its outcome.
    await db
      .from("draft_regeneration_job_items")
      .update({ status: "pending", updated_at: now })
      .eq("job_id", job.id)
      .eq("status", "running");

    void fetch(`${baseUrl}/api/enrich/regenerate-drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ job_id: job.id }),
    }).catch(() => {});
  }
}

/** A campaign that has written no draft in this long has lost its chain. */
const DRAFT_STALE_MINUTES = 5;

/** How many stalled campaigns one watchdog pass will restart. */
const MAX_DRAFT_KICKS_PER_PASS = 5;

/** Revive INITIAL draft generation whose self-chain died mid-run.
 *
 *  triggerRegenerationWatchdog above covers bulk *re*generation; first-pass
 *  generation had no net at all. Its only recovery was the
 *  reset_stuck_draft_generation call at the top of the worker itself — which
 *  cannot help, because the thing that needs reviving is that same worker. A
 *  campaign whose chain died stayed "processing" forever with no way back.
 *
 *  Confirmed live on the client's 100-lead campaign: 8 drafts written, the
 *  chain died with the lambda, and it sat untouched for 20 minutes until
 *  someone noticed.
 *
 *  Liveness is measured by the most recent draft row, not campaigns.updated_at,
 *  which only moves on a status flip — a healthy run writes a draft every ~6s
 *  and so is never mistaken for stalled, while a dead one is picked up on the
 *  next pass. That matters: kicking a campaign that is still running would hand
 *  two workers the same targets and duplicate drafts.
 *
 *  Free (LLM providers, no Apollo), so it is safe at the 15-minute cadence. */
export async function triggerDraftGenerationWatchdog(baseUrl: string, db: Db) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return;

  // Marks 'generating' rows older than the cutoff as failed (retry-able) and
  // releases campaigns with nothing actually in flight.
  try {
    await db.rpc("reset_stuck_draft_generation", { stale_minutes: DRAFT_STALE_MINUTES });
  } catch { /* non-fatal */ }

  const staleBefore = new Date(Date.now() - DRAFT_STALE_MINUTES * 60 * 1000).toISOString();

  // Nothing to gain from restarting a campaign no provider will serve. When
  // both of the client's keys ran dry, this job re-kicked the campaign every
  // 15 minutes and every attempt failed in ~3.5s — costing no money (a 429
  // bills nothing) but chewing through the leads' three retries until they
  // were permanently skipped. hasUsableLlmKey reads the key health already on
  // provider_keys instead of asking a provider for a balance; the route itself
  // repeats the same check, so a kick from any other source is guarded too.
  const companyHasUsableLlm = new Map<string, boolean>();
  const hasUsableLlm = async (companyId: string): Promise<boolean> => {
    const cached = companyHasUsableLlm.get(companyId);
    if (cached !== undefined) return cached;
    const usable = await hasUsableLlmKey(db, companyId);
    companyHasUsableLlm.set(companyId, usable);
    return usable;
  };

  // One banner row per company per pass. While an outage lasts this job is the
  // only writer left — generation correctly never starts, so nothing else
  // reports it — and service-health only looks back 6 hours. Firing every 10
  // minutes keeps the red banner up for the whole outage and lets it clear on
  // its own once a key works again.
  const loggedOutage = new Set<string>();

  // Deliberately NOT filtered on status = 'processing'. The reset call above
  // flips exactly these campaigns to 'draft' on its way past (it releases any
  // campaign in 'processing' with nothing actively generating), so a scan for
  // 'processing' afterwards finds nothing and the stalled campaign is never
  // revived. draft_generation_started_at is the signal that survives: it means
  // generation was asked for, whatever the status has since been set to.
  //
  // The cap is on how many campaigns are KICKED, not on how many are examined.
  // Limiting the query itself starves the campaign that needs help: every
  // completed campaign still matches this filter (status 'draft',
  // draft_generation_started_at set long ago), and there are dozens of them, so
  // the five slots were filled by finished work and the stalled campaign was
  // never reached. Same trap the enrich watchdog above documents.
  //
  // ponytail: examines every non-deleted draft/processing campaign, which is
  // fine at this scale (~50). If that ever runs into thousands, push the
  // "has pending leads" test into the query instead of filtering here.
  const { data: candidates } = await db
    .from("campaigns")
    .select("id, company_id")
    .in("status", ["draft", "processing"])
    .eq("is_deleted", false)
    .not("draft_generation_started_at", "is", null)
    .lt("draft_generation_started_at", staleBefore)
    .order("draft_generation_started_at", { ascending: false });

  let kicked = 0;
  for (const campaign of candidates ?? []) {
    if (kicked >= MAX_DRAFT_KICKS_PER_PASS) break;
    const campaignId = campaign.id as string;

    const companyId = campaign.company_id as string;

    // Nothing left to write — a finished campaign must not be kicked, and this
    // is also what stops a pathological lead being retried forever: leads past
    // the 3-failure cap are not counted as pending, so the campaign goes quiet
    // instead of burning LLM calls on every pass.
    //
    // Checked BEFORE the LLM check now, so a company whose only stale
    // campaigns are already finished never raises an outage banner about work
    // that does not exist.
    if ((await countPendingDrafts(db, campaignId)) === 0) continue;

    if (!(await hasUsableLlm(companyId))) {
      if (!loggedOutage.has(companyId)) {
        loggedOutage.add(companyId);
        // db is unscoped here, so company_id has to be passed explicitly or
        // the banner's scoped read will never see this row.
        await logLlmUnavailable(
          db,
          companyId,
          "Every configured LLM key is out of credits or rejected — draft generation is paused.",
          { campaign_id: campaignId, source: "watchdog" },
        );
      }
      continue;
    }

    const { data: lastDraft } = await db
      .from("email_drafts")
      .select("created_at")
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Still producing — leave it alone rather than hand a second worker the
    // same targets.
    if (lastDraft?.created_at && lastDraft.created_at > staleBefore) continue;

    kicked++;
    void fetch(`${baseUrl}/api/enrich/generate-drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ campaign_id: campaignId }),
    }).catch(() => {});
  }
}

/** Runs the nudges together — this is the whole job of the frequent watchdog.
 *
 *  Everything here is FREE: scraping is Firecrawl, draft regeneration is the
 *  LLM providers. No Apollo call can originate from this function, which is why
 *  it is safe to run every 10 minutes. The one paid job, triggerEnrichWatchdog,
 *  is deliberately excluded and runs on its own daily schedule. */
/**
 * Safety net for the daily follow-up writer.
 *
 * The writer is scheduled once a day, so a single missed run would leave that
 * day's follow-ups unwritten and Instantly would send the generic fallback
 * instead — a silent quality regression nobody would notice until a prospect
 * received boilerplate. Calling it from the 10-minute watchdog closes that gap.
 *
 * Cheap to repeat: the sweep skips any (lead, step) that already has a draft, so
 * all but one of the ~144 daily calls find nothing and return immediately. Fire
 * and forget, like triggerScrapeWatchdog — the watchdog must not be held open by
 * work that can take 40 seconds.
 */
function triggerFollowupWriter(baseUrl: string) {
  void fetch(`${baseUrl}/api/internal/write-followups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": process.env.INTERNAL_SECRET ?? "",
    },
    body: JSON.stringify({ limit: 25 }),
  }).catch(() => {});
}

/**
 * Bring back the organisations that failed because OUR Firecrawl key was down.
 *
 * This is the gap the draft side already covers and scraping did not. Draft
 * generation refuses to start when no LLM provider will serve it, logs the
 * outage, and picks the work back up once a key is healthy. Scraping had no
 * equivalent: an org marked failed stayed failed forever, and the only way back
 * was a human pressing "Retry all".
 *
 * The result is visible in the data — 436 organisations permanently failed with
 * "No usable Firecrawl key configured". They were never actually reached, so
 * they deserve a real attempt once a key exists.
 *
 * Deliberately narrow: it requeues ONLY SCRAPE_PROVIDER_UNAVAILABLE. A dead
 * domain or an empty page is the company's own problem and stays where it is —
 * requeueing those is what turns a watchdog into a credit-burning loop.
 */
export async function triggerScrapeRecoveryWatchdog(baseUrl: string, db: Db) {
  const { data: orgs } = await db
    .from("organizations")
    .select("id, company_id")
    .eq("enrichment_stage", "failed")
    .eq("enrichment_status", "SCRAPE_PROVIDER_UNAVAILABLE")
    .limit(500);

  if (!orgs?.length) return;

  // One key check per company, not per org.
  const usableByCompany = new Map<string, boolean>();
  const recoverable: string[] = [];
  for (const org of orgs) {
    const companyId = org.company_id as string;
    if (!usableByCompany.has(companyId)) {
      usableByCompany.set(companyId, await hasUsableServiceKey(db, "firecrawl", companyId));
    }
    if (usableByCompany.get(companyId)) recoverable.push(org.id as string);
  }
  if (recoverable.length === 0) return;

  await db
    .from("organizations")
    .update({
      enrichment_stage: "queued",
      enrichment_status: "SCRAPE_QUEUED",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", recoverable);

  // enrichment_attempts is deliberately NOT reset: markFailed never charged an
  // attempt for a provider fault, so the org still has its full budget.
  await db.from("enrichment_logs").insert({
    source: "system",
    event: "SCRAPE_QUEUED",
    payload: { total_orgs: recoverable.length, triggered_by: "scrape_recovery_watchdog" },
    created_at: new Date().toISOString(),
  });

  triggerScrapeWatchdog(baseUrl);
}

/**
 * Keep the Instantly health reading fresh.
 *
 * Every other provider's balance is refreshed as a side effect of real work —
 * the scrape batch checks Firecrawl and the LLM tiers before every pass. Nothing
 * does that for Instantly: the only caller is the Settings > Keys page, so the
 * cached reading was last written on 24 Aug and sat six days stale. An Instantly
 * outage would therefore never raise the service-health banner; the first sign
 * would be mail quietly not arriving.
 *
 * One cheap call per pass, and `fresh` is deliberately NOT set — the 5-minute
 * cache inside checkCredits already collapses repeat passes, so this refreshes
 * roughly every 5 minutes rather than every 10-minute tick.
 *
 * Scoped "any": Instantly is one workspace shared by every company.
 */
async function refreshInstantlyHealth(db: Db) {
  try {
    await checkInstantlyCredits(db, "any");
  } catch { /* a health probe must never break the watchdog */ }
}

export async function runEnrichmentWatchdog(baseUrl: string, db: Db) {
  await refreshInstantlyHealth(db);
  triggerScrapeWatchdog(baseUrl);
  await triggerScrapeRecoveryWatchdog(baseUrl, db);
  triggerFollowupWriter(baseUrl);
  await triggerRegenerationWatchdog(baseUrl, db);
  await triggerDraftGenerationWatchdog(baseUrl, db);
}
