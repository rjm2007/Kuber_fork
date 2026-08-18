import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api-response";
import type { AuthedUser } from "@/lib/auth/api-auth";

type Db = ReturnType<typeof createAdminClient>;

// Access model (spec §5 / §7 — the multi-employee campaign container):
//   • Managers / super-admins see everything.
//   • A campaign is a CONTAINER that may hold leads owned by several
//     employees. For an EMPLOYEE, access is uniformly LEAD-ASSIGNMENT based:
//       - a lead: they see/work it only if it is assigned to them;
//       - a campaign: they can open it if it contains ≥1 lead assigned to them
//         (or, for back-compat, it was assigned to / created by them), but the
//         detail view still shows only THEIR leads within it;
//       - a thread / draft / reply-draft: only if the underlying lead is
//         assigned to them — never merely because they can see the campaign.
//   This keeps one consistent rule across Leads, Campaigns and Unibox, and
//   prevents an employee from seeing a co-worker's leads inside a shared
//   campaign.

/**
 * The single source of truth for "which live campaigns can this employee see":
 * any campaign they created, OR that's assigned to them, OR that contains at
 * least one lead currently assigned to them (spec §5/§7). Every employee-facing
 * campaign surface (list page, dashboard, detail page, API) must go through
 * this — previously the server list/detail pages used narrower ad-hoc rules
 * (created_by only), so an employee with a lead inside a manager-created
 * campaign never saw that campaign even though the detail/API allowed it.
 */
export async function employeeCampaignIds(db: Db, userId: string): Promise<string[]> {
  const [{ data: owned }, { data: viaLeads }] = await Promise.all([
    db.from("campaigns").select("id").eq("is_deleted", false).or(`created_by.eq.${userId},assigned_to.eq.${userId}`),
    db.from("campaign_leads").select("campaign_id, leads!lead_id!inner(assigned_to, is_deleted)")
      .eq("leads.assigned_to", userId).eq("leads.is_deleted", false),
  ]);

  const ids = new Set<string>();
  for (const c of owned ?? []) ids.add(c.id as string);
  for (const cl of viaLeads ?? []) if (cl.campaign_id) ids.add(cl.campaign_id as string);
  return [...ids];
}

/** Campaign ids an employee may access: contains a lead assigned to them, OR (back-compat) created by / assigned to them. */
export async function getAccessibleCampaignIds(db: Db, user: AuthedUser): Promise<string[]> {
  if (user.role !== "employee") {
    const { data } = await db.from("campaigns").select("id").eq("is_deleted", false);
    return (data ?? []).map((c) => c.id as string);
  }
  return employeeCampaignIds(db, user.id);
}

/** Throws a 404 unless the campaign exists and (for employees) is accessible per the model above. */
export async function assertCampaignAccess(db: Db, user: AuthedUser, campaignId: string): Promise<void> {
  const { data } = await db
    .from("campaigns")
    .select("created_by, assigned_to")
    .eq("id", campaignId)
    .maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Campaign not found");
  if (user.role !== "employee") return;
  if (data.created_by === user.id || data.assigned_to === user.id) return;

  // Otherwise: accessible only if it holds at least one lead assigned to them.
  const { data: cl } = await db
    .from("campaign_leads")
    .select("id, leads!lead_id!inner(assigned_to, is_deleted)")
    .eq("campaign_id", campaignId)
    .eq("leads.assigned_to", user.id)
    .eq("leads.is_deleted", false)
    .limit(1)
    .maybeSingle();
  if (cl) return;

  throw fail(404, "NOT_FOUND", "Campaign not found");
}

/**
 * The employees a campaign belongs to: every employee who owns a lead in it,
 * plus its creator and its assignee when those are employees — a campaign
 * someone built but has not put leads in yet is still theirs.
 *
 * Managers are deliberately NOT counted. They administer every campaign, so
 * counting them would make every manager-created container permanently
 * "multi-employee" and lock out the one employee actually working it.
 *
 * Batched (a map per campaign id) because the campaigns list needs this for
 * every row it renders, not one campaign at a time.
 */
