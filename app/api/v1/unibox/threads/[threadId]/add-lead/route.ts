import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getThreadMessages } from "@/lib/services/unibox";
import { assertThreadAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { ourAddresses, threadParticipants } from "@/lib/thread-participants";
import { logLeadEvent } from "@/lib/services/lead-events";

/**
 * Promote a third participant on a thread into a real lead.
 *
 * When a prospect CCs their manager and the manager writes back, that person
 * exists nowhere except inside one conversation — no campaign, no status, no
 * report. Sales calls engaging several stakeholders "multi-threading" and it is
 * the single strongest signal a cold sequence produces, so it should not stay
 * trapped in an inbox.
 *
 * Deliberately NOT automatic. Auto-creating a lead for every CC'd assistant,
 * alias and colleague would pollute the database, inflate campaign counts, and
 * risk enrolling someone in cold outreach who never asked to hear from us. A
 * human presses the button.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  // Creating leads is a manager action everywhere else in the app; this is not
  // the place to invent a second rule for it.
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const { threadId } = await params;
  const body = await req.json().catch(() => null) as {
    email?: unknown; first_name?: unknown; last_name?: unknown;
  } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return fail(400, "VALIDATION_ERROR", "email is required");

  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
  const firstName = str(body?.first_name);
  const lastName = str(body?.last_name);
  // Required, and not for tidiness: campaign templates render {{firstName}}, so
  // a nameless lead quietly addresses its next email to "there".
  if (!firstName) return fail(400, "VALIDATION_ERROR", "First name is required");

  const db = dbForUser(user);
  const thread = await getThreadMessages(db, threadId);
  try {
    await assertThreadAccess(db, user, {
      campaignId: (thread.campaign as { id?: string } | null)?.id ?? null,
      campaignLeadId: thread.campaign_lead_id,
    });
  } catch (r) {
    return r as Response;
  }

  // Trust boundary. Without this check the endpoint is "create a lead with any
  // address at all", bypassing the validation and manager rules that guard
  // POST /api/v1/leads. The address must genuinely be on this conversation.
  const ourEmails = ourAddresses(thread.messages, [thread.eaccount]);
  const participants = threadParticipants(thread.messages, {
    ourEmails,
    leadEmail: (thread.lead as { email?: string } | null)?.email ?? null,
  });
  const participant = participants.find((p) => p.email === email);
  if (!participant) {
    return fail(400, "NOT_A_PARTICIPANT", "That address is not part of this conversation");
  }
  if (ourEmails.has(email)) {
    return fail(400, "OWN_MAILBOX", "That is one of your own sending accounts");
  }
  if (participant.isLead) {
    return fail(409, "ALREADY_LEAD", "That address is already the lead on this thread");
  }

  // Existing live lead wins — re-adding would create a duplicate the reply
  // attribution then has to choose between. Soft-deleted ones do not block.
  const { data: existing } = await db
    .from("leads")
    .select("id, first_name, last_name")
    .ilike("email", email)
    .eq("is_deleted", false)
    .maybeSingle();
  if (existing) {
    return fail(409, "DUPLICATE", "This person is already a lead", { id: existing.id });
  }

  // Inherit the organisation from the lead whose thread this is — that is the
  // whole point: a colleague CC'd from the same company belongs to that account.
  const lead = thread.lead as { organization_id?: string | null; assigned_to?: string | null } | null;
  if (!lead?.organization_id) {
    return fail(
      400,
      "NO_ORGANIZATION",
      "This thread's lead has no organization, so there is nothing to add them to",
    );
  }

  const { data: created, error } = await db
    .from("leads")
    .insert({
      email,
      first_name: firstName,
      last_name: lastName || null,
      organization_id: lead.organization_id,
      // Same shape the manual-create route uses; keeps this lead out of Apollo's
      // dedupe space while satisfying the NOT NULL.
      apollo_id: `manual_${crypto.randomUUID()}`,
      lead_source: "manual",
      created_by: user.id,
      // Whoever owns the original lead keeps the account, so the thread and the
      // new contact do not end up split across two reps.
      assigned_to: lead.assigned_to ?? null,
    })
    .select("id, email, first_name, last_name, organization_id, assigned_to")
    .single();

  if (error) return fail(500, "INTERNAL", error.message);

  await logLeadEvent(
    db,
    created.id,
    "created",
    `Added from an email thread — replied from ${email} on a conversation with the original lead`,
    { actorId: user.id, metadata: { thread_id: threadId, source: "thread_participant" } },
  );

  return ok({ lead: created });
}
