import { NextRequest, after } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { ApolloSearchSchema } from "@/lib/validators/leads";
import { searchPeople } from "@/lib/services/apollo";
import { getServiceSecret } from "@/lib/services/service-keys";
import { resolveApolloKeyword } from "@/lib/constants";
import { orgKey, pickBestContact } from "@/lib/services/lead-ranking";
// Only used here for counting/ids (the actual enrich pass re-queries its own
// full target shape) — deliberately a narrower local type, not EnrichTarget.
type NewLeadTarget = { id: string; apollo_id: string; first_name: string | null; organization_id: string | null; org_name: string | null };
import { internalAppBaseUrl } from "@/lib/internal-url";
import { dbForUser } from "@/lib/supabase/scoped";
import { DEV_COMPANY_ID } from "@/lib/constants";
import { checkApolloCredits } from "@/lib/services/provider-credits";

export const maxDuration = 300;

/** What searchPeople() asks Apollo for per page (its own per_page default). */
const APOLLO_LEADS_PER_PAGE = 100;

/**
 * Paging is cap-driven, not count-driven: keep walking a keyword's result pages
 * until its lead cap is met. A fixed page count used to be a user-facing
 * dropdown, which was a trap — a page returns 100 raw people, but has_email +
 * already-imported + already-archived filtering can leave only a handful, so
 * "1 page" silently delivered a fraction of the cap the manager actually asked
 * for, and got worse on every re-import of the same niche. Apollo's SEARCH
 * endpoint costs no lead credits (only people/bulk_match does), so digging
 * deeper is free — the caps below are what bound real spend.
 *
 * The three stop conditions that keep "keep paging" from meaning "page forever":
 *  1. Apollo's own total_entries (known after page 1) — never page past the end.
 *  2. SEARCH_TIME_BUDGET_MS — a wall-clock seatbelt. Each page is an Apollo
 *     round trip plus two dedup queries plus an insert; on a 95%-duplicate
 *     niche an uncapped hunt would blow the 300s function limit and get killed
 *     mid-import, leaving a half-written batch.
 *
 * There used to be a third: stop after 3 consecutive pages with no new leads.
 * It was removed on 13 Aug 2026. People search is free, so abandoning a
 * keyword because three pages happened to be duplicates threw away leads that
 * were sitting on page 4 — the client asked for 25 and got 8 partly because of
 * it. Pages of pure duplicates are now simply skipped over.
 */
const MAX_PAGES_PER_KEYWORD = 50;

/**
 * How long the paging loop may run before it stops itself, in ms.
 *
 * WHY A CLOCK AND NOT A PAGE COUNT
 * The ceiling used to be 10 pages per keyword. Measured against the live
 * account on 2026-09-07 (scripts/measure-page-ceiling.ts), that was wrong in
 * both directions at once:
 *
 *   TOO TIGHT — 16 of the 22 catalogue keywords hold more than 1,000 people,
 *   so 10 pages cut them off mid-seam: "pipe" has 44,247 matches and we were
 *   reading 2% of it. Worse, one-lead-per-company discards roughly half of
 *   every page TODAY and discards more of it every time the database grows, so
 *   a 500-lead request that just fits inside 10 pages this month quietly
 *   returns 200 next quarter. A limit that silently tightens over time is the
 *   "I asked for 500 and got 400" complaint on a timer.
 *
 *   TOO LOOSE — an Apollo page takes ~1.1s measured, plus this route's own DB
 *   work. Ten keywords at ten pages is already ~200s against a 300s
 *   maxDuration. Simply removing the cap, on a keyword like "pipe", means the
 *   function is killed by the platform mid-write and the client is left with a
 *   half-written batch — the exact failure that stranded 200 paid leads on
 *   4 Sep 2026.
 *
 * Pages are not the cost; time is. So time is what is capped. 240s leaves a
 * 60s tail for the import row update, the lead_events seed and the enrich
 * kick — all of which must complete or the import is worse than useless.
 *
 * ELAPSED IS LOGGED on every import (SEARCH_TIME_BUDGET in enrichment_logs, and
 * search_criteria.elapsed_ms) precisely because the 1.1s/page figure is
 * measured but the DB share of a page is not. Tune this from that data, not
 * from this comment.
 */