export async function campaignEmployeeOwners(
  db: Db,
  campaignIds: string[],
): Promise<Map<string, Set<string>>> {
  const owners = new Map<string, Set<string>>(campaignIds.map((id) => [id, new Set<string>()]));
  if (campaignIds.length === 0) return owners;

  const [{ data: camps }, { data: cls }] = await Promise.all([
    db.from("campaigns").select("id, created_by, assigned_to").in("id", campaignIds),
    db.from("campaign_leads")
      .select("campaign_id, leads!lead_id!inner(assigned_to, is_deleted)")
      .in("campaign_id", campaignIds)
      .eq("leads.is_deleted", false),
  ]);

  const add = (campaignId: string | null, userId: string | null) => {
    if (!campaignId || !userId) return;
    owners.get(campaignId)?.add(userId);
  };

  for (const c of camps ?? []) {
    add(c.id as string, c.created_by as string | null);
    add(c.id as string, (c as { assigned_to?: string | null }).assigned_to ?? null);
  }
  type OwnerRow = { campaign_id: string | null; leads: { assigned_to: string | null } | null };
  for (const cl of (cls ?? []) as unknown as OwnerRow[]) {
    add(cl.campaign_id, cl.leads?.assigned_to ?? null);
  }

  // Keep only the employees among the ids gathered above.
  const everyone = [...new Set([...owners.values()].flatMap((s) => [...s]))];
  if (everyone.length === 0) return owners;
  const { data: employees } = await db
    .from("profiles").select("id").eq("role", "employee").in("id", everyone);
  const isEmployee = new Set((employees ?? []).map((p) => p.id as string));

  for (const set of owners.values()) {
    for (const id of set) if (!isEmployee.has(id)) set.delete(id);
  }
  return owners;
}

/**
 * Of the given campaigns, the ones whose shared Options/Sequences this employee
 * may edit: those no OTHER employee is part of (spec §5 — a campaign is a
 * container). Alone in a campaign, editing only ever changes their own leads'
 * sending, so there is nobody to surprise. Share it with a teammate and it goes
 * back to manager-only.
 */
export async function campaignsEditableByEmployee(
  db: Db,
  userId: string,
  campaignIds: string[],
): Promise<Set<string>> {
  const owners = await campaignEmployeeOwners(db, campaignIds);
  const editable = new Set<string>();
  for (const [campaignId, involved] of owners) {
    if ([...involved].every((id) => id === userId)) editable.add(campaignId);
  }
  return editable;
}

/**
 * Throws unless the caller may edit campaign-wide settings — Options (sender
 * identity, daily limit, sending window, send days) and Sequences (step
 * subject/body). Both propagate live to every Instantly sub-campaign, i.e. to
 * every lead in the container.
 *
 * Managers always may. An employee may only when they are the sole employee in
 * the campaign — otherwise they'd silently change what a teammate's leads send
 * under. See EDGE_CASES.md §2.10.
 */
export async function assertCampaignSettingsAccess(
  db: Db,
  user: AuthedUser,
  campaignId: string,
): Promise<void> {
  await assertCampaignAccess(db, user, campaignId);
  if (user.role !== "employee") return;

  const editable = await campaignsEditableByEmployee(db, user.id, [campaignId]);
  if (editable.has(campaignId)) return;
  throw fail(
    403,
    "FORBIDDEN",
    "This campaign holds another teammate's leads, so only a manager can change its settings.",
  );
}

/** True when the underlying lead of a campaign_lead is assigned to this employee. */
async function ownsCampaignLead(db: Db, userId: string, campaignLeadId: string): Promise<boolean> {
  const { data } = await db
    .from("campaign_leads")
    .select("id, leads!lead_id!inner(assigned_to)")
    .eq("id", campaignLeadId)
    .eq("leads.assigned_to", userId)
    .maybeSingle();
  return !!data;
}

