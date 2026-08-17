import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchCampaignSchema } from "@/lib/validators/campaigns";
import { assertCampaignAccess, campaignsEditableByEmployee } from "@/lib/auth/scope";
import { deleteCampaignInstantly } from "@/lib/services/campaign-lifecycle";
import { computeCampaignStats } from "@/lib/campaign-status";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const EDITABLE_STATUSES = new Set(["draft", "processing"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: campaign, error } = await db
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  if (!campaign) return fail(404, "NOT_FOUND", "Campaign not found");

  // A campaign is a container that may hold leads from several employees
  // (spec §5) — an employee sees only their own leads' memberships, and the
  // card/analytics totals below must reflect only those, not the whole
  // campaign (confirmed live: an employee with 2 of 7 leads was seeing the
  // full campaign-wide 7/7/2/29% stats).
  let membershipsQuery = db
    .from("campaign_leads")
    .select("id, crm_status, first_sent_at, lead_id, draft_id, interest_status, lead_temperature, email_drafts(status), leads!lead_id!inner(assigned_to)")
    .eq("campaign_id", id);
  if (user.role === "employee") membershipsQuery = membershipsQuery.eq("leads.assigned_to", user.id);
  const { data: memberships } = await membershipsQuery;

  const scopedCampaign = user.role === "employee"
    ? { ...campaign, ...computeCampaignStats(memberships ?? []) }
    : campaign;

  // Whether the caller may edit the shared Options/Sequences (EDGE_CASES.md
  // §2.10). Always true for a manager; for an employee, only when no other
  // employee has leads in this container.
  const can_edit_settings = user.role !== "employee"
    || (await campaignsEditableByEmployee(db, user.id, [id])).has(id);

  return ok({ ...scopedCampaign, can_edit_settings, memberships: memberships ?? [] });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(_req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  // "Delete" means delete: remove the campaign from Instantly (stops all sending AND
  // takes it out of Instantly's dashboard) before soft-deleting it here. Best-effort:
  // if Instantly is unreachable we still soft-delete, but log so it can be retried.
  try {
    await deleteCampaignInstantly(db, id);
  } catch (e) {
    console.error(`Failed to delete from Instantly on delete for campaign ${id}:`, (e as Error).message);
  }

  const { error } = await db.from("campaigns").update({ is_deleted: true }).eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ deleted: id });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchCampaignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: existing } = await db.from("campaigns").select("status").eq("id", id).maybeSingle();
  if (!existing) return fail(404, "NOT_FOUND", "Campaign not found");
  if (!EDITABLE_STATUSES.has(existing.status)) {
    return fail(409, "CONFLICT", `Campaign in status '${existing.status}' cannot be edited`);
  }

  const { data, error } = await db
    .from("campaigns")
    .update({ ...parsed.data, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return fail(500, "INTERNAL", error.message);
  return ok(data);
}
