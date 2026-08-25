import { NextRequest, after } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { ReplaceBouncedLeadSchema } from "@/lib/validators/campaigns";
import { logLeadEvent } from "@/lib/services/lead-events";
import { internalAppBaseUrl } from "@/lib/internal-url";

/**
 * Correct a bounced contact's identity in place — same lead_id, updated
 * name/email/title only.
 *
 * A bounce means the address was wrong, not that the company is unreachable —
 * and the company is already enriched, so nothing about it needs redoing.
 * Earlier this route created a SEPARATE lead + campaign_leads row and
 * soft-deleted the bounced one, which split a person's identity across two
 * records and only fixed the one campaign it was run from. Updating the same
 * `leads` row instead means the correction is visible everywhere that lead_id
 * is already referenced — every campaign, every thread, every drawer — with
 * nothing else to keep in sync. The campaign_leads row is un-bounced in the
 * same update so the corrected contact rejoins the normal flow (Draft Ready →
 * certify → Send) without a fresh insert.
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
      leads!lead_id!inner ( first_name, last_name, email, title, assigned_to, organization_id, organizations ( name, unsubscribed ) )
    `)
    .eq("id", id)
    .maybeSingle();
  if (!cl) return fail(404, "NOT_FOUND", "Campaign lead not found");

  try { await assertCampaignAccess(db, user, cl.campaign_id as string); } catch (r) { return r as Response; }

  const bounced = (Array.isArray(cl.leads) ? cl.leads[0] : cl.leads) as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    title: string | null;
    assigned_to: string | null;
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
  // refused the lead at add-time" (see deliveryBucket). Correcting the address is
  // only the right fix for the former; the latter needs a re-send, not a correction.
  if (!(cl.crm_status === "failed" && cl.first_sent_at)) {
    return fail(409, "NOT_BOUNCED", "Only a bounced lead can be corrected");
  }

  if (org?.unsubscribed) {
    return fail(409, "UNSUBSCRIBED", `${org.name ?? "This company"} has unsubscribed — no one there can be contacted`);
  }

  const email = parsed.data.email.trim().toLowerCase();
  if (email === (bounced.email ?? "").toLowerCase()) {
    return fail(400, "SAME_EMAIL", "That is the address that bounced — enter a different one");
  }

  // The new address must not already belong to a DIFFERENT lead — this route
  // edits one identity in place, it does not merge two. A collision means the
  // right move is picking a still-different address, not silently combining
  // two people's history.
  const { data: collision } = await db
    .from("leads")
    .select("id")
    .eq("email", email)
    .eq("is_deleted", false)
    .neq("id", cl.lead_id)
    .maybeSingle();
  if (collision) {
    return fail(409, "EMAIL_TAKEN", "That address already belongs to another lead", { lead_id: collision.id });
  }

  const now = new Date().toISOString();
  const oldName = [bounced.first_name, bounced.last_name].filter(Boolean).join(" ") || "(no name)";
  const newFirstName = parsed.data.first_name.trim();
  const newLastName = parsed.data.last_name?.trim() || null;
  const newTitle = parsed.data.title?.trim() || null;
  const newName = [newFirstName, newLastName].filter(Boolean).join(" ");

  const { error: leadErr } = await db.from("leads").update({
    email,
    first_name: newFirstName,
    last_name: newLastName,
    title: newTitle,
    updated_by: user.id,
    updated_at: now,
  }).eq("id", cl.lead_id);
  if (leadErr) return fail(500, "INTERNAL", leadErr.message);

  const { data: campaign } = await db.from("campaigns").select("name").eq("id", cl.campaign_id).maybeSingle();
  const campaignName = campaign?.name ?? "this campaign";

  // Un-bounce and clear the stale draft so fetchDraftTargets writes a fresh one
  // for the corrected name/email — the old draft was written for the person who
  // bounced. first_sent_at resets too: nothing has actually been sent to this
  // corrected identity yet, so follow-up scheduling must not anchor on the old
  // (failed) send time.
  const { error: clErr } = await db.from("campaign_leads").update({
    crm_status: "enriched",
    draft_id: null,
    first_sent_at: null,
    replaced_at: now,
    replaced_by_user_id: user.id,
    updated_at: now,
  }).eq("id", cl.id);
  if (clErr) return fail(500, "INTERNAL", clErr.message);

  // Same reasoning as clearing draft_id above, applied to the FOLLOW-UPS: any
  // already-written follow-up greets the person who bounced, by name. Clearing
  // draft_id alone only replaces the opening email, because that column tracks
  // step 1 and nothing else.
  //
  // This bites only on a slow bounce. Bounces usually land within minutes, long
  // before a follow-up is written — but some mail servers retry for days, and
  // then the follow-up exists first. Without this, the corrected contact would
  // be greeted by the previous person's name, because findFollowupsToWrite
  // skips any lead that already has a draft for the step and has no way to know
  // that draft was written for someone else.
  //
  // Marked superseded rather than deleted, so the activity log's before/after
  // still has something to point at. The sweep ignores 'rejected', so a fresh
  // follow-up is written once the corrected opening email actually sends.
  const { error: fuErr } = await db
    .from("email_drafts")
    .update({ status: "rejected", updated_at: now })
    .eq("campaign_id", cl.campaign_id)
    .eq("lead_id", cl.lead_id)
    .gt("step_number", 1)
    .neq("status", "sent");
  if (fuErr) return fail(500, "INTERNAL", fuErr.message);

  await logLeadEvent(db, cl.lead_id as string, "contact_corrected",
    `Bounced contact corrected in "${campaignName}": ${oldName} <${bounced.email ?? "?"}> → ${newName} <${email}>`, {
      actorId: user.id,
      metadata: {
        campaign_id: cl.campaign_id,
        campaign_lead_id: cl.id,
        before: { first_name: bounced.first_name, last_name: bounced.last_name, email: bounced.email, title: bounced.title },
        after: { first_name: newFirstName, last_name: newLastName, email, title: newTitle },
      },
    });

  // Draft the corrected lead. fetchDraftTargets only picks campaign_leads with
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

  return ok({ lead_id: cl.lead_id, campaign_lead_id: cl.id });
}
