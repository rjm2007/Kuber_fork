import type { SupabaseClient } from "@supabase/supabase-js";
import { mapDbLead, type DbLead } from "@/lib/mappers";
import { onlyRevealedLeads } from "@/lib/server/lead-visibility";

// campaign_leads has two FKs to leads (lead_id, and replaced_by_lead_id for
// bounce replacements). PostgREST will not embed unless we hint which one.
const LEAD_SELECT = `*, organizations(id, name, domain, unsubscribed, has_scraped,
  enrichment_stage, company_description, sells_to, last_error),
  campaign_leads!lead_id(crm_status, interest_status, created_at, campaigns(id, name)),
  imports(id, label, color)`;

export async function getLeads(
  db: SupabaseClient,
  opts: { limit?: number; page?: number; organizationId?: string } = {},
) {
  const { limit = 200, page = 1, organizationId } = opts;
  let q = onlyRevealedLeads(db.from("leads").select(LEAD_SELECT, { count: "exact" }).eq("is_deleted", false));
  if (organizationId) q = q.eq("organization_id", organizationId);
  q = q.order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return { leads: (data ?? []).map((l) => mapDbLead(l as unknown as DbLead)), total: count ?? 0 };
}
