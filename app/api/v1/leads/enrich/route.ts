import { NextRequest, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { EnrichSchema } from "@/lib/validators/leads";
import { enrichLeads, MAX_ENRICH_ATTEMPTS, type EnrichTarget } from "@/lib/services/enrich-leads";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { getServiceSecret } from "@/lib/services/service-keys";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 300;

/** Record why an email-reveal pass produced nothing, attributed to the company
 *  whose leads it was. `/api/v1/service-health` reads these rows through a
 *  COMPANY-SCOPED client, and the 15-minute watchdog calls this route as the
 *  service-role bearer — whose db client is unscoped, so an insert through it
 *  is not stamped. Passing company_id explicitly is what keeps the "Apollo is
 *  out of credits" banner lit for the client: without it every watchdog-logged
 *  failure landed with company_id null, invisible to the only UI that reports
 *  them, and the banner went dark ~6h (the health route's lookback) after the
 *  import while the outage itself ran for days. */
async function logEnrichFailure(
  db: SupabaseClient,
  companyId: string | null,
  event: "CREDITS_EXHAUSTED" | "EMAIL_REVEAL_FAILED",
  message: string,
  payload: Record<string, unknown>,
) {
  await db.from("enrichment_logs").insert({
    source: "apollo",
    event,
    error: message.slice(0, 500),
    payload,
    ...(companyId ? { company_id: companyId } : {}),
  });
}

// Each matched lead does several sequential DB writes (org lookup/upsert, lead
// update, campaign_leads update) on top of the bulk_match call itself, so a
// large `import_id` batch (a big Apollo search can create 1000+ leads in one
// request) can run past the 300s function cap and get killed mid-loop —
// before it ever reaches the code that triggers org scraping below. 150 stays
// comfortably inside the time budget; the self-trigger at the end picks up
// whatever's left for the same import.
// Sized to finish well inside 60s, not the 300 declared above: that ceiling is
// only real on a paid Vercel plan, and this project deploys to Hobby. At ~10
// leads per Apollo call plus roughly four database round trips each, 150 leads
// ran 60-100s and was being killed near the end of nearly every pass — which is
// exactly how an import ends up half-revealed and needing a resume. 50 leads
// lands around 20-35s with room to spare. The self-chain picks up the rest, so
// a smaller batch costs nothing but a few more invocations.
const ENRICH_BATCH_SIZE = 50;

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = EnrichSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  // DB-first key resolution (Settings > Keys), matching bulkMatch()'s own path
  // — an env-only check 503s the whole email-reveal pass in production.
  if (!(await getServiceSecret("apollo", "any" /* one shared Apollo account */))) {
    return fail(503, "UPSTREAM_APOLLO", "Apollo API key not configured — add one in Settings > Keys");
  }

  const db = dbForUser(user);

  let q = db
    .from("leads")
    .select("id, apollo_id, first_name, last_name, title, country, city, state, organization_id, company_id, organizations(name)")
    .eq("lead_source", "apollo")
    .eq("has_email", true)
    // A deleted lead is not a reveal candidate. claim_unenriched_leads already
    // refuses them, so this changes no spend — but without it a deleted import
    // stays "pending" forever, occupying one of the watchdog's five slots and
    // burning a pass every 15 minutes to claim nothing.
    .eq("is_deleted", false)
    // THE CIRCUIT BREAKER. Three asks is the hard lifetime ceiling for any one
    // person, enforced at the point of selection rather than trusted to the
    // cleanup path. In July 2026 a single lead that could neither be revealed
    // nor archived was re-asked every 15 minutes for eleven days — 96 credits a
    // day, ~420 in total, for one contact. Whatever goes wrong downstream, a
    // lead at the cap is simply never selected again.
    .lt("enrich_attempts", MAX_ENRICH_ATTEMPTS)
    .is("email", null);

  if ("campaign_id" in parsed.data) {
    const { data: memberIds } = await db
      .from("campaign_leads").select("lead_id").eq("campaign_id", parsed.data.campaign_id);
    const ids = (memberIds ?? []).map((r) => r.lead_id);
    if (ids.length === 0) return ok({ requested: 0, matched: 0, archived: 0, missing_apollo_ids: [], credits_consumed: 0, verified: 0, unverified: 0, remaining: 0 });
    q = q.in("id", ids).limit(parsed.data.limit);
  } else if ("import_id" in parsed.data) {
    q = q.eq("import_id", parsed.data.import_id).limit(ENRICH_BATCH_SIZE);
  } else {
    q = q.in("id", parsed.data.lead_ids);
  }

  const { data: rows, error } = await q;
  if (error) return fail(500, "INTERNAL", error.message);
  if (!rows?.length) return ok({ requested: 0, matched: 0, archived: 0, missing_apollo_ids: [], credits_consumed: 0, verified: 0, unverified: 0, remaining: 0 });

  // Every lead in a batch comes from one import, so one company — but fall back
  // to the caller's own for the service-role path, where rows are the only hint.
  const companyId = (rows.find((r) => r.company_id)?.company_id as string | undefined) ?? user.companyId ?? null;

  // Pre-flight the credit balance BEFORE claiming anything. Apollo bills per
  // bulk_match ask and answers 422 "insufficient credits" once the account's
  // pool is empty, so an unchecked pass claims 150 leads, fires a doomed call,
  // and releases them again — which is exactly what the 15-minute watchdog did
  // every 15 minutes for two days while the client's leads sat in New. Catching
  // it here costs one cached GET and leaves a company-attributed log row behind
  // so the banner keeps saying why.
  //
  // A logged-in manager gets an uncached reading: the likeliest reason someone
  // is hitting Enrich by hand is that they just topped up, and a stale
  // five-minute "out of credits" answer would look like the top-up failed.
  const credits = await checkApolloCredits(db, { fresh: user.companyId !== null });
  if (!credits.ok) {
    await logEnrichFailure(db, companyId, "CREDITS_EXHAUSTED", credits.message, {
      warning: credits.message,
      remaining_credits: credits.remaining,
      pending_leads: rows.length,
      skipped_before_claim: true,
      import_id: "import_id" in parsed.data ? parsed.data.import_id : null,
    });
    return ok({
      requested: 0, matched: 0, archived: 0, missing_apollo_ids: [],
      credits_consumed: 0, verified: 0, unverified: 0, remaining: rows.length,
      warning: credits.message, credits_exhausted: true,
    });
  }

  // Never ask for more people than Apollo can actually pay for. `credits.ok`
  // above only asserts "more than APOLLO_MIN_CREDITS left" — with 6 credits
  // remaining it would still claim 150 leads and fire all of them, and the
  // overspill comes back as a mid-batch 422 that strands the rest. Trimming the
  // candidate set here is the reveal-side equivalent of the cap the search
  // route already applies (and the one the 30 July analysis credited to this
  // route, which never actually had it).
  const affordable = credits.remaining == null
    ? rows
    : rows.slice(0, Math.max(0, credits.remaining));
  if (affordable.length === 0) {
    return ok({
      requested: 0, matched: 0, archived: 0, missing_apollo_ids: [],
      credits_consumed: 0, verified: 0, unverified: 0, remaining: rows.length,
      warning: `Apollo has ${credits.remaining} credits left — nothing claimed`,
      credits_exhausted: true,
    });
  }

  // Atomically claim this candidate set before spending any Apollo credits on
  // it — without this, the natural self-chain and a watchdog nudge (or two
  // watchdog nudges) firing close together can both select the same pending
  // leads and both pay Apollo to look up the same people. FOR UPDATE SKIP
  // LOCKED (inside the RPC) means only one caller ever actually gets a given
  // lead back; the other silently gets a smaller set instead of a duplicate.
  const { data: claimed, error: claimError } = await db.rpc("claim_unenriched_leads", {
    p_ids: affordable.map((r) => r.id),
  });
  if (claimError) return fail(500, "INTERNAL", claimError.message);

  const claimedIds = new Set((claimed as Array<{ id: string }> ?? []).map((r) => r.id));
  const targets: EnrichTarget[] = affordable
    .filter((t) => claimedIds.has(t.id))
    .map((t) => {
      const org = Array.isArray(t.organizations) ? t.organizations[0] : t.organizations;
      return {
        id: t.id, apollo_id: t.apollo_id, first_name: t.first_name, last_name: t.last_name,
        title: t.title, country: t.country, city: t.city, state: t.state,
        organization_id: t.organization_id, org_name: org?.name ?? null,
        // Carried so enrichLeads can pin its org/lead writes to the right tenant
        // even on the service-role path, where the db client is unscoped.
        company_id: (t.company_id as string | null) ?? companyId,
      };
    });

  if (targets.length === 0) return ok({ requested: 0, matched: 0, archived: 0, missing_apollo_ids: [], credits_consumed: 0, verified: 0, unverified: 0, remaining: 0 });

  const stats = await enrichLeads(db, targets, 10);

  const baseUrl = internalAppBaseUrl(req);
  const secret = process.env.INTERNAL_SECRET;

  // Persist the failure reason — after() discards the HTTP response body, so
  // without this a credits 422 looked identical to a healthy enrich pass.
  // `error` is what /api/v1/service-health reads for the dashboard banner;
  // `payload` keeps the structured stats for debugging.
  if (stats.warning) {
    await logEnrichFailure(
      db,
      companyId,
      stats.credits_exhausted ? "CREDITS_EXHAUSTED" : "EMAIL_REVEAL_FAILED",
      stats.warning,
      {
        warning: stats.warning,
        requested: targets.length,
        matched: stats.matched,
        archived: stats.archived,
        credits_consumed: stats.credits_consumed,
        rate_limited: stats.rate_limited ?? false,
        import_id: "import_id" in parsed.data ? parsed.data.import_id : null,
      },
    );
  }

  // NOTE: the spend ledger row lives below, as a single CREDITS_CONSUMED event.
  // An earlier version of this route wrote its own APOLLO_SPEND row here as
  // well. Settings > Keys > Usage sums `payload.credits_consumed` across every
  // apollo-source log row without filtering on the event name, so two rows per
  // pass reported double the real spend — the one number this whole exercise
  // exists to get right. One row, one event.

  // Ledger row for every batch that actually spent credits — separate from the
  // warning branch above, which only fires on failure. Without this a clean
  // run (the common case) left no trace of what it cost, which is exactly the
  // number Settings > Keys > Usage > Apollo needs to show "credits used, when."
  if (stats.credits_consumed > 0) {
    await db.from("enrichment_logs").insert({
      source: "apollo",
      event: "CREDITS_CONSUMED",
      payload: {
        requested: targets.length,
        matched: stats.matched,
        archived: stats.archived,
        verified: stats.verified,
        unverified: stats.unverified,
        credits_consumed: stats.credits_consumed,
        // The balance Apollo reported just before this batch. Makes the ledger
        // self-checking: consecutive rows should differ by their own
        // credits_consumed, and any drift is spend that did not come from here.
        balance_before: credits.remaining,
        campaign_id: "campaign_id" in parsed.data ? parsed.data.campaign_id : null,
        import_id: "import_id" in parsed.data ? parsed.data.import_id : null,
      },
      // Attributed to the company whose leads these were — the service-role
      // path is unscoped, so without this the row lands company_id null and is
      // invisible to the scoped read behind the Usage tab.
      ...(companyId ? { company_id: companyId } : {}),
    });
  }

  // Trigger org scraping AFTER enrichment — domains are now populated on orgs.
  if (stats.enriched_org_ids.length > 0 && secret && (await getServiceSecret("firecrawl", companyId ?? "any"))) {
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  // This batch was capped at ENRICH_BATCH_SIZE — if the import still has more
  // unrevealed leads, self-trigger another pass. Mirrors scrape-orgs' own
  // self-continuation so a large import can never outrun the 300s function cap.
  // Do NOT chain when Apollo is out of credits — that just re-claims batches,
  // burns nothing useful, and (before the conclude fix) falsely failed orgs.
  // Do NOT chain on a rate limit either: Apollo bills the rejected request, so
  // an immediate retry is the exact loop that turned 1,403 people into 3,222
  // credits on 2026-07-14. The 15-minute watchdog resumes it for free instead.
  // ...and do NOT chain after ANY failure, not just credits or a rate limit.
  // Apollo bills a request the moment it receives one, including ones it never
  // answers, so a timeout or a 5xx is still a paid attempt. Chaining straight
  // into the next batch turns a broken Apollo into a paid retry loop running at
  // full speed: with a 1,400-lead import that is ~29 passes back to back, each
  // one paying for a chunk before it fails. `warning` is set by enrichLeads on
  // every failure path, so this covers timeouts, 5xx and anything unforeseen.
  // A stopped import is resumed by the once-a-day job, which is free and slow
  // enough that a bad day shows up in the usage log before it can repeat.
  if ("import_id" in parsed.data && secret && !stats.warning) {
    const importId = parsed.data.import_id;
    const { count: importRemaining } = await db
      .from("leads").select("id", { count: "exact", head: true })
      .eq("import_id", importId)
      .eq("lead_source", "apollo").eq("has_email", true)
      .eq("is_deleted", false).is("email", null);
    if ((importRemaining ?? 0) > 0) {
      const authHeader = req.headers.get("authorization") ?? "";
      after(() =>
        fetch(`${baseUrl}/api/v1/leads/enrich`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": authHeader },
          body: JSON.stringify({ import_id: importId }),
        }).catch(() => {})
      );
    } else if (user.companyId === null) {
      // Import finished, and the caller is the service role — i.e. the daily
      // resume job. That job kicks only ONE import per pass (parallel kicks
      // can rate-limit each other, and Apollo bills 429-rejected requests),
      // so the chain itself walks on to the next import that still has
      // unrevealed leads. Serial by construction: the next import starts only
      // after this one is fully done. Terminates because every successful
      // pass settles, archives, or emails its leads — a lead can't re-enter
      // the pending pool — and any failure sets `warning`, which stops the
      // chain entirely. Managers' manual enrich never reaches this branch.
      const { data: nextPending } = await db
        .from("leads")
        .select("import_id")
        .eq("lead_source", "apollo")
        .eq("has_email", true)
        .eq("is_deleted", false)
        .lt("enrich_attempts", MAX_ENRICH_ATTEMPTS)
        .is("email", null)
        .not("import_id", "is", null)
        .neq("import_id", importId)
        .limit(1);
      const nextImportId = nextPending?.[0]?.import_id as string | undefined;
      if (nextImportId) {
        const authHeader = req.headers.get("authorization") ?? "";
        after(() =>
          fetch(`${baseUrl}/api/v1/leads/enrich`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": authHeader },
            body: JSON.stringify({ import_id: nextImportId }),
          }).catch(() => {})
        );
      }
    }
  }

  const { count: remaining } = await db
    .from("leads").select("id", { count: "exact", head: true })
    .eq("lead_source", "apollo").eq("has_email", true)
    .eq("is_deleted", false).is("email", null);

  return ok({
    requested: targets.length,
    matched: stats.matched,
    archived: stats.archived,
    missing_apollo_ids: stats.missing_apollo_ids,
    credits_consumed: stats.credits_consumed,
    verified: stats.verified,
    unverified: stats.unverified,
    remaining: remaining ?? 0,
    ...(stats.warning ? { warning: stats.warning } : {}),
    ...(stats.credits_exhausted ? { credits_exhausted: true } : {}),
    ...(stats.rate_limited ? { rate_limited: true } : {}),
  });
}
