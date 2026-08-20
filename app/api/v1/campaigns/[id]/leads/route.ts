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
       replaced_by_user:profiles!replaced_by_user_id(id, full_name),
       email_drafts(id, subject, body, status, created_at, step_number),
       leads!lead_id!inner(first_name, last_name, email, title, country, assigned_to, organization_id, replaces_lead_id, organizations(id, name, domain, country, city, website))`,
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
  ): {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    title: string | null;
    country: string | null;
    company_name: string | null;
    org_id: string | null;
    company_domain: string | null;
    company_country: string | null;
    company_city: string | null;
    company_website: string | null;
  } | null {
    if (!raw) return null;
    const org = raw.organizations as
      | { id?: string | null; name?: string | null; domain?: string | null; country?: string | null; city?: string | null; website?: string | null }
      | { id?: string | null; name?: string | null; domain?: string | null; country?: string | null; city?: string | null; website?: string | null }[]
      | null
      | undefined;
    const orgRow = Array.isArray(org) ? org[0] : org;
    const { organizations: _org, organization_id: _organizationId, ...lead } = raw;
    return {
      ...lead,
      company_name: orgRow?.name ?? null,
      org_id: orgRow?.id ?? (typeof raw.organization_id === "string" ? raw.organization_id : null),
      company_domain: orgRow?.domain ?? null,
      company_country: orgRow?.country ?? null,
      company_city: orgRow?.city ?? null,
      company_website: orgRow?.website ?? null,
    } as ReturnType<typeof mapLeadRow>;
  }

  // How far into the sequence each lead actually got. campaign_leads only
  // records first_sent_at — written once, on the opening email — so nothing on
  // the row itself changes when follow-up 1, 2 or 3 lands, and every contacted
  // lead reads the same forever. The step number is on the email_sent webhooks,
  // so take the highest one per lead. Only steps past 1 are worth fetching:
  // step 1 is what first_sent_at already covers.
  // The bounce timestamp rides along in the same query: it lives only on the
  // email_bounced webhook (campaign_leads records no bounce time of its own),
  // and the Outbox handoff panel states when the address rejected us. Fetching
  // both event types together keeps this to one round-trip; the step filter
  // that used to run in SQL now runs on the rows, since it only applies to
  // email_sent.
  const pageLeadIds = (data ?? []).map((cl) => cl.id as string);
  const stepByLead = new Map<string, number>();
  const bouncedAtByLead = new Map<string, string>();
  // Which mail the address rejected. A lead can bounce on the OPENING email (we
  // never chase them again) or on a follow-up, meaning the mailbox died between
  // the two sends — the same red badge for two different stories.
  const bouncedStepByLead = new Map<string, number>();
  // Timestamp of the most recently confirmed email_sent, ANY step including 1
  // (unlike stepByLead above, which skips step 1 since first_sent_at already
  // covers whether it sent — this tracks WHEN, which first_sent_at also has,
  // but keeping one map that's always populated once anything has sent is what
  // the due-date estimate below needs). Real data, not a guess: the
  // email_sent webhook is Instantly confirming delivery, not us inferring it.
  const lastStepAtByLead = new Map<string, { step: number; at: string }>();
  if (pageLeadIds.length > 0) {
    const { data: events } = await db
      .from("reply_events")
      .select("campaign_lead_id, step, event_type, received_at")
      .eq("campaign_id", id)
      .in("event_type", ["email_sent", "email_bounced"])
      .in("campaign_lead_id", pageLeadIds)
      .limit(5000); // one page of leads × every step; well clear of PostgREST's default 1000
    for (const ev of events ?? []) {
      const clId = ev.campaign_lead_id as string | null;
      if (!clId) continue;
      if (ev.event_type === "email_bounced") {
        // Earliest bounce is the one that ended this address.
        const at = ev.received_at as string | null;
        const seen = bouncedAtByLead.get(clId);
        if (at && (!seen || at < seen)) {
          bouncedAtByLead.set(clId, at);
          const bStep = ev.step as number | null;
          if (bStep) bouncedStepByLead.set(clId, bStep);
        }
        continue;
      }
      const step = ev.step as number | null;
      const at = ev.received_at as string | null;
      if (step && at) {
        const current = lastStepAtByLead.get(clId);
        if (!current || step > current.step) lastStepAtByLead.set(clId, { step, at });
      }
      if (!step || step <= 1) continue; // step 1 is what first_sent_at already covers
      if (step > (stepByLead.get(clId) ?? 0)) stepByLead.set(clId, step);
    }
  }

  // Our own sequence sends, mirrored back by Instantly. The Outbox thread used
  // to be reconstructed from the step-1 draft alone, so a lead reading
  // "Follow-up 1 sent" in the list still showed a single email in their thread.
  // The follow-ups were never missing — unibox_emails has held them all along
  // (direction 'sent_campaign'), they were simply not on any read path.
  //
  // Fetched here rather than through getCampaignReplyThreads because that walks
  // one thread at a time at roughly five queries each, and it only covers leads
  // who REPLIED — which is precisely the wrong set: a lead who never answered is
  // the one whose follow-ups you most need to see. One query for the page.
  const sequenceByLead = new Map<string, Array<Record<string, unknown>>>();
  if (pageLeadIds.length > 0) {
    const { data: sends } = await db
      .from("unibox_emails")
      .select("id, campaign_lead_id, step, subject, body_html, body_text, timestamp_email, to_emails, cc_emails")
      .eq("campaign_id", id)
      .eq("direction", "sent_campaign")
      .in("campaign_lead_id", pageLeadIds)
      .order("timestamp_email", { ascending: true })
      .limit(5000);
    for (const m of sends ?? []) {
      const clId = m.campaign_lead_id as string | null;
      if (!clId) continue;
      if (!sequenceByLead.has(clId)) sequenceByLead.set(clId, []);
      sequenceByLead.get(clId)!.push(m);
    }
  }

  // Compute resolved attachment per lead
  const items = (data ?? []).map((cl: Record<string, unknown>) => ({
    ...cl,
    leads: mapLeadRow(cl.leads as Record<string, unknown> | null),
    draft_activity: activityByLead.get(cl.lead_id as string) ?? null,
    last_step_sent: stepByLead.get(cl.id as string) ?? null,
    // When the highest confirmed step (any step, including 1) actually went
    // out — real webhook timestamp, used to estimate the next step's due date
    // from the campaign's own configured day gaps (see effectiveLastStep /
    // estimateNextDue in campaign-drawer.tsx). Falls back to first_sent_at:
    // reply_events can lag or miss a step-1 row for older leads, but
    // first_sent_at is written unconditionally on the opening send.
    last_step_sent_at: lastStepAtByLead.get(cl.id as string)?.at ?? (cl.first_sent_at as string | null) ?? null,
    sequence_messages: sequenceByLead.get(cl.id as string) ?? [],
    bounced_at: bouncedAtByLead.get(cl.id as string) ?? null,
    bounced_step: bouncedStepByLead.get(cl.id as string) ?? null,
    // PostgREST hands a to-one embed back as an object, but types it loosely —
    // flatten to the one field the UI needs so the client isn't unwrapping.
    replaced_by_user_name: (() => {
      const u = cl.replaced_by_user as { full_name?: string | null } | { full_name?: string | null }[] | null;
      const row = Array.isArray(u) ? u[0] : u;
      return row?.full_name ?? null;
    })(),
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
  // is_deleted is not just list cosmetics here: a deleted lead is either one a
  // manager retired or a bounced address a replacement already stood in for.
  // Neither may be campaigned again, and the ids arrive from the client — so the
  // filter has to live on the fetch, not only on the pickers that feed it. A
  // filtered-out id falls through to `not_found` below, which the UI reports.
  let leadsQuery = db
    .from("leads")
    .select("id, email, status, organization_id, assigned_to, organizations(domain, enrichment_stage, unsubscribed)")
    .eq("is_deleted", false)
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
