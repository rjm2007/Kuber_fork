import { NextRequest, after } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { CompanyImportSchema } from "@/lib/validators/leads";
import { dbForUser } from "@/lib/supabase/scoped";
import { normalizeDomain } from "@/lib/utils/domain";
import { isApolloMockCompany, mockRevealedEmail } from "@/lib/services/apollo-mock";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { getServiceSecret } from "@/lib/services/service-keys";

export const maxDuration = 60;

/**
 * Company Lookup, step 3 — create the leads.
 *
 * Only the contacts the manager actually ticked arrive here, and only those
 * are inserted. Everything else Apollo returned was never persisted anywhere,
 * which is what makes the credit ceiling real: every enrichment selector reads
 * exclusively from `leads`, so a candidate that was never inserted is
 * structurally invisible to the paid reveal. The 5-contact cap is enforced by
 * CompanyImportSchema, server-side, not by the checkboxes.
 *
 * From the insert onward this is an ordinary Apollo import — same
 * lead_source, same shape, same pipeline. `lead_source = 'apollo'` is
 * load-bearing rather than cosmetic: both the enrich route and the daily
 * rescue watchdog filter on it, so any other value would leave these leads
 * permanently un-revealed and un-rescued.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const mock = isApolloMockCompany(user.companyId);

  const body = await req.json().catch(() => null);
  const parsed = CompanyImportSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { organization, contacts, batch_name, color, assigned_to, assignment_strategy } = parsed.data;
  const db = dbForUser(user);

  const domain = organization.domain ? safeDomain(organization.domain) : null;

  // ── Existing-organization block (V1 decision) ────────────────────────────
  // Re-checked here, not trusted from the client. Matching is by Apollo org id
  // then domain — the two fields carrying uniqueness constraints — never by
  // name, since name collision is the premise of this feature.
  const { data: byApolloOrg } = await db
    .from("organizations").select("id").eq("apollo_org_id", organization.apollo_org_id).maybeSingle();
  if (byApolloOrg) {
    return fail(409, "ORG_ALREADY_EXISTS", "This company is already in the system.");
  }
  if (domain) {
    const { data: byDomain } = await db
      .from("organizations").select("id").eq("domain", domain).maybeSingle();
    if (byDomain) {
      return fail(409, "ORG_ALREADY_EXISTS", "A company with this website is already in the system.");
    }
  }

  if (assigned_to) {
    const { data: employee } = await db.from("profiles").select("id, is_active").eq("id", assigned_to).maybeSingle();
    if (!employee || !employee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  // ── Drop contacts we already hold ────────────────────────────────────────
  // Re-checked server-side: the browser's copy of this list can be minutes old,
  // and paying twice for the same person is exactly what this guards against.
  const apolloIds = contacts.map((c) => c.apollo_id);
  const [leadRows, archivedRows] = await Promise.all([
    db.from("leads").select("apollo_id").in("apollo_id", apolloIds).eq("is_deleted", false),
    db.from("unenrichable_leads").select("apollo_id").in("apollo_id", apolloIds),
  ]);
  const known = new Set<string>([
    ...(leadRows.data ?? []).map((r) => r.apollo_id as string),
    ...(archivedRows.data ?? []).map((r) => r.apollo_id as string),
  ]);
  const fresh = contacts.filter((c) => !known.has(c.apollo_id));
  if (fresh.length === 0) {
    return fail(409, "ALL_CONTACTS_KNOWN", "Every selected contact is already in the system.");
  }

  // ── Organization ─────────────────────────────────────────────────────────
  // The scoped client stamps company_id. A 23505 here means another request
  // created the same org between the checks above and this insert — recover by
  // reading it back rather than failing the import, but never blind-insert a
  // second row (both apollo_org_id and domain are unique per tenant).
  const { data: newOrg, error: orgErr } = await db.from("organizations").insert({
    apollo_org_id: organization.apollo_org_id,
    name: organization.name,
    domain,
    domain_source: domain ? "apollo" : null,
    website: organization.website ?? null,
    industry: organization.industry ?? null,
    employees: organization.employees ?? null,
    city: organization.city ?? null,
    // No `state` column on organizations — only city and country. The state
    // Apollo returns is still kept per-contact on the lead rows below, which
    // do have the column.
    country: organization.country ?? null,
    // A mock company's domain does not exist, so it must never be queued for
    // scraping — Firecrawl bills per attempt and would burn real credits on a
    // fixture. Landing it as already-done keeps it out of the scrape worker.
    enrichment_stage: mock ? "done" : "queued",
    enrichment_status: mock ? "ENRICHMENT_COMPLETE" : "SCRAPE_QUEUED",
    enrichment_attempts: 0,
    created_at: new Date().toISOString(),
  }).select("id").single();

  let orgId = newOrg?.id as string | undefined;
  if (orgErr) {
    if (orgErr.code !== "23505") {
      return fail(500, "INTERNAL", `Could not create organization: ${orgErr.message}`);
    }
    const { data: raced } = await db
      .from("organizations").select("id").eq("apollo_org_id", organization.apollo_org_id).maybeSingle();
    orgId = raced?.id as string | undefined;
  }
  if (!orgId) return fail(500, "INTERNAL", "Could not resolve the organization record");

  // ── Import batch ─────────────────────────────────────────────────────────
  // Assignment is deferred exactly as it is for the keyword import: the choice
  // is stored on the batch and applied per lead once each becomes workable,
  // after the paid reveal — never to a raw shell with no confirmed email.
  const { data: importRow } = await db.from("imports").insert({
    label: batch_name,
    source: "apollo",
    created_by: user.id,
    lead_count: 0,
    color,
    assignment_strategy: assigned_to ? "manual" : (assignment_strategy ?? null),
    assignment_target: assigned_to ?? null,
  }).select("id").single();
  const importId = importRow?.id as string | undefined;

  // ── Leads ────────────────────────────────────────────────────────────────
  // has_email is written EXPLICITLY. The column is nullable with no database
  // default, and every enrichment selector matches `has_email = true`, so an
  // omitted field would produce a lead that looks imported but is never
  // revealed and never errors.
  const { data: inserted, error: insertErr } = await db
    .from("leads")
    .upsert(
      fresh.map((c) => ({
        apollo_id: c.apollo_id,
        first_name: c.first_name ?? null,
        title: c.title ?? null,
        // MOCK: the address is written now, not left for the reveal. A row with
        // has_email=true / email=null IS the instruction to spend a credit, and
        // the background watchdog neither knows nor cares that the lead came
        // from a fixture — it would happily pay Apollo to look up "mock_person_…".
        // Writing the email up front keeps the row permanently ineligible.
        has_email: true,
        email: mock ? mockRevealedEmail(c.first_name ?? null, domain) : null,
        email_status: mock ? "verified" : null,
        city: c.city ?? null,
        state: c.state ?? null,
        country: c.country ?? null,
        organization_id: orgId,
        lead_source: "apollo",
        created_by: user.id,
        import_id: importId ?? null,
        assigned_to: null,
        assigned_at: null,
        created_at: new Date().toISOString(),
      })),
      { onConflict: "apollo_id", ignoreDuplicates: true },
    )
    .select("id, apollo_id");

  if (insertErr) return fail(500, "INTERNAL", `Could not create leads: ${insertErr.message}`);

  const leads = inserted ?? [];
  if (importId && leads.length > 0) {
    await db.from("imports").update({ lead_count: leads.length }).eq("id", importId);
  }

  if (leads.length > 0) {
    const { logLeadEvents } = await import("@/lib/services/lead-events");
    await logLeadEvents(db, leads.map((l) => ({
      leadId: l.id as string,
      event: "created" as const,
      detail: mock
        ? `MOCK import — Company Lookup (${organization.name}). Fixture data, no Apollo credits spent.`
        : `Imported from Apollo — Company Lookup (${organization.name})`,
      actorId: user.id,
    })));
  }

  // Hand off to the existing reveal. Keyed on import_id rather than lead_ids so
  // the batch inherits the self-chaining and the once-a-day rescue job that
  // already cover a pass dying mid-run.
  const baseUrl = internalAppBaseUrl(req);
  const authHeader = req.headers.get("authorization") ?? "";
  // Never in mock mode: these leads already carry their email, so the reveal
  // would find nothing to claim — but calling it at all is a paid code path
  // pointed at fabricated Apollo ids, and not calling it is free.
  if (!mock && importId && leads.length > 0 && (await getServiceSecret("apollo"))) {
    after(() =>
      fetch(`${baseUrl}/api/v1/leads/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": authHeader },
        body: JSON.stringify({ import_id: importId }),
      }).catch(() => {})
    );
  }

  return ok({
    import_id: importId,
    organization_id: orgId,
    inserted: leads.length,
    skipped_known: contacts.length - fresh.length,
    // What the reveal is about to cost, so the UI can state it plainly.
    reveal_credits_queued: mock ? 0 : leads.length,
    mock,
  });
}

function safeDomain(raw: string): string {
  try { return normalizeDomain(raw); } catch { return raw.trim().toLowerCase(); }
}
