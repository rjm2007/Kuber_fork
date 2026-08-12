import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { AddLeadsToCampaignSchema, CampaignLeadsQuerySchema, PatchCampaignLeadSchema } from "@/lib/validators/campaigns";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

const TERMINAL_STATUSES = new Set(["completed", "paused"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const parsed = CampaignLeadsQuerySchema.safeParse(sp);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid query", parsed.error.flatten());

  const { crm_status, page, limit } = parsed.data;

  // Fetch campaign default attachment (once)
  const { data: campaign } = await db
    .from("campaigns")
    .select("attachment_name, attachment_size, attachment_mime, attachment_url")
    .eq("id", id).maybeSingle();

  let q = db
    .from("campaign_leads")
    .select(
      `*, attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
       email_drafts(id, subject, body, status, created_at, step_number),
       leads!inner(first_name, last_name, email, title, country, assigned_to, organizations(name))`,
      { count: "exact" }
    )
    .eq("campaign_id", id);

  // A campaign is a container spanning multiple employees (spec §5) — an
  // employee sees ONLY their own leads within it, never a co-worker's.
  if (user.role === "employee") q = q.eq("leads.assigned_to", user.id);

  if (crm_status) q = q.eq("crm_status", crm_status);
  q = q.order("created_at", { ascending: false }).range((page - 1) * limit, page * limit - 1);

  const { data, error, count } = await q;
  if (error) return fail(500, "INTERNAL", error.message);

  // A draft that is mid-generation is invisible through the embed above.
  // campaign_leads.draft_id is only repointed once generation SUCCEEDS, so:
  //   - a first-time draft has draft_id = null            → embed returns nothing
  //   - a regeneration leaves draft_id on the old row,
  //     which regenerateOneDraft has just demoted to
  //     'rejected' so the new row can take its place      → embed returns 'rejected'
  // Both render as "No draft" in the outbox until the LLM returns, which reads
  // as "the draft was deleted" rather than "we're working on it". Surface the
  // in-flight row separately so the UI can say Generating / Regenerating.
  const { data: inFlight } = await db
    .from("email_drafts")
    .select("lead_id, version, parent_draft_id, step_number")
    .eq("campaign_id", id)
    .eq("status", "generating");

  // version > 1 / a parent row is what distinguishes "make me a new draft" from
  // "replace the one you already showed me".
  const activityByLead = new Map<string, "generating" | "regenerating">();
  for (const d of inFlight ?? []) {
    if ((d.step_number ?? 1) !== 1) continue;
    const isRegen = !!d.parent_draft_id || (d.version ?? 1) > 1;
    activityByLead.set(d.lead_id as string, isRegen ? "regenerating" : "generating");
  }

  function mapLeadRow(
    raw: Record<string, unknown> | null,
  ): { first_name: string | null; last_name: string | null; email: string | null; title: string | null; country: string | null; company_name: string | null } | null {
    if (!raw) return null;
    const org = raw.organizations as { name?: string | null } | { name?: string | null }[] | null | undefined;
    const company_name = (Array.isArray(org) ? org[0]?.name : org?.name) ?? null;
    const { organizations: _org, ...lead } = raw;
    return { ...lead, company_name } as ReturnType<typeof mapLeadRow>;
  }

  // Compute resolved attachment per lead
  const items = (data ?? []).map((cl: Record<string, unknown>) => ({
    ...cl,
    leads: mapLeadRow(cl.leads as Record<string, unknown> | null),
    draft_activity: activityByLead.get(cl.lead_id as string) ?? null,
    attachment: {
      perLead: cl.attachment_name
        ? { name: cl.attachment_name, size: cl.attachment_size, mime: cl.attachment_mime }
        : null,
      campaignDefault: campaign?.attachment_name
        ? { name: campaign.attachment_name, size: campaign.attachment_size, mime: campaign.attachment_mime }
        : null,
      effective: cl.attachment_name
        ? { name: cl.attachment_name, size: cl.attachment_size, url: cl.attachment_url ?? null, source: "lead" as const }
        : campaign?.attachment_name
        ? { name: campaign.attachment_name, size: campaign.attachment_size, url: campaign.attachment_url ?? null, source: "campaign" as const }
        : null,
    },
  }));

  return ok({ campaign_leads: items, total: count, page, limit });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = AddLeadsToCampaignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  // Validate campaign status
  const { data: campaign } = await db.from("campaigns").select("status").eq("id", id).maybeSingle();
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");
  if (TERMINAL_STATUSES.has(campaign.status)) {
    return fail(409, "CONFLICT", `Cannot add leads to a campaign in status '${campaign.status}'`);
  }

  const added: string[] = [];
  const notFound: string[] = [];
  const blockedUnsubscribed: string[] = [];
  const blockedNotEnriched: string[] = [];
  const skippedExisting: string[] = [];

  const leadIds = parsed.data.lead_ids;

  // Bulk-fetch all leads in one query — employees can only add leads assigned to them.
  let leadsQuery = db
    .from("leads")
    .select("id, email, status, organization_id, assigned_to, organizations(domain, enrichment_stage, unsubscribed)")
    .in("id", leadIds);
  if (user.role === "employee") leadsQuery = leadsQuery.eq("assigned_to", user.id);
  const { data: leads } = await leadsQuery;

  const leadMap = new Map((leads ?? []).map((l) => [l.id, l]));

  // Check existing campaign_leads in bulk
  const { data: existingCls } = await db
    .from("campaign_leads")
    .select("lead_id")
    .eq("campaign_id", id)
    .in("lead_id", leadIds);
  const existingSet = new Set((existingCls ?? []).map((r) => r.lead_id));

  const toInsert: object[] = [];
  const now = new Date().toISOString();

  for (const leadId of leadIds) {
    if (!leadMap.has(leadId)) { notFound.push(leadId); continue; }
    if (existingSet.has(leadId)) { skippedExisting.push(leadId); continue; }

    const lead = leadMap.get(leadId)!;
    const org = Array.isArray(lead.organizations) ? lead.organizations[0] : lead.organizations;

    if (org?.unsubscribed) { blockedUnsubscribed.push(leadId); continue; }

    // Eligible = has an email AND is either enriched (→ AI-personalised draft) or
    // input_required (no usable company profile → generic name-swap template).
    // New / enriching leads are still in the enrichment pipeline and are blocked.
    const isEligible = !!lead.email && (lead.status === "enriched" || lead.status === "input_required");
    if (!isEligible) { blockedNotEnriched.push(leadId); continue; }

    toInsert.push({ campaign_id: id, lead_id: leadId, crm_status: "enriched", created_by: user.id, created_at: now });
    added.push(leadId);
  }

  // Warn (don't block — planning: a lead may legitimately be in >1 campaign)
  // when a lead we're adding is ALREADY in another live campaign, so the
  // manager knows this person will receive more than one sequence. Ownership
  // can't split across employees here: lead visibility is lead-based, so every
  // campaign containing this lead is only workable by its single assignee.
  const alsoInOtherCampaigns: Array<{ lead_id: string; campaign_id: string; campaign_name: string }> = [];
  if (added.length > 0) {
    const { data: otherCls } = await db
      .from("campaign_leads")
      .select("lead_id, campaign_id, campaigns!inner(id, name, status, is_deleted)")
      .in("lead_id", added)
      .neq("campaign_id", id);
    for (const cl of otherCls ?? []) {
      const camp = (Array.isArray(cl.campaigns) ? cl.campaigns[0] : cl.campaigns) as { id: string; name: string; status: string; is_deleted: boolean } | null;
      if (!camp || camp.is_deleted || TERMINAL_STATUSES.has(camp.status)) continue;
      alsoInOtherCampaigns.push({ lead_id: cl.lead_id as string, campaign_id: camp.id, campaign_name: camp.name });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await db.from("campaign_leads").insert(toInsert);
    if (error) return fail(500, "INTERNAL", error.message);

    const { count } = await db
      .from("campaign_leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id);
    await db.from("campaigns").update({ total_leads: count ?? 0 }).eq("id", id);

    // Clean per-lead activity line.
    const { logLeadEvents } = await import("@/lib/services/lead-events");
    const campName = (await db.from("campaigns").select("name").eq("id", id).maybeSingle()).data?.name ?? "a campaign";
    await logLeadEvents(db, added.map((leadId) => ({
      leadId, event: "added_to_campaign" as const, detail: `Added to campaign "${campName}"`,
      actorId: user.id, metadata: { campaign_id: id },
    })));
  }

  return ok({
    added,
    not_found: notFound,
    blocked_unsubscribed: blockedUnsubscribed,
    blocked_not_enriched: blockedNotEnriched,
    skipped_existing: skippedExisting,
    also_in_other_campaigns: alsoInOtherCampaigns,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchCampaignLeadSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: campaign } = await db.from("campaigns").select("id, name").eq("id", id).maybeSingle();
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  const { data: row } = await db
    .from("campaign_leads")
    .select("id, lead_id, crm_status")
    .eq("id", parsed.data.campaign_lead_id)
    .eq("campaign_id", id)
    .maybeSingle();

  if (!row) return fail(404, "NOT_FOUND", "Campaign lead not found");

  const now = new Date().toISOString();
  const { error } = await db
    .from("campaign_leads")
    .update({ crm_status: parsed.data.crm_status, updated_at: now })
    .eq("id", parsed.data.campaign_lead_id);

  if (error) return fail(500, "INTERNAL", error.message);

  // Moving a card on the kanban is a real pipeline event — log it, but only on
  // an actual transition (a drag that lands back in the same column is a no-op).
  if (row.crm_status !== parsed.data.crm_status) {
    const pretty = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const { logLeadEvent } = await import("@/lib/services/lead-events");
    await logLeadEvent(
      db, row.lead_id as string, "status_changed",
      `Moved from ${pretty(row.crm_status as string)} to ${pretty(parsed.data.crm_status)} in "${campaign.name}"`,
      { actorId: user.id, metadata: { campaign_id: id, from: row.crm_status, to: parsed.data.crm_status } },
    );
  }

  return ok({ id: parsed.data.campaign_lead_id, crm_status: parsed.data.crm_status });
}
