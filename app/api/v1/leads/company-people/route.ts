import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { CompanyPeopleSchema } from "@/lib/validators/leads";
import { searchPeople } from "@/lib/services/apollo";
import { getServiceSecret } from "@/lib/services/service-keys";
import { dbForUser } from "@/lib/supabase/scoped";
import { companyLookupTitleRank } from "@/lib/constants";
import { isApolloMockCompany, mockApolloDelay, mockSearchPeople } from "@/lib/services/apollo-mock";

export const maxDuration = 60;

/**
 * Company Lookup, step 2 — who works there.
 *
 * FREE. Apollo's people search costs 0 credits and returns no email addresses,
 * only a `has_email` flag saying one could be bought. Nothing here is written
 * to the database: the candidates live in the browser until the manager picks
 * the handful they want, and only those are inserted.
 *
 * That omission is the whole credit-safety story for this feature. A lead row
 * with has_email=true and email=null IS the instruction to spend a credit —
 * background jobs claim any such row automatically — so staging all twenty
 * candidates as leads "just to show them" would buy twenty reveals nobody
 * asked for. A candidate that is never inserted cannot be billed for.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  // Dev workspace runs on fixtures — see apollo-mock.ts for why the switch is
  // the tenant rather than an env flag.
  const mock = isApolloMockCompany(user.companyId);

  const body = await req.json().catch(() => null);
  const parsed = CompanyPeopleSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const { apollo_org_id, page } = parsed.data;

  if (!mock && !(await getServiceSecret("apollo"))) {
    return fail(503, "UPSTREAM_APOLLO", "Apollo API key not configured — add one in Settings > Keys");
  }

  const db = dbForUser(user);

  // Refuse to list people for a company we already hold. The block belongs
  // here as well as in the UI: this is the request that would otherwise let a
  // client bypass step 2's disabled row and add contacts to an existing org.
  const { data: existingOrg } = await db
    .from("organizations")
    .select("id")
    .eq("apollo_org_id", apollo_org_id)
    .maybeSingle();
  if (existingOrg) {
    return fail(409, "ORG_ALREADY_EXISTS", "This company is already in the system. Company Lookup is for adding companies that are not yet tracked.");
  }

  let result;
  try {
    // Roster mode — organizationIds switches searchPeople off its segment
    // filters (titles/seniorities/employee ranges) so the manager sees everyone
    // at the company and chooses, rather than the system pre-filtering for
    // them. contact_email_status still applies: a person Apollo holds no email
    // for cannot be actioned, so Apollo is asked not to return them at all.
    if (mock) await mockApolloDelay();
    result = mock
      ? mockSearchPeople({ organizationIds: [apollo_org_id] })
      : await searchPeople({ organizationIds: [apollo_org_id], page });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return fail(502, "UPSTREAM_APOLLO", "Invalid or unauthorized Apollo key");
    return fail(502, "UPSTREAM_APOLLO", (err as Error).message);
  }

  // Belt-and-braces on top of contact_email_status: only people Apollo says it
  // holds an address for are worth a credit.
  const people = (result.people ?? []).filter((p) => p.has_email);

  // ── Already-known contacts ───────────────────────────────────────────────
  // Keyed on Apollo person id, tenant-scoped. Not on email (unknown until we
  // pay) and not on name (the surname is masked at this stage).
  const ids = people.map((p) => p.id);
  const alreadyLead = new Set<string>();
  const alreadyArchived = new Set<string>();

  if (ids.length > 0) {
    const [leadRows, archivedRows] = await Promise.all([
      db.from("leads").select("apollo_id").in("apollo_id", ids).eq("is_deleted", false),
      db.from("unenrichable_leads").select("apollo_id").in("apollo_id", ids),
    ]);
    for (const r of leadRows.data ?? []) alreadyLead.add(r.apollo_id as string);
    for (const r of archivedRows.data ?? []) alreadyArchived.add(r.apollo_id as string);
  }

  const contacts = people
    .map((p) => ({
      apollo_id: p.id,
      first_name: p.first_name,
      // Apollo masks the surname until the reveal is paid for.
      last_name_masked: p.last_name_obfuscated ?? null,
      title: p.title,
      city: p.city ?? null,
      state: p.state ?? null,
      country: p.country ?? null,
      organization_name: p.organization?.name ?? null,
      already_imported: alreadyLead.has(p.id),
      // Previously paid for and confirmed to have no usable email — offering
      // it again would sell the same dead answer twice.
      unenrichable: alreadyArchived.has(p.id),
    }))
    .sort((a, b) => {
      const ra = companyLookupTitleRank(a.title);
      const rb = companyLookupTitleRank(b.title);
      // Apollo returns no seniority field, so ordering is derived from the
      // title string. Equal ranks keep Apollo's own order (stable sort).
      return ra - rb;
    });

  return ok({
    contacts,
    total_entries: result.total_entries,
    selectable: contacts.filter((c) => !c.already_imported && !c.unenrichable).length,
    credits_spent: 0,
    mock,
  });
}