const SEARCH_TIME_BUDGET_MS = 240_000;

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  // provider_keys (Apollo included) are shared across every company — a
  // search here spends real credits from the one pool the live client
  // account also draws from. The dev/internal workspace has no business
  // case for Apollo search, so it's blocked outright rather than trusted
  // not to run one "just to test."
  if (user.companyId === DEV_COMPANY_ID) {
    return fail(403, "APOLLO_DISABLED_DEV", "Apollo search is disabled for the internal/dev workspace — Apollo credits are shared with the live client account.");
  }

  const body = await req.json().catch(() => null);
  const parsed = ApolloSearchSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { keywords, locations, titles, seniorities, advanced, batch_name, color, preview, assigned_to, assignment_strategy, max_leads_per_keyword } = parsed.data;
  // Mutable: clamped down (never up) to Apollo's real remaining balance below,
  // once we have a DB client to check it with.
  let maxTotalLeads = parsed.data.max_total_leads;

  // Resolve through Settings > Keys (DB first, .env as the last-resort tier) —
  // the same path searchPeople() itself uses. Checking process.env directly
  // here 503'd every deployment that stores its key in the UI instead of an
  // env var (i.e. production), even with a healthy Apollo key configured.
  const apolloKey = await getServiceSecret("apollo", "any" /* one shared Apollo account */);
  if (!apolloKey) return fail(503, "UPSTREAM_APOLLO", "Apollo API key not configured — add one in Settings > Keys");

  const db = dbForUser(user);

  // ── Preview mode ──────────────────────────────────────────────────────────
  // Runs the SAME one-lead-per-company rule as the real import. It used to show
  // the first five people on page 1 untouched, which meant the preview happily
  // displayed two contacts at one company and companies the client already
  // covers — i.e. it demonstrated the exact complaint this feature fixes, on
  // the screen a client is most likely to judge it by. Preview is free
  // (people-search costs no credits), so there is no reason for it to model a
  // different search than the one that will actually run.
  if (preview) {
    let previewPeople: Array<{ firstName: string; lastName: string; email: string; company: string; jobTitle: string }> = [];
    try {
      const blockedKeys = new Set<string>();
      const { data: blocked } = await db.rpc("blocked_org_names", { p_company: user.companyId });
      for (const name of (blocked ?? []) as string[]) {
        const k = orgKey(name);
        if (k) blockedKeys.add(k);
      }

      // Up to 3 pages, stopping as soon as five distinct companies are found.
      // One page is not enough once the covered-company filter is applied: on a
      // well-mined keyword page 1 can be almost entirely companies we already
      // have, and an empty preview reads as a broken search rather than as a
      // working filter.
      const seen = new Set<string>();
      const chosen: Array<{ first_name: string | null; title: string | null; org: string | null }> = [];
      for (let page = 1; page <= 3 && chosen.length < 5; page++) {
        const result = await searchPeople({
          keyword: resolveApolloKeyword(keywords[0]),
          locations,
          page,
          titles: titles ?? undefined,
          seniorities: seniorities ?? undefined,
          advanced,
        });
        const people = (result.people ?? []).filter((p) => p.has_email);
        if (people.length === 0) break;

        const byOrg = new Map<string, typeof people>();
        for (const p of people) {
          const k = orgKey(p.organization?.name);
          if (!k || blockedKeys.has(k) || seen.has(k)) continue;
          const bucket = byOrg.get(k);
          if (bucket) bucket.push(p); else byOrg.set(k, [p]);
        }
        for (const [k, candidates] of byOrg) {
          if (chosen.length >= 5) break;
          const best = pickBestContact(candidates);
          if (!best) continue;
          seen.add(k);
          chosen.push({ first_name: best.first_name, title: best.title, org: best.organization?.name ?? null });
        }
      }

      previewPeople = chosen.map((p) => ({
        firstName: p.first_name ?? "",
        lastName: "",
        email: "••••@" + (p.org?.toLowerCase().replace(/\s+/g, "") ?? "company") + ".com",
        company: p.org ?? "",
        jobTitle: p.title ?? "",
      }));
    } catch {
      previewPeople = [];
    }
    return Response.json({ success: true, data: { preview: true, leads: previewPeople } });
  }

  // ── Phase 1: Search all keywords/pages, batch-insert leads ───────────────

  // Never request more than Apollo can actually pay for — if only 40 credits
  // are left, this import gets clamped to 40, not attempted at 50 and left
  // to fail (and archive-loop) partway through.
  const apolloCredits = await checkApolloCredits(db, "any" /* one shared Apollo account */);
  if (apolloCredits.remaining != null && apolloCredits.remaining < maxTotalLeads) {
    maxTotalLeads = Math.max(0, apolloCredits.remaining);
  }
  if (maxTotalLeads <= 0) {
    return fail(402, "APOLLO_OUT_OF_CREDITS", "Apollo has no lead credits remaining — top up before importing.");
  }

  if (assigned_to) {
    const { data: employee } = await db.from("profiles").select("id, is_active").eq("id", assigned_to).maybeSingle();
    if (!employee || !employee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  // Deferred assignment (planning.md Phase 4 / Q5): DON'T assign at import time,
  // when leads are raw "New" shells with no confirmed email. Remember the
  // manager's choice on the import; autoAssignEnrichedLeads applies it per-lead
  // the moment each lead becomes workable (enriched / input_required-with-email)
  // — after the paid Apollo email-reveal, never before it.
  const importAssignmentStrategy = assigned_to ? "manual" : (assignment_strategy ?? null);
  const importAssignmentTarget = assigned_to ?? null;

  // Keep what was actually asked for. Without this an import is unauditable the
  // moment its HTTP response closes — which is how "the client typed 500 and got
  // 400" became unanswerable on 4 Sep 2026. Written once, never updated.
  const searchCriteria = {
    keywords,
    locations,
    titles: titles ?? null,
    seniorities: seniorities ?? null,
    advanced: advanced ?? null,
    max_total_leads: parsed.data.max_total_leads,
    max_leads_per_keyword,
    // The ceiling that actually binds: keywords x max_leads_per_keyword. It is
    // what silently turned 500 into 400, so record it next to the number asked for.
    // What actually binds. Without an explicit per-keyword cap this is just
    // the requested total; with one it is keywords x cap, which is the number
    // that quietly overrode the request before this was recorded.
    reachable_ceiling: max_leads_per_keyword
      ? keywords.length * max_leads_per_keyword
      : parsed.data.max_total_leads,
    requested_at: new Date().toISOString(),
  };

  const { data: importRow } = await db.from("imports")
    .insert({
      label: batch_name, source: "apollo", created_by: user.id, lead_count: 0, color,
      assignment_strategy: importAssignmentStrategy,
      assignment_target: importAssignmentTarget,
      search_criteria: searchCriteria,
    })
    .select("id").single();
  const importId = importRow?.id ?? null;

  let totalEntries = 0;
  let inserted = 0;
  let skippedDuplicate = 0;
  let skippedUnenrichable = 0;
  /** Companies skipped because we already hold a WORKING contact there. */
  let skippedExistingOrg = 0;
  /** Extra people at a company this same import already took one person from. */
  let skippedSameOrg = 0;
  const SKIPPED_ORG_SAMPLE_CAP = 50;
  const skippedOrgSample: string[] = [];
  /** Previously deleted leads brought back rather than skipped — see the
   *  revive block below for why they cannot just be re-inserted. */
  let recoveredDeleted = 0;
  let orgsCreated = 0;
  let orgsReused = 0;
  const warnings: string[] = [];
  const newLeadTargets: NewLeadTarget[] = [];
  const newOrgIds: string[] = [];
  // WHO already owns each duplicate — previously a second importer just saw
  // "skipped" with no clue the lead already belongs to someone else (review
  // §3.3), capped to a reasonable sample for the response.
  const DUPLICATE_SAMPLE_CAP = 50;
  const duplicateOwners: Array<{ name: string; company: string; assigned_to: string | null }> = [];

  // Dropdown labels (e.g. "Beverage Bottles (Water/Juice/CSD)") are display
  // text, not Apollo query terms — Apollo's q_keywords matches near-literally
  // and returns 0 results for punctuation-heavy phrases, so resolve to the
  // validated short term (lib/constants.ts) and dedup so two labels that
  // resolve to the same query don't search Apollo twice.
  const resolvedKeywords = [...new Map(keywords.map((label) => [resolveApolloKeyword(label), label])).entries()]
    .map(([query, label]) => ({ query, label }));

  // Every lead inserted below eventually costs a paid Apollo bulk_match call —
  // max_total_leads and max_leads_per_keyword are the ONLY credit-spend
  // ceilings for this import (lib/validators/leads.ts ApolloSearchSchema), and
  // now also the thing that decides when to stop paging.
  // ── One lead per company ─────────────────────────────────────────────────
  // Loaded ONCE per import, not per page: 3,116 names on the live workspace
  // today, and the keyword loop below can run hundreds of pages.
  //
  // Both sides go through orgKey() so "Acme Plastics Pvt. Ltd." matches "Acme
  // Plastics Private Limited" — the free people-search returns no organization
  // id and no domain (docs/apollo-research/search-person-fields.json), so the
  // company NAME is the only thing there is to match on.
  const blockedOrgKeys = new Set<string>();
  {
    const { data: blocked, error: blockedErr } = await db.rpc("blocked_org_names", { p_company: user.companyId });
    if (blockedErr) {
      // Fail the import rather than silently spend credits on duplicates —
      // that is the exact outcome this feature exists to prevent.
      return fail(500, "DB_ERROR", `Could not load the already-contacted company list: ${blockedErr.message}`);
    }
    // A single text[] on purpose — a set-returning version is silently capped
    // at 1,000 rows by PostgREST, which would have let 2,116 already-covered
    // companies through unnoticed. See the migration for the measurement.
    for (const name of (blocked ?? []) as string[]) {
      const k = orgKey(name);
      if (k) blockedOrgKeys.add(k);
    }
  }
  /** Companies THIS import has already taken its one person from. Session-level
   *  on purpose: the cap is one lead per company across the whole import, not
   *  one per page or one per keyword. */
  const takenOrgKeys = new Set<string>();

  let overallCapHit = false;
  /** Set when the paging loop stopped itself on the clock rather than because
   *  it ran out of leads to find — the difference decides whether the client
   *  should change the search or simply run it again. */
  let timeBudgetHit = false;
  let keywordsSearched = 0;
  const searchStartedAt = Date.now();
  const outOfTime = () => Date.now() - searchStartedAt > SEARCH_TIME_BUDGET_MS;

  for (const [keywordIndex, { query, label }] of resolvedKeywords.entries()) {
    if (overallCapHit) break;
    if (outOfTime()) { timeBudgetHit = true; break; }

    // FAIR SHARE. Keywords used to run first-come-first-served against a single
    // shared cap, so the first one simply ate the import: asking for 50 leads
    // across 9 industry segments returned 50 from segment one and nothing at all
    // from the eight the manager had deliberately ticked.
    //
    // Each keyword now gets an even slice of whatever budget is LEFT, recomputed
    // per keyword — which is what rolls unspent slots forward automatically. If
    // one segment is thin and yields 2 of its 6, the remaining keywords each get
    // a slightly larger share and the import still finishes at the cap.
    // max_leads_per_keyword stays on top as the per-keyword safety ceiling.
    const keywordsLeft = resolvedKeywords.length - keywordIndex;
    const budgetLeft = maxTotalLeads - inserted;
    if (budgetLeft <= 0) break;
    // No explicit cap => fair share alone. Fair share already bounds a keyword to
    // its even slice, so an extra fixed ceiling only ever subtracts from what the
    // manager asked for.
    const fairShare = Math.ceil(budgetLeft / keywordsLeft);
    const keywordBudget = max_leads_per_keyword
      ? Math.min(fairShare, max_leads_per_keyword)
      : fairShare;

    keywordsSearched++;
    let keywordInserted = 0;
    // Tightened to Apollo's real result count once page 1 tells us what it is.
    let pageCeiling = MAX_PAGES_PER_KEYWORD;
    let apolloTotalForKeyword = 0;
    let pagesRead = 0;

    for (let page = 1; page <= pageCeiling; page++) {
      if (overallCapHit || keywordInserted >= keywordBudget) break;
      // Checked BEFORE the request, never after: stopping once the clock has
      // already run out still leaves the response to be written.
      if (outOfTime()) { timeBudgetHit = true; break; }
      let result;
      try {
        result = await searchPeople({
          keyword: query, locations, page,
          titles: titles ?? undefined,
          seniorities: seniorities ?? undefined,
          advanced,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) return fail(502, "UPSTREAM_APOLLO", "Invalid or non-master Apollo key");
        if (status === 422) return fail(502, "UPSTREAM_APOLLO", (err as Error).message);
        warnings.push(`[${label}] stopped at page ${page}: ${(err as Error).message}`);
        break;
      }

      pagesRead = page;

      if (page === 1) {
        totalEntries += result.total_entries;
        apolloTotalForKeyword = result.total_entries;
        if (result.total_entries === 0) {
          warnings.push(`[${label}] no results — try removing location filter or changing keyword`);
          break;
        }
        // Apollo cannot give us more than it has. Without this, a keyword with
        // 250 results and a 100-lead cap would keep requesting empty pages up
        // to the seatbelt.
        pageCeiling = Math.min(MAX_PAGES_PER_KEYWORD, Math.ceil(result.total_entries / APOLLO_LEADS_PER_PAGE));
      }

      if (!result.people || result.people.length === 0) break;

      const people = result.people.filter((p) => p.has_email);
      // A page of nothing usable is NOT a reason to abandon the keyword — the
      // next page may be full of new leads. Keep paging until the budget is
      // met or Apollo runs out.
      if (people.length === 0) continue;

      // ── Batch dedup ────────────────────────────────────────────────────
      // Deleted leads are read too, but they are NOT duplicates: the person is
      // no longer in the client's list, so they should be findable again. They
      // cannot simply be re-inserted either — uq_leads_company_apollo covers
      // (company_id, apollo_id) with no partial predicate, so the deleted row
      // still owns that key and an insert would be silently swallowed by
      // ignoreDuplicates. They are revived in place instead.
      const apolloIds = people.map((p) => p.id);
      const { data: existing } = await db
        .from("leads").select("id, apollo_id, assigned_to, is_deleted, organization_id").in("apollo_id", apolloIds);

      const activeOwners = new Map<string, string | null>();
      const deletedRows = new Map<string, { id: string; organization_id: string | null }>();
      for (const r of existing ?? []) {
        if (r.is_deleted) deletedRows.set(r.apollo_id as string, { id: r.id as string, organization_id: r.organization_id as string | null });
        else activeOwners.set(r.apollo_id as string, r.assigned_to as string | null);
      }

      let newPeople = people.filter((p) => !activeOwners.has(p.id) && !deletedRows.has(p.id));
      skippedDuplicate += people.filter((p) => activeOwners.has(p.id)).length;
      for (const p of people) {
        if (activeOwners.has(p.id) && duplicateOwners.length < DUPLICATE_SAMPLE_CAP) {
          duplicateOwners.push({
            name: p.first_name || "Unknown",
            company: p.organization?.name ?? "Unknown",
            assigned_to: activeOwners.get(p.id) ?? null,
          });
        }
      }

      // ── Revive previously deleted leads ────────────────────────────────
      // Counted against the import's budget exactly like a fresh lead, because
      // that is what they are from the client's point of view. Ones that still
      // hold an email come back at zero credit cost; the rest re-enter the
      // normal reveal path.
      // The one-lead-per-company rule applies here too. A revived lead occupies
      // a company exactly like a fresh one, and this block runs BEFORE the
      // selection step below, so without this filter a restored lead would be a
      // free pass to a second contact at a company we already cover.
      const revivable = people.filter((p) => {
        if (!deletedRows.has(p.id)) return false;
        const k = orgKey(p.organization?.name);
        if (!k) return true;
        if (blockedOrgKeys.has(k)) { skippedExistingOrg++; return false; }
        if (takenOrgKeys.has(k)) { skippedSameOrg++; return false; }
        return true;
      });
      if (revivable.length > 0) {
        const roomForRevive = Math.min(keywordBudget - keywordInserted, maxTotalLeads - inserted);
        const toRevive = revivable.slice(0, Math.max(0, roomForRevive));
        if (toRevive.length > 0) {
          const reviveIds = toRevive.map((p) => deletedRows.get(p.id)!.id);
          const { data: revived, error: reviveErr } = await db
            .from("leads")
            .update({ is_deleted: false, import_id: importId, updated_at: new Date().toISOString() })
            .in("id", reviveIds)
            .select("id, apollo_id, organization_id");
          if (reviveErr) {
            warnings.push(`[${label}] could not restore ${toRevive.length} previously deleted lead(s): ${reviveErr.message}`);
          } else {
            const count = revived?.length ?? 0;
            recoveredDeleted += count;
            inserted += count;
            keywordInserted += count;
            if (inserted >= maxTotalLeads) overallCapHit = true;
            for (const r of revived ?? []) {
              const person = toRevive.find((p) => p.id === r.apollo_id);
              const revivedKey = orgKey(person?.organization?.name);
              if (revivedKey) takenOrgKeys.add(revivedKey);
              newLeadTargets.push({
                id: r.id as string,
                apollo_id: r.apollo_id as string,
                first_name: person?.first_name ?? null,
                organization_id: r.organization_id as string | null,
                org_name: person?.organization?.name ?? null,
              });
            }
          }
        }
      }
      if (overallCapHit || keywordInserted >= keywordBudget) break;

      // Don't re-add someone we already asked Apollo about and got no email
      // for — that answer doesn't change, so re-inserting them just re-runs
      // the same doomed (and now try-once) email-reveal for a person already
      // parked in the disconnected archive table.
      if (newPeople.length > 0) {
        const { data: alreadyArchived } = await db
          .from("unenrichable_leads").select("apollo_id").in("apollo_id", newPeople.map((p) => p.id));
        const archivedIds = new Set((alreadyArchived ?? []).map((r) => r.apollo_id));
        if (archivedIds.size > 0) {
          skippedUnenrichable += archivedIds.size;
          newPeople = newPeople.filter((p) => !archivedIds.has(p.id));
        }
      }

      if (newPeople.length === 0) continue;

      // ── One lead per company ───────────────────────────────────────────
      // MUST run before the cap trim below. Trimming first would cut the page
      // to the remaining budget and only then collapse it per company, so an
      // import asking for 50 would insert far fewer than 50 — the "I typed 500
      // and got 400" complaint all over again.
      {
        const survivors = newPeople.filter((p) => {
          const k = orgKey(p.organization?.name);
          // No usable company name: keep the person. Dropping them would lose a
          // real prospect over a blank field.
          if (!k) return true;
          if (blockedOrgKeys.has(k)) {
            skippedExistingOrg++;
            if (skippedOrgSample.length < SKIPPED_ORG_SAMPLE_CAP) {
              skippedOrgSample.push(p.organization?.name ?? "Unknown");
            }
            return false;
          }
          return true;
        });

        // Group what is left by company and keep only the best contact at each.
        // Everyone at a company this import already claimed is dropped here too,
        // which is what makes the rule hold across pages and across keywords.
        const byOrg = new Map<string, typeof survivors>();
        const unnamed: typeof survivors = [];
        for (const p of survivors) {
          const k = orgKey(p.organization?.name);
          if (!k) { unnamed.push(p); continue; }
          if (takenOrgKeys.has(k)) { skippedSameOrg++; continue; }
          const bucket = byOrg.get(k);
          if (bucket) bucket.push(p); else byOrg.set(k, [p]);
        }

        const chosen: typeof survivors = [];
        for (const [, candidates] of byOrg) {
          const best = pickBestContact(candidates);
          if (!best) continue;
          // Everyone else at this company is a duplicate we are choosing not
          // to pay a reveal credit for.
          skippedSameOrg += candidates.length - 1;
          chosen.push(best);
        }
        newPeople = [...chosen, ...unnamed];
      }

      if (newPeople.length === 0) continue;

      // Trim to whatever's left of the per-keyword and overall caps so we
      // never insert (and later pay Apollo to reveal) more than requested,
      // even mid-page.
      const roomForKeyword = keywordBudget - keywordInserted;
      const roomOverall = maxTotalLeads - inserted;
      const room = Math.min(roomForKeyword, roomOverall);
      if (room <= 0) break;
      if (newPeople.length > room) {
        if (roomOverall <= roomForKeyword) {
          warnings.push(`Import cap of ${maxTotalLeads} leads reached — stopped partway through "${label}"`);
        }
        newPeople = newPeople.slice(0, room);
      }

      // Batch org lookup.
      // PostgREST's or= list is comma-separated, so an unquoted company name
      // containing a comma or parenthesis — "Reliance Industries, Ltd" — splits
      // the filter into garbage. The query then errors, `data` comes back null,
      // orgMap is empty, and EVERY org on the page is treated as new: that is
      // how the database ended up with more organisations than it has real
      // companies. Double-quote each value and escape what PostgREST reserves.
      const uniqueOrgNames = [...new Set(newPeople.map((p) => p.organization?.name ?? "Unknown"))];
      const orFilter = uniqueOrgNames
        .map((n) => `name.ilike."${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(",");
      const { data: existingOrgs, error: orgLookupError } = await db
        .from("organizations").select("id, name").or(orFilter);
      if (orgLookupError) {
        // Fail loud rather than silently duplicating every org on the page.
        warnings.push(`Org lookup failed for one page: ${orgLookupError.message}`);
      }
      const orgMap = new Map<string, string>();
      for (const org of existingOrgs ?? []) orgMap.set(org.name.toLowerCase(), org.id);
      orgsReused += orgMap.size;

      // Batch insert new orgs
      const missingOrgNames = uniqueOrgNames.filter((n) => !orgMap.has(n.toLowerCase()));
      if (missingOrgNames.length > 0) {
        const { data: newOrgs } = await db
          .from("organizations")
          .insert(missingOrgNames.map((name) => ({
            name,
            enrichment_stage: "queued",
            enrichment_status: "SCRAPE_QUEUED",
            enrichment_attempts: 0,
            created_at: new Date().toISOString(),
          })))
          .select("id, name");
        for (const org of newOrgs ?? []) {
          orgMap.set(org.name.toLowerCase(), org.id);
          newOrgIds.push(org.id);
        }
        orgsCreated += newOrgs?.length ?? 0;
      }

      // Batch insert leads
      const leadsToInsert = newPeople.flatMap((person) => {
        const orgName = person.organization?.name ?? "Unknown";
        const orgId = orgMap.get(orgName.toLowerCase());
        if (!orgId) { warnings.push(`Org not found for "${orgName}"`); return []; }
        return [{
          apollo_id: person.id,
          first_name: person.first_name,
          title: person.title,
          has_email: person.has_email,
          city: person.city ?? null,
          state: person.state ?? null,
          country: person.country ?? null,
          organization_id: orgId,
          lead_source: "apollo",
          created_by: user.id,
          import_id: importId,
          // Deferred assignment: leads land unassigned. The import's stored
          // choice is applied by autoAssignEnrichedLeads once each lead is
          // workable — never here, while it's still a raw "New" shell.
          assigned_to: null,
          assigned_at: null,
          created_at: new Date().toISOString(),
        }];
      });

      if (leadsToInsert.length === 0) continue;

      const { data: insertedLeads, error: insertErr } = await db
        .from("leads")
        .upsert(leadsToInsert, { onConflict: "apollo_id", ignoreDuplicates: true })
        .select("id, apollo_id, organization_id");

      if (insertErr) { warnings.push(`Batch lead insert failed: ${insertErr.message}`); continue; }

      const insertedThisPage = insertedLeads?.length ?? 0;
      inserted += insertedThisPage;
      keywordInserted += insertedThisPage;
      if (inserted >= maxTotalLeads) overallCapHit = true;

      for (const newLead of insertedLeads ?? []) {
        const person = newPeople.find((p) => p.id === newLead.apollo_id);
        const claimedKey = orgKey(person?.organization?.name);
        if (claimedKey) takenOrgKeys.add(claimedKey);
        if (person?.has_email) {
          newLeadTargets.push({
            id: newLead.id,
            apollo_id: person.id,
            first_name: person.first_name,
            organization_id: newLead.organization_id,
            org_name: person.organization?.name ?? null,
          });
        }
      }
    }

    // Why this keyword stopped short, in the client's terms. Distinguishing
    // "Apollo has nothing left" from "we hit our own page seatbelt" matters:
    // the first means change the search, the second means run it again.
    if (!overallCapHit && keywordInserted < keywordBudget && apolloTotalForKeyword > 0) {
      const exhausted = pagesRead >= Math.ceil(apolloTotalForKeyword / APOLLO_LEADS_PER_PAGE);
      warnings.push(
        exhausted
          ? `[${label}] exhausted — Apollo has ${apolloTotalForKeyword.toLocaleString()} matching people and every one is already in your list, so only ${keywordInserted} of ${keywordBudget} were new`
          : `[${label}] page limit reached after ${pagesRead} pages — got ${keywordInserted} of ${keywordBudget}; Apollo holds ${apolloTotalForKeyword.toLocaleString()} matches, so run again to continue`
      );
    }
  }

  const elapsedMs = Date.now() - searchStartedAt;
  if (timeBudgetHit) {
    const unsearched = resolvedKeywords.length - keywordsSearched;
    warnings.unshift(
      `Stopped after ${Math.round(elapsedMs / 1000)}s to finish safely — this import found ${inserted.toLocaleString()} of the ${maxTotalLeads.toLocaleString()} requested`
      + (unsearched > 0 ? `, and ${unsearched} keyword(s) were not searched at all` : "")
      + `. Nothing was lost: run the same search again to carry on from here.`
    );
  }

  // The single most confusing outcome of one-lead-per-company: the manager asks
  // for 500, we skip 3,000 companies they already have, and 150 come back. That
  // is correct and it must never look like a bug, so it is stated first and
  // stored with the import rather than only flashed in the response.
  if (skippedExistingOrg > 0) {
    warnings.unshift(`Skipped ${skippedExistingOrg.toLocaleString()} contact(s) — you already have a working contact at their company. One lead per company is always on.`);
  }
  if (skippedSameOrg > 0) {
    warnings.push(`Skipped ${skippedSameOrg.toLocaleString()} extra contact(s) at companies this import already took someone from — the best-placed contact was kept at each.`);
  }

  if (importId) {
    // warnings explain exactly why a keyword stopped short. They were returned to
    // the browser and lost; now they outlive the request that produced them.
    await db.from("imports").update({
      lead_count: inserted,
      search_warnings: warnings.length > 0 ? warnings : null,
      search_criteria: { ...searchCriteria, elapsed_ms: elapsedMs, pages_time_budget_hit: timeBudgetHit },
    }).eq("id", importId);
    // Same numbers in the log stream, where the watchdog dashboards read from.
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "SEARCH_TIME_BUDGET",
      payload: {
        import_id: importId, elapsed_ms: elapsedMs, budget_ms: SEARCH_TIME_BUDGET_MS,
        hit: timeBudgetHit, inserted, requested: maxTotalLeads,
        keywords_total: resolvedKeywords.length, keywords_searched: keywordsSearched,
      },
    }).then(() => {}, () => {});
  }

  // Assignment is deferred to autoAssignEnrichedLeads (runs per-lead once each
  // is workable, after email-reveal) — nothing is assigned at import time.
  const assignmentSkipped = 0;

  // Seed the activity timeline for every new lead.
  if (newLeadTargets.length > 0) {
    const { logLeadEvents } = await import("@/lib/services/lead-events");
    await logLeadEvents(db, newLeadTargets.map((t) => ({
      leadId: t.id, event: "created" as const, detail: "Imported from Apollo", actorId: user.id,
    })));
  }

  // Phase 1 complete — leads are now in the DB. Fire-and-forget Phase 2A
  // (email reveal) and Phase 2B (org scraping) so the client can redirect.
  const baseUrl = internalAppBaseUrl(req);
  const authHeader = req.headers.get("authorization") ?? "";

  if (importId && newLeadTargets.length > 0 && apolloKey) {
    after(() =>
      fetch(`${baseUrl}/api/v1/leads/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": authHeader },
        body: JSON.stringify({ import_id: importId }),
      }).catch(() => {})
    );
  }

  if (newOrgIds.length > 0) {
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "SCRAPE_QUEUED",
      payload: { total_orgs: newOrgIds.length, org_ids: newOrgIds, triggered_by: "phase1_completion" },
    });
  }

  return ok({
    total_entries: totalEntries,
    inserted,
    // What the manager actually asked for, echoed back so the UI can say
    // "25 requested, 8 imported" without having to remember the request.
    requested: maxTotalLeads,
    skipped: skippedDuplicate,
    skipped_unenrichable: skippedUnenrichable,
    // One lead per company, split by reason so the UI can say which it was.
    skipped_existing_org: skippedExistingOrg,
    skipped_same_org: skippedSameOrg,
    skipped_org_sample: skippedOrgSample,
    recovered_deleted: recoveredDeleted,
    orgs_created: orgsCreated,
    orgs_reused: orgsReused,
    enrich_queued: newLeadTargets.length,
    assignment_skipped: assignmentSkipped,
    duplicate_owners: duplicateOwners,
    // Lets the UI explain "you asked for 50 but only got 40" when Apollo's
    // real balance was lower than the requested cap.
    apollo_credits_remaining: apolloCredits.remaining,
    effective_max_total_leads: maxTotalLeads,
    elapsed_ms: elapsedMs,
    time_budget_hit: timeBudgetHit,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
