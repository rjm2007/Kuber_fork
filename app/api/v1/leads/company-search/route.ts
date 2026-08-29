import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { CompanySearchSchema } from "@/lib/validators/leads";
import { searchOrganizations } from "@/lib/services/apollo";
import { getServiceSecret } from "@/lib/services/service-keys";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";
import { normalizeDomain } from "@/lib/utils/domain";
import { isApolloMockCompany, mockApolloDelay, mockSearchOrganizations } from "@/lib/services/apollo-mock";
import { saveApolloRawRecords } from "@/lib/services/apollo-raw";

export const maxDuration = 60;

/**
 * Company Lookup, step 1 — find the company.
 *
 * This is the ONLY user-triggered route in the app besides the keyword search
 * that spends an Apollo credit up front, and unlike people search it is billed
 * PER PAGE REQUESTED rather than per result: a page that returns three
 * companies costs exactly what a page returning a hundred does. So the request
 * always asks for Apollo's maximum page size (searchOrganizations pins it) and
 * every additional page is a separate, deliberate call from the client.
 *
 * Apollo charges nothing when a search matches no companies — measured against
 * the live account on 18 Aug 2026 (see
 * scripts/apollo-zero-result-credit-probe.ts: balance 3959 before and after a
 * zero-match page), not inferred — so the paid ledger row below is written only
 * when results actually come back. Every other outcome still gets a `system`
 * row, because a lookup that produced nothing is the one a manager asks about.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  // provider_keys are shared across tenants, so an internal-workspace search
  // would spend the live client's credits. Rather than a flat 403, the dev
  // workspace runs the whole feature against fixtures — same flow, no bill.
  const mock = isApolloMockCompany(user.companyId);

  const body = await req.json().catch(() => null);
  const parsed = CompanySearchSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { name, country, website, page, advanced } = parsed.data;
  const locations = country?.length ? country : undefined;

  // Mock mode needs no key and no balance — there is nothing to spend.
  if (!mock && !(await getServiceSecret("apollo", "any" /* one shared Apollo account */))) {
    return fail(503, "UPSTREAM_APOLLO", "Apollo API key not configured — add one in Settings > Keys");
  }

  const db = dbForUser(user);

  // A manager clicking Search has usually just topped up if they were empty,
  // so read fresh rather than serving a stale "out of credits".
  const credits = mock
    ? { ok: true, remaining: null as number | null, message: "mock" }
    : await checkApolloCredits(db, { fresh: true });
  if (!credits.ok) {
    return fail(402, "APOLLO_OUT_OF_CREDITS", credits.message);
  }

  let result;
  try {
    if (mock) await mockApolloDelay();
    result = mock
      ? mockSearchOrganizations({ name, locations, page })
      : await searchOrganizations({
          name,
          locations,
          // Apollo wants a bare domain here, not a pasted URL.
          domains: website ? [safeDomain(website)] : undefined,
          page,
          advanced,
        });
  } catch (err) {
    const status = (err as { status?: number }).status;
    // A lookup that fails has to leave a trace. On 18 Aug 2026 a manager
    // reported "I ran two or three lookups and only one returned anything", and
    // the answer had to be reconstructed from the Apollo credit balance —
    // because this route logged nothing except successes with results. Logged
    // under `system`, not `apollo`: Settings > Keys > Usage sums
    // payload.credits_consumed across every apollo-source row without filtering
    // on event name, and a failed call must not appear in the spend total.
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "COMPANY_LOOKUP_FAILED",
      payload: {
        stage: "company_search",
        query: name,
        country: locations ?? null,
        website: website ?? null,
        page,
        status: status ?? null,
        error: (err as Error).message.slice(0, 500),
        credits_consumed: 0,
      },
    });
    if (status === 401) return fail(502, "UPSTREAM_APOLLO", "Invalid or unauthorized Apollo key");
    if (status === 403) return fail(502, "UPSTREAM_APOLLO", "This Apollo plan does not allow organization search");
    return fail(502, "UPSTREAM_APOLLO", (err as Error).message);
  }

  const orgs = result.organizations;

  await saveApolloRawRecords(
    db,
    "organization",
    orgs.map((o) => ({ apollo_id: o.id, payload: o.raw })),
  );

  // ── Ledger ───────────────────────────────────────────────────────────────
  // Settings > Keys > Usage sums payload.credits_consumed across every
  // apollo-source row without filtering on event name, so this must be exactly
  // ONE row per paid page: a second row double-counts, a missing row hides the
  // spend. Apollo bills nothing for an empty result — measured, not assumed,
  // on 18 Aug 2026 (scripts/apollo-zero-result-credit-probe.ts) — so an empty
  // search writes a `system` row that carries the facts without touching the
  // spend total.
  // A mock search spends nothing, so it must never write an apollo-source row:
  // Usage sums payload.credits_consumed across those without filtering on event
  // name, and a fake credit there would corrupt the one number this whole
  // exercise exists to keep honest. Logged under `system` instead.
  if (mock) {
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "COMPANY_LOOKUP_MOCK",
      payload: { stage: "company_search", query: name, page, returned: orgs.length, credits_consumed: 0 },
    });
  } else if (orgs.length > 0) {
    await db.from("enrichment_logs").insert({
      source: "apollo",
      event: "CREDITS_CONSUMED",
      payload: {
        stage: "company_search",
        query: name,
        country: locations ?? null,
        website: website ?? null,
        page,
        returned: orgs.length,
        total_entries: result.pagination.total_entries,
        credits_consumed: 1,
        balance_before: credits.remaining,
      },
    });
  } else {
    // Zero matches. Free (probed), so it belongs under `system` where it cannot
    // move the spend total — but it must still be recorded, or a manager's
    // "nothing came back" leaves no evidence anywhere. `balance_after` is the
    // reading we already took before the call; if it ever drifts against a run
    // of these rows, the "empty search is free" finding needs re-testing.
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "COMPANY_LOOKUP_NO_RESULTS",
      payload: {
        stage: "company_search",
        query: name,
        country: locations ?? null,
        website: website ?? null,
        page,
        returned: 0,
        total_entries: result.pagination.total_entries,
        credits_consumed: 0,
        balance_after: credits.remaining,
      },
    });
  }

  // ── "Already in system" ──────────────────────────────────────────────────
  // Matched on Apollo org id first, then domain — the two fields carrying
  // uniqueness constraints. NOT on name: name collision is the entire reason
  // this feature exists, so a name match says nothing. Both reads go through
  // the scoped client, so another tenant's organizations can never match.
  const apolloIds = orgs.map((o) => o.id);
  const domains = orgs
    .map((o) => (o.primary_domain ? safeDomain(o.primary_domain) : null))
    .filter((d): d is string => !!d);

  const existingApolloIds = new Set<string>();
  const existingDomains = new Set<string>();

  if (apolloIds.length > 0) {
    const { data } = await db
      .from("organizations")
      .select("apollo_org_id")
      .in("apollo_org_id", apolloIds);
    for (const r of data ?? []) if (r.apollo_org_id) existingApolloIds.add(r.apollo_org_id as string);
  }
  if (domains.length > 0) {
    const { data } = await db
      .from("organizations")
      .select("domain")
      .in("domain", domains);
    for (const r of data ?? []) if (r.domain) existingDomains.add((r.domain as string).toLowerCase());
  }

  const companies = orgs.map((o) => {
    const domain = o.primary_domain ? safeDomain(o.primary_domain) : null;
    const existing =
      existingApolloIds.has(o.id) ||
      (!!domain && existingDomains.has(domain.toLowerCase()));
    return {
      apollo_org_id: o.id,
      name: o.name,
      domain,
      website: o.website_url,
      blog_url: o.blog_url,
      angellist_url: o.angellist_url,
      linkedin_url: o.linkedin_url,
      twitter_url: o.twitter_url,
      facebook_url: o.facebook_url,
      crunchbase_url: o.crunchbase_url,
      logo_url: o.logo_url,
      employees: o.estimated_num_employees,
      city: o.city,
      state: o.state,
      country: o.country,
      industry: o.industry,
      founded_year: o.founded_year,
      // Blocked from selection in V1: Company Lookup exists to bring in a
      // company we do NOT already have. The UI shows it, disabled.
      already_in_system: existing,
    };
  });

  return ok({
    companies,
    page: result.pagination.page,
    total_entries: result.pagination.total_entries,
    total_pages: result.pagination.total_pages,
    credits_spent: mock ? 0 : (orgs.length > 0 ? 1 : 0),
    apollo_credits_remaining: credits.remaining,
    // Surfaced so the wizard can label the data as fixtures — nobody should
    // mistake a mock company for a real one.
    mock,
  });
}

/** normalizeDomain throws on input that isn't a domain (e.g. an email pasted
 *  into the website box). A bad optional filter must not 500 the search. */
function safeDomain(raw: string): string {
  try { return normalizeDomain(raw); } catch { return raw.trim().toLowerCase(); }
}
