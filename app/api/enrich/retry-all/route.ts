import { NextRequest, after } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { dbForUser } from "@/lib/supabase/scoped";

/** Mirrors MAX_ENRICHMENT_ATTEMPTS in the scrape worker. */
const MAX_ENRICHMENT_ATTEMPTS = 3;

/** Mirrors SCRAPE_CACHE_TTL_MS in the scrape worker — a scrape newer than this
 *  is reused instead of re-fetched, so retrying that org costs nothing. */
const SCRAPE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Bulk version of the single-org rescrape/retry — requeues every failed org,
// instead of managers clicking "retry" one company at a time (there was no
// bulk path before this, and failures pile up fast on a large import).
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);

  // One UPDATE with the same WHERE the SELECT would have used — not a
  // select-ids-then-.in(ids) round trip. At batch scale that id list runs to
  // thousands of characters and can get silently dropped by an intermediary
  // (proxy/tunnel URL-length limit) with supabase-js never surfacing it as a
  // thrown error, so a prior version of this route reported success when
  // nothing had actually been requeued.
  //
  // The attempt cap is now respected.
  //
  // This used to reset enrichment_attempts to 0 for every failed org, on the
  // reasoning that a manual retry after a credit top-up deserves a clean slate.
  // The cost of that was an unbounded loop: a website that is genuinely dead got
  // retried on every press, forever, and each press is a Firecrawl credit per
  // reachable domain. Measured on live data, one press = ~859 credits.
  //
  // So the two cases are now separated:
  //
  //   our fault    (no key, no credits, provider down) — never charged an
  //                attempt in the first place, so it simply requeues
  //   their fault  (dead domain, empty page, nothing extractable) — keeps its
  //                count, and once it is out of attempts it stays in Input
  //                Required rather than being retried forever
  const RETRY_ELIGIBLE = `enrichment_attempts.lt.${MAX_ENRICHMENT_ATTEMPTS},enrichment_status.eq.SCRAPE_PROVIDER_UNAVAILABLE`;

  // What this press will actually spend, counted BEFORE the requeue (the update
  // changes the very rows we are measuring). Firecrawl bills for reaching a
  // site, so an org with no domain is free and a fresh cached scrape is free —
  // everything else is one credit. Returned so the UI can say the number out
  // loud instead of the user finding out afterwards.
  const cacheCutoff = new Date(Date.now() - SCRAPE_CACHE_TTL_MS).toISOString();

  const failedBase = () => db.from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("enrichment_stage", "failed");

  const [{ count: totalFailed }, { count: eligible }, { count: eligibleNoDomain }, { count: eligibleCached }] =
    await Promise.all([
      failedBase(),
      failedBase().or(RETRY_ELIGIBLE),
      failedBase().or(RETRY_ELIGIBLE).is("domain", null),
      failedBase().or(RETRY_ELIGIBLE).not("scraped_markdown", "is", null).gte("scraped_at", cacheCutoff),
    ]);

  const free = (eligibleNoDomain ?? 0) + (eligibleCached ?? 0);
  const cost = {
    willCostCredits: Math.max(0, (eligible ?? 0) - free),
    free,
    skipped: Math.max(0, (totalFailed ?? 0) - (eligible ?? 0)),
  };

  const { data: updated, error } = await db
    .from("organizations")
    .update({
      has_scraped: false,
      enrichment_stage: "queued",
      enrichment_status: "SCRAPE_QUEUED",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("enrichment_stage", "failed")
    .or(RETRY_ELIGIBLE)
    .select("id");

  if (error) return fail(500, "INTERNAL", error.message);

  const ids = (updated ?? []).map((o) => o.id);
  if (ids.length === 0) return ok({ requeued: 0, willCostCredits: 0, free: 0, skipped: 0 });

  await db.from("enrichment_logs").insert({
    source: "system",
    event: "SCRAPE_QUEUED",
    payload: { total_orgs: ids.length, triggered_by: "retry_all" },
    created_at: new Date().toISOString(),
  });

  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  return ok({ requeued: ids.length, ...cost });
}
