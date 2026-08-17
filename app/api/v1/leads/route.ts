import { NextRequest, after } from "next/server";
import crypto from "crypto";
import { requireAuth, requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CreateLeadSchema, LeadListQuerySchema } from "@/lib/validators/leads";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { normalizeDomain } from "@/lib/utils/domain";
import { logLeadEvent } from "@/lib/services/lead-events";
import { getServiceSecret } from "@/lib/services/service-keys";
import { onlyRevealedLeads } from "@/lib/server/lead-visibility";
import { dbForUser } from "@/lib/supabase/scoped";

async function upsertOrg(
  db: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  name: string,
  domain: string | undefined,
  userId: string,
  industry?: string,
  country?: string,
) {
  // normalizeDomain() returns "" (not null) for unparseable/email-shaped
  // input — coerce that back to null so an empty string never lands in the
  // domain column instead of a real null.
  const normalizedDomain = domain ? (normalizeDomain(domain) || null) : null;

  if (normalizedDomain) {
    const { data: existing } = await db
      .from("organizations")
      .select("id")
      .eq("domain", normalizedDomain)
      .maybeSingle();
    if (existing) {
      if (industry || country) {
        await db.from("organizations").update({
          ...(industry ? { industry } : {}),
          ...(country ? { country } : {}),
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id);
      }
      return existing.id as string;
    }
  }

  const { data: byName } = await db
    .from("organizations")
    .select("id")
    .ilike("name", name)
    .is("apollo_org_id", null)
    .maybeSingle();
  if (byName) {
    if (industry || country || normalizedDomain) {
      await db.from("organizations").update({
        ...(normalizedDomain ? { domain: normalizedDomain, domain_source: "manual" } : {}),
        ...(industry ? { industry } : {}),
        ...(country ? { country } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", byName.id);
    }
    return byName.id as string;
  }

  const { data: created, error } = await db
    .from("organizations")
    .insert({
      name,
      domain: normalizedDomain,
      domain_source: normalizedDomain ? "manual" : null,
      ...(industry ? { industry } : {}),
      ...(country ? { country } : {}),
      // Queued either way. A manual entry always carries an email, and a work
      // address gives up the company domain for free (sales@maapet.com ->
      // maapet.com), so a missing website is something scrape-orgs' domain
      // resolution can fix — not a reason to skip the pipeline. Leaving the
      // stage null meant no website typed in = never enriched, ever.
      enrichment_stage: "queued",
      enrichment_status: "SCRAPE_QUEUED",
      enrichment_attempts: 0,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return created.id as string;
}

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = LeadListQuerySchema.safeParse(sp);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());

  const { country, email_status, lead_source, organization_id, email_domain_catchall, import_id, created_after, assigned_to, statuses, sources, import_ids, created_before, q: search, page, limit } = parsed.data;
  const db = dbForUser(user);

  let q = onlyRevealedLeads(
    db
      .from("leads")
      .select(
        // !lead_id: campaign_leads also FKs to leads via replaced_by_lead_id.
        `*, organizations(id, name, domain, domain_source, unsubscribed, has_scraped, enrichment_stage, company_description, sells_to, last_error),
         campaign_leads!lead_id(crm_status, interest_status, created_at, campaigns(id, name)),
         imports(id, label, color)`,
        { count: "exact" }
      )
      .eq("is_deleted", false)
  );

  if (user.role === "employee") {
    // Employees see ONLY their own assigned leads (spec §5). Unibox threads and
    // drafts are likewise scoped to their assigned leads, so the whole
    // employee surface is consistently lead-assignment based — no seeing a
    // co-worker's leads just because they share a campaign.
    q = q.eq("assigned_to", user.id);
  } else if (assigned_to === "unassigned") {
    q = q.is("assigned_to", null);
  } else if (assigned_to) {
    q = q.eq("assigned_to", assigned_to);
  }

  if (country) q = q.eq("country", country);
  if (email_status) q = q.eq("email_status", email_status);
  if (lead_source) q = q.eq("lead_source", lead_source);
  if (organization_id) q = q.eq("organization_id", organization_id);
  if (email_domain_catchall !== undefined) q = q.eq("email_domain_catchall", email_domain_catchall === "true");
  if (import_id) q = q.eq("import_id", import_id);
  if (created_after) q = q.gte("created_at", created_after);

  // Multi-select equivalents of the four above, used by the Leads page filters.
  if (statuses?.length) q = q.in("status", statuses);
  if (sources?.length) q = q.in("lead_source", sources);
  if (import_ids?.length) q = q.in("import_id", import_ids);
  if (created_before) q = q.lte("created_at", created_before);

  if (search) {
    // Escape ilike wildcards so literal % / _ in the search text aren't
    // treated as wildcards, and strip characters that are structurally
    // significant to PostgREST's .or() mini-DSL (commas separate
    // conditions, parens group them) so a search string can't be crafted
    // into an unintended filter.
    const escaped = search.replace(/[%_]/g, (c) => `\\${c}`).replace(/[,()]/g, " ").trim();
    // Match org name against the whole phrase (e.g. searching a company
    // name), but match person fields word-by-word so "Richard Wise" finds
    // first_name=Richard/last_name=Wise even though neither column holds
    // the full string on its own.
    const { data: matchingOrgs } = await db.from("organizations").select("id").ilike("name", `%${escaped}%`);
    const orgIds = (matchingOrgs ?? []).map((o) => o.id as string);
    const words = escaped.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const word of words) {
      const orParts = [
        `first_name.ilike.%${word}%`,
        `last_name.ilike.%${word}%`,
        `email.ilike.%${word}%`,
        `title.ilike.%${word}%`,
      ];
      if (orgIds.length) orParts.push(`organization_id.in.(${orgIds.join(",")})`);
      q = q.or(orParts.join(","));
    }
  }

  q = q.order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1);

  const { data, error, count } = await q;
  if (error) return fail(500, "INTERNAL", error.message);

  const leads = (data ?? []).map((l) => {
    const cls = (l.campaign_leads ?? []) as { crm_status: string; created_at: string; campaigns: { id: string; name: string } | null }[];
    return {
      ...l,
      campaign_list: cls
        .filter((cl) => cl.campaigns)
        .map((cl) => ({ id: cl.campaigns!.id, name: cl.campaigns!.name, crm_status: cl.crm_status, added_at: cl.created_at })),
    };
  });

  return ok({ leads, total: count, page, limit });
}

// Manual lead-add is a manager/super-admin action, same as every other
// lead-add path (Apollo search, Excel import, bulk-assign) — employees are
// execution-only and cannot add leads (spec §1).
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = CreateLeadSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { organization_name, organization_domain, organization_industry, organization_country, email, batch_name, color, import_id: providedImportId, assigned_to: requestedAssignedTo, ...leadFields } = parsed.data;
  const assigned_to = requestedAssignedTo ?? null;
  const db = dbForUser(user);

  // A manager-supplied assignee must be a real, active user — same check the
  // Apollo/Excel import paths perform.
  if (assigned_to) {
    const { data: assignee } = await db
      .from("profiles")
      .select("id, is_active")
      .eq("id", assigned_to)
      .maybeSingle();
    if (!assignee || !assignee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  // Check email uniqueness among live leads only — a soft-deleted lead must not
  // block re-adding the same person later.
  const { data: existing } = await db
    .from("leads")
    .select("id")
    .eq("email", email.toLowerCase())
    .eq("is_deleted", false)
    .maybeSingle();
  if (existing) return fail(409, "DUPLICATE", "A lead with this email already exists", { id: existing.id });

  let organizationId: string;
  try {
    organizationId = await upsertOrg(db, organization_name, organization_domain, user.id, organization_industry, organization_country);
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }

  const apolloId = `manual_${crypto.randomUUID()}`;

  let importId: string | null = providedImportId ?? null;
  if (!importId && batch_name?.trim()) {
    const { data: imp } = await db.from("imports")
      .insert({ label: batch_name.trim(), source: "manual", created_by: user.id, lead_count: 0, color: color ?? "violet" })
      .select("id").single();
    importId = imp?.id ?? null;
  }

  const { data, error } = await db
    .from("leads")
    .insert({
      ...leadFields,
      email: email.toLowerCase(),
      organization_id: organizationId,
      apollo_id: apolloId,
      lead_source: "manual",
      created_by: user.id,
      import_id: importId,
      assigned_to: assigned_to ?? null,
      assigned_at: assigned_to ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return fail(500, "INTERNAL", error.message);

  await logLeadEvent(db, data.id, "created", "Added manually", { actorId: user.id });
  if (assigned_to) {
    await logLeadEvent(db, data.id, "assigned", "Assigned to an employee", { actorId: user.id, metadata: { assignee_id: assigned_to } });
  }

  if (importId) {
    await db.from("imports").update({ lead_count: 1 }).eq("id", importId);
  }

  // Fire enrichment regardless of whether a domain was typed in — scrape-orgs
  // resolves a missing one from the lead's own email before it claims anything.
  if (process.env.INTERNAL_SECRET && (await getServiceSecret("firecrawl"))) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  return ok(data);
}
