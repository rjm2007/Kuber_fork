import { NextRequest, after } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { ReplaceBouncedLeadSchema } from "@/lib/validators/campaigns";
import { buildReplacementLead } from "@/lib/services/replace-lead";
import { logLeadEvent } from "@/lib/services/lead-events";
import { internalAppBaseUrl } from "@/lib/internal-url";

/**
 * Replace a bounced contact with another address at the SAME company.
 *
 * A bounce means the address was wrong, not that the company is unreachable —
 * and the company is already enriched, so nothing about it needs redoing. This
 * route is the whole recovery path: create (or reuse) a lead under that org,
 * drop it into this campaign, and kick draft generation. From there it rejoins
 * the normal flow — Draft Ready → employee certifies → Send.
 *
 * Deliberately NOT reusing POST /api/v1/leads: that path is manager-only, mints
 * an import batch, and fires an org scrape this org concluded long ago. Here the
 * employee working the bounce must be able to act, and the org is already done.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = ReplaceBouncedLeadSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  const { data: cl } = await db
    .from("campaign_leads")
    .select(`
      id, campaign_id, crm_status, first_sent_at, lead_id,
      leads!inner ( email, assigned_to, country, organization_id, organizations ( name, unsubscribed ) )
    `)
    .eq("id", id)
    .maybeSingle();
  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");

  try { await assertCampaignAccess(db, user, cl.campaign_id as string); } catch (r) { return r as Response; }

  const bounced = (Array.isArray(cl.leads) ? cl.leads[0] : cl.leads) as {
    email: string | null;
    assigned_to: string | null;
    country: string | null;
    organization_id: string | null;
    organizations: { name: string | null; unsubscribed: boolean } | { name: string | null; unsubscribed: boolean }[] | null;
  };
  const org = Array.isArray(bounced.organizations) ? bounced.organizations[0] : bounced.organizations;

  // A campaign is a shared container; an employee may only work their own leads
  // inside it (spec §5). Same rule the campaign lead list already applies.
  if (user.role === "employee" && bounced.assigned_to !== user.id) {
    return fail(403, "FORBIDDEN", "This lead is assigned to another employee");
  }

  // Only a genuine bounce. crm_status='failed' is overloaded — first_sent_at is
  // what separates "we mailed them and the mailbox rejected it" from "Instantly
  // refused the lead at add-time" (see deliveryBucket). Replacing the address is
  // only the right fix for the former; the latter needs a re-send, not a person.
  if (!(cl.crm_status === "failed" && cl.first_sent_at)) {
    return fail(409, "NOT_BOUNCED", "Only a bounced lead can be replaced");
  }

  if (!bounced.organization_id) {
    return fail(409, "NO_ORGANIZATION", "This lead has no company to attach a replacement to");
  }
  if (org?.unsubscribed) {
    return fail(409, "UNSUBSCRIBED", `${org.name ?? "This company"} has unsubscribed — no one there can be contacted`);
  }

  const email = parsed.data.email.trim().toLowerCase();
  if (email === (bounced.email ?? "").toLowerCase()) {
    return fail(400, "SAME_EMAIL", "That is the address that bounced — enter a different one");
  }

  // Reuse before insert: this address may already be a lead (a colleague's
  // import, another campaign). Inserting a second row would split one person's
  // history in two and hand Instantly a duplicate.
  const { data: existing } = await db
    .from("leads")
    .select("id, assigned_to, first_name, last_name")
    .eq("email", email)
    .eq("is_deleted", false)
    .maybeSingle();

  let leadId: string;
  let reused = false;

  if (existing) {
    // An unowned lead is free to take. One already held by a colleague is not:
    // silently moving it would pull it out of their queue, and leaving it put
    // would send this campaign's mail from THEIR mailbox (sendCampaign buckets
    // by the owner's sending address).
    if (existing.assigned_to && existing.assigned_to !== bounced.assigned_to) {
      return fail(409, "LEAD_HELD_BY_OTHER", "That address already exists as a lead assigned to another employee", { lead_id: existing.id });
    }
    leadId = existing.id as string;
    reused = true;
    if (!existing.assigned_to && bounced.assigned_to) {
      await db.from("leads").update({
        assigned_to: bounced.assigned_to,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", leadId);
    }
  } else {
    const { data: created, error: insErr } = await db
      .from("leads")
      .insert(buildReplacementLead(
        {
          organization_id: bounced.organization_id,
          assigned_to: bounced.assigned_to,
          country: bounced.country,
        },
        parsed.data,
        user.id,
      ))
      .select("id")
      .single();
    if (insErr) return fail(500, "INTERNAL", insErr.message);
    leadId = created.id as string;
    await logLeadEvent(db, leadId, "created", `Added to replace a bounced contact at ${org?.name ?? "this company"}`, {
      actorId: user.id,
      metadata: { replaces_lead_id: cl.lead_id, campaign_id: cl.campaign_id },
    });
  }

  const { data: alreadyIn } = await db
    .from("campaign_leads")
    .select("id")
    .eq("campaign_id", cl.campaign_id)
    .eq("lead_id", leadId)
    .maybeSingle();
  if (alreadyIn) {
    return fail(409, "ALREADY_IN_CAMPAIGN", "That contact is already in this campaign", { campaign_lead_id: alreadyIn.id });
  }

  const now = new Date().toISOString();
  const { data: inserted, error: clErr } = await db
    .from("campaign_leads")
    .insert({
      campaign_id: cl.campaign_id,
      lead_id: leadId,
      // Campaign-ready immediately: the org is enriched, so the lead is too
      // (compute_lead_status derives it), and this is the status fetchDraftTargets
      // picks up. No enrichment queue, nothing to wait for.
      crm_status: "enriched",
      created_by: user.id,
      created_at: now,
    })
    .select("id")
    .single();
  if (clErr) return fail(500, "INTERNAL", clErr.message);

  // Mark the bounce handled. Its crm_status stays 'failed' and it stays in
  // bounced_count — the bounce really did happen and the numbers must keep
  // saying so. This only tells a human "someone already dealt with this one",
  // which is otherwise indistinguishable from an untouched bounce.
  await db.from("campaign_leads").update({
    replaced_by_lead_id: leadId,
    updated_at: now,
  }).eq("id", cl.id);

  const { count } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", cl.campaign_id);
  await db.from("campaigns").update({ total_leads: count ?? 0, updated_at: now }).eq("id", cl.campaign_id);

  const { data: campaign } = await db.from("campaigns").select("name").eq("id", cl.campaign_id).maybeSingle();
  const campaignName = campaign?.name ?? "this campaign";

  await logLeadEvent(db, leadId, "added_to_campaign", `Added to campaign "${campaignName}" as a replacement`, {
    actorId: user.id,
    metadata: { campaign_id: cl.campaign_id, replaces_lead_id: cl.lead_id, reused_existing_lead: reused },
  });
  // The bounced lead stays exactly where it is — still bounced, still counted in
  // bounced_count. This line is only so its timeline says where the outreach went.
  await logLeadEvent(db, cl.lead_id as string, "status_changed", `Bounced — replaced by ${email} in "${campaignName}"`, {
    actorId: user.id,
    metadata: { campaign_id: cl.campaign_id, replacement_lead_id: leadId },
  });

  // Draft the new lead. fetchDraftTargets only picks campaign_leads with
  // draft_id IS NULL, so firing the campaign-wide generator writes exactly one
  // draft — everyone else's is untouched.
  if (process.env.INTERNAL_SECRET) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET;
    after(() =>
      fetch(`${baseUrl}/api/enrich/generate-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ campaign_id: cl.campaign_id }),
      }).catch(() => {}),
    );
  }

  return ok({ lead_id: leadId, campaign_lead_id: inserted.id, reused });
}