/**
 * Unibox visibility boundary for an employee: threads whose campaign_lead's lead
 * is assigned to them (spec §7). Null for managers (see everything).
 *
 * Returns the employee's id and lets the Unibox queries join through to it.
 * This used to materialise every campaign_lead id they own and hand that list
 * over to be expanded into a URL filter — which broke outright once someone was
 * assigned enough leads (see UniboxScope in lib/services/unibox.ts).
 */
export function getUniboxScope(user: AuthedUser): { assigned_to: string } | null {
  return user.role === "employee" ? { assigned_to: user.id } : null;
}

/**
 * Throws a 404 unless the caller may see a thread. Employees: only when the
 * thread's campaign_lead resolves to a lead assigned to them (spec §7) — campaign
 * access alone is NOT enough, so co-workers' threads in a shared campaign stay hidden.
 */
export async function assertThreadAccess(
  db: Db,
  user: AuthedUser,
  thread: { campaignId?: string | null; campaignLeadId?: string | null },
): Promise<void> {
  if (user.role !== "employee") return;
  if (thread.campaignLeadId && await ownsCampaignLead(db, user.id, thread.campaignLeadId)) return;
  throw fail(404, "NOT_FOUND", "Thread not found");
}

/** assertThreadAccess, resolving the campaign_lead(s) from a unibox thread id. */
export async function assertThreadAccessById(db: Db, user: AuthedUser, threadId: string): Promise<void> {
  if (user.role !== "employee") return;
  const { data: rows } = await db
    .from("unibox_emails")
    .select("campaign_lead_id")
    .eq("thread_id", threadId)
    .not("campaign_lead_id", "is", null)
    .limit(20);
  if (!rows || rows.length === 0) throw fail(404, "NOT_FOUND", "Thread not found");

  for (const row of rows) {
    if (row.campaign_lead_id && await ownsCampaignLead(db, user.id, row.campaign_lead_id as string)) return;
  }
  throw fail(404, "NOT_FOUND", "Thread not found");
}

/** Throws a 404 unless the lead exists and (for employees) is assigned to them (spec §5: own assigned leads only). */
export async function assertLeadAccess(db: Db, user: AuthedUser, leadId: string): Promise<void> {
  const { data } = await db.from("leads").select("assigned_to").eq("id", leadId).maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Lead not found");
  if (user.role !== "employee") return;
  if (data.assigned_to === user.id) return;
  throw fail(404, "NOT_FOUND", "Lead not found");
}

/** Throws a 404 unless the email_drafts row exists and (for employees) its lead is assigned to them (spec §2.8 consistency). */
export async function assertDraftAccess(db: Db, user: AuthedUser, draftId: string): Promise<void> {
  const { data } = await db.from("email_drafts").select("campaign_id, lead_id").eq("id", draftId).maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Draft not found");
  if (user.role !== "employee") return;
  const { data: lead } = await db.from("leads").select("assigned_to").eq("id", data.lead_id).maybeSingle();
  if (lead?.assigned_to === user.id) return;
  throw fail(404, "NOT_FOUND", "Draft not found");
}

/** Throws a 404 unless the reply_drafts row exists and (for employees) its lead is assigned to them (spec §2.9 consistency). */
export async function assertReplyDraftAccess(db: Db, user: AuthedUser, replyDraftId: string): Promise<void> {
  const { data } = await db
    .from("reply_drafts")
    .select("campaign_id, campaign_lead_id")
    .eq("id", replyDraftId)
    .maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Reply draft not found");
  if (user.role !== "employee") return;
  if (data.campaign_lead_id && await ownsCampaignLead(db, user.id, data.campaign_lead_id)) return;
  throw fail(404, "NOT_FOUND", "Reply draft not found");
}
