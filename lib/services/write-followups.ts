import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { findFollowupsToWrite, MAX_TOTAL_ATTEMPTS, type FollowupTarget } from "@/lib/services/followup-schedule";
import { generateOneDraft, logLlmRecovered } from "@/lib/services/generate-drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";
import { getFollowupFallbackTemplate, renderFollowupFallback } from "@/lib/services/settings";
import { classifyFallback } from "@/lib/services/fallback-reason";
import { resolveStandingFollowupInstruction } from "@/lib/services/followup-instruction";
import { hasUsableLlmKey } from "@/lib/services/provider-keys";
import { BatchBudget } from "@/lib/services/batch-budget";

/**
 * Writes the personalised follow-ups that are due, then pushes each one to
 * Instantly.
 *
 * Two halves, and the second is the one that is easy to forget: writing the
 * draft only updates OUR database. Instantly holds its own copy of the text in
 * that lead's `customBody2` custom variable, seeded at fan-out time with a
 * generic fallback. Without the push, the database would show a beautiful
 * personalised follow-up while Instantly happily sent the boilerplate.
 *
 * Runs on a time budget rather than a fixed count, for the same reason draft
 * generation does: a lambda killed mid-batch loses the work after it, and a
 * follow-up takes a few seconds. See app/api/enrich/generate-drafts/route.ts.
 */

const TIME_BUDGET_MS = 40_000;

/** Attempts before the template safety net goes in.
 *
 *  Two, not one. The most common failure by far is a momentary blip — the model
 *  busy for a second — and giving up on the first one would send a customer
 *  boilerplate over a hiccup that clears immediately. Two is enough to ride out
 *  every transient failure seen in production and still give up fast on a real
 *  one. */
const ATTEMPTS_BEFORE_TEMPLATE = 2;



export type WriteFollowupsResult = {
  found: number;
  written: number;
  pushed: number;
  failed: number;
  /** Leads that exhausted their retries and got the template safety net. Not a
   *  failure — a deliberate, recorded, upgradeable outcome. */
  templated: number;
  ranOutOfTime: boolean;
};

export async function writeDueFollowups(
  rootDb: SupabaseClient | undefined,
  opts: { limit?: number; now?: Date; companyId?: string } = {},
): Promise<WriteFollowupsResult> {
  const db = rootDb ?? createAdminClient();
  const startedAt = Date.now();

  const targets = await findFollowupsToWrite(db, {
    limit: opts.limit ?? 50,
    now: opts.now,
    companyId: opts.companyId,
  });
  const result: WriteFollowupsResult = {
    found: targets.length, written: 0, pushed: 0, failed: 0, templated: 0, ranOutOfTime: false,
  };
  if (targets.length === 0) return result;

  // Campaign metadata is read once per campaign, not once per lead: a sweep of
  // 50 follow-ups usually spans only a handful of campaigns.
  const campaignIds = [...new Set(targets.map((t) => t.campaignId))];
  const { data: campaigns } = await db
    .from("campaigns")
    .select("id, name, human_in_loop, ai_prompt_context, company_id, followup_instruction")
    .in("id", campaignIds);
  const campaignById = new Map((campaigns ?? []).map((c) => [c.id as string, c]));

  const budget = new BatchBudget();
  for (const target of targets) {
    // Same measured budget the draft generator uses: a flat 40s was tuned to
    // the average call and stranded the slow ones mid-flight.
    if (!budget.hasRoomForAnother()) { result.ranOutOfTime = true; break; }

    const campaign = campaignById.get(target.campaignId);
    if (!campaign) { result.failed++; continue; }

    // Scoped to the owning company so every row written here is stamped with it,
    // exactly like sendCampaign does. The sweep above is cross-company by
    // necessity; the writes must not be.
    const cdb = createScopedClient(campaign.company_id as string);

    try {
      const written = await budget.run(() => writeOne(cdb, target, campaign));
      if (!written) { result.failed++; continue; }
      if (written.templated) result.templated++; else result.written++;
      if (written.pushed) result.pushed++;
    } catch {
      result.failed++;
    }
  }

  // Drafting worked, so clear any stale "no LLM credits" banner. Without this a
  // topped-up key left the alarm on until the six-hour window aged out.
  if (result.written > 0) {
    const companyId = campaigns?.[0]?.company_id as string | undefined;
    await logLlmRecovered(db, companyId ?? null);
  }

  return result;
}

async function writeOne(
  db: SupabaseClient,
  target: FollowupTarget,
  campaign: {
    id: string; name: string; human_in_loop: boolean;
    ai_prompt_context: string | null; company_id: string;
    followup_instruction?: string | null;
  },
): Promise<{ pushed: boolean; templated: boolean } | null> {
  // The same shape fetchDraftTargets returns, so generateOneDraft needs no
  // special case for scheduled follow-ups versus the ones a user triggers.
  const { data: cl } = await db
    .from("campaign_leads")
    .select(`
      id, lead_id,
      attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
      leads!lead_id!inner(
        id, first_name, last_name, email, title, headline, seniority, city, country, assigned_to,
        organizations(name, domain, website, industry, employees, city, country, company_description, sells_to, keywords)
      )
    `)
    .eq("id", target.campaignLeadId)
    .maybeSingle();

  if (!cl) return null;

  // No key with credit anywhere: skip the model entirely and lay the safety net
  // now. Trying anyway would spend two rejected calls per lead to learn what the
  // key health already says — 800 of them across a backlog this size — and end
  // in the same place. attempts is left at 0 deliberately: nothing was actually
  // attempted, so the upgrade pass still owes this lead a real try once credits
  // return.
  if (!(await hasUsableLlmKey(db, campaign.company_id))) {
    const templated = await writeTemplateFallback(
      db, target, "Every configured LLM key is out of credits", 0,
    );
    return templated ? { pushed: templated.pushed, templated: true } : null;
  }

  // Already out of model attempts: go straight to the safety net rather than
  // spending another call that history says will fail. This is what makes a
  // credit outage cheap — the leads that already failed twice cost nothing
  // further, and still end up with a labelled, upgradeable draft.
  const priorAttempts = target.priorAttempts ?? 0;
  if (priorAttempts >= ATTEMPTS_BEFORE_TEMPLATE) {
    const templated = await writeTemplateFallback(db, target, undefined, priorAttempts);
    return templated ? { pushed: templated.pushed, templated: true } : null;
  }

  // Extra guidance the user typed, campaign-wide plus this step's own. Rides in
  // on customInstruction, which the prompt builder already appends AFTER the
  // length and tone contract — so an instruction can add a fact but cannot talk
  // the model out of writing a short, personalised email.
  const instruction = await resolveStandingFollowupInstruction(db, target.campaignId, target.stepOrder);

  const result = await generateOneDraft(
    db,
    cl as Parameters<typeof generateOneDraft>[1],
    target.campaignId,
    // human_in_loop is deliberately ignored for follow-ups: they are
    // auto-approved by design (agreed with the client 21 Aug 2026 — "no need to
    // certify the follow-ups"). Passing false makes generateOneDraft mark the
    // draft approved rather than leaving it waiting for a human who will never
    // come, which would mean Instantly sends the fallback instead.
    false,
    campaign.name,
    undefined,
    instruction,
    campaign.ai_prompt_context ?? undefined,
    undefined,
    target.stepOrder,
  );

  // How many times this (campaign, lead, step) has already been tried. Counted
  // from the failed rows the generator leaves behind rather than kept in a
  // separate tally, so a crash between attempts cannot lose the count.
  const attempts = priorAttempts + 1;

  if (!result.ok) {
    // Still have retries left — leave the failed row and let the next sweep
    // pick it up. Nothing is sent in the meantime because the due date is a day
    // out; that lead time exists precisely so a blip can be absorbed.
    if (attempts < ATTEMPTS_BEFORE_TEMPLATE) return null;

    // Out of retries. Put the safety net in place NOW rather than leaving the
    // lead empty: if the due date arrives first, Instantly renders whatever is
    // in customBodyN, and an empty variable is a blank email. A recorded,
    // labelled, upgradeable template beats both a blank and a silent one.
    const templated = await writeTemplateFallback(db, target, result.reason, attempts);
    return templated ? { pushed: templated.pushed, templated: true } : null;
  }

  // Push to Instantly. Only possible once the lead is actually in a campaign
  // there; before that the text is picked up by sendCampaign at fan-out, which
  // is why a missing instantly_lead_id is a skip and not a failure.
  //
  // syncApprovedDraftToInstantly rebuilds the WHOLE custom-variable set from
  // every approved/sent draft for this lead, so pushing after writing step 2
  // carries step 1 along unchanged rather than clobbering it.
  let pushed = false;
  if (target.instantlyLeadId) {
    const sync = await syncApprovedDraftToInstantly(db, target.leadId, target.campaignId);
    pushed = sync.synced;
  }

  return { pushed, templated: false };
}

/**
 * Write the editable fallback text as a real, labelled draft.
 *
 * Deliberately a DRAFT ROW rather than leaning on the generic string Instantly
 * was seeded with at fan-out. That seeding is invisible: nothing in our database
 * records that a customer got boilerplate, so nobody can answer "how many of my
 * leads actually got a personalised email?" — which is the whole point of the
 * product. A row with source='template' and a reason makes it countable, shows
 * it on the lead, and lets a later pass upgrade it.
 *
 * Uses the company's own fallback text (Settings > AI & Outreach), so the client
 * controls what their name goes out on.
 */
async function writeTemplateFallback(
  db: SupabaseClient,
  target: FollowupTarget,
  rawError: string | undefined,
  attempts: number,
): Promise<{ pushed: boolean } | null> {
  const reason = classifyFallback(rawError);

  const { data: lead } = await db
    .from("leads").select("first_name").eq("id", target.leadId).maybeSingle();

  const template = await getFollowupFallbackTemplate(db);
  const body = renderFollowupFallback(template, (lead?.first_name as string | null) ?? "");

  const { error } = await db.from("email_drafts").insert({
    campaign_id: target.campaignId,
    lead_id: target.leadId,
    step_number: target.stepOrder,
    subject: "",                 // threaded reply, same as a written follow-up
    body,
    // Approved because it is ready to send: follow-ups are not certified by a
    // human (agreed with the client 21 Aug 2026), and leaving it unapproved
    // would mean Instantly sends its own unlabelled fallback instead of this.
    status: "approved",
    source: "template",
    attempts,
    fallback_reason: reason.message,
    version: 1,
  });
  if (error) return null;

  let pushed = false;
  if (target.instantlyLeadId) {
    const sync = await syncApprovedDraftToInstantly(db, target.leadId, target.campaignId);
    pushed = sync.synced;
  }
  return { pushed };
}

/**
 * Replace template safety nets with the real thing, once that is possible again.
 *
 * A template draft is a placeholder, not a verdict. The common case by far is a
 * credit outage: the text goes in so nothing sends blank, credits come back an
 * hour later, and the lead should quietly get the personalised email it was
 * always meant to get. On 27 Aug 2026 that was 376 leads, none of them sent yet.
 *
 * TWO RULES MAKE THIS SAFE.
 *
 * 1. Only upgrade what Instantly has NOT sent. Once the customer has the
 *    template in their inbox, rewriting our copy reaches nobody — it only
 *    destroys the evidence that they got boilerplate, and leaves the client
 *    reading a personalised email we never actually sent.
 *
 * 2. Only run when a healthy key exists. That check IS the signal this waits
 *    for: while credits are out it returns false and nothing is attempted, so a
 *    dead wallet costs zero calls no matter how often the sweep runs. Retrying
 *    on a timer instead would burn the very credits it is waiting for.
 */
export async function upgradeTemplateFollowups(
  rootDb: SupabaseClient | undefined,
  opts: { limit?: number; companyId?: string } = {},
): Promise<{ found: number; upgraded: number; failed: number }> {
  const db = rootDb ?? createAdminClient();
  const startedAt = Date.now();

  let campaignQuery = db
    .from("campaigns")
    .select("id, name, human_in_loop, ai_prompt_context, company_id, followup_instruction")
    .eq("is_deleted", false)
    .in("status", ["active", "processing"]);
  if (opts.companyId) campaignQuery = campaignQuery.eq("company_id", opts.companyId);
  const { data: campaigns } = await campaignQuery;
  if (!campaigns?.length) return { found: 0, upgraded: 0, failed: 0 };

  // Rule 2: the healthy-key check IS the signal this pass waits for. While
  // credits are out it is false for every company, so not one call is made and
  // a dead wallet costs nothing however often the sweep runs. Checked per
  // company because provider_keys is company-scoped — one tenant's healthy key
  // says nothing about another's.
  const usable = await Promise.all(
    [...new Set(campaigns.map((c) => c.company_id as string))]
      .map(async (id) => [id, await hasUsableLlmKey(db, id)] as const),
  );
  const canGenerate = new Map(usable);
  const liveCampaigns = campaigns.filter((c) => canGenerate.get(c.company_id as string));
  if (liveCampaigns.length === 0) return { found: 0, upgraded: 0, failed: 0 };

  const campaignIds = liveCampaigns.map((c) => c.id as string);

  const { data: templates } = await db
    .from("email_drafts")
    .select("id, campaign_id, lead_id, step_number, attempts")
    .in("campaign_id", campaignIds)
    .eq("source", "template")
    .lt("attempts", MAX_TOTAL_ATTEMPTS)
    .limit(opts.limit ?? 50);

  if (!templates?.length) return { found: 0, upgraded: 0, failed: 0 };

  // Which of those steps Instantly has already delivered — rule 1 above.
  const { data: delivered } = await db
    .from("unibox_emails")
    .select("instantly_lead_id, step")
    .eq("direction", "sent_campaign")
    .in("campaign_id", campaignIds)
    .not("instantly_lead_id", "is", null)
    // Paged for the same reason findFollowupsToWrite pages: Supabase clamps a
    // response to 1000 rows server-side however large the .limit() is, and a
    // short read here means upgrading a follow-up the customer already has.
    .range(0, 999);

  // Only the leads this batch is actually about. Fetching every lead in the
  // campaign would sit right under Supabase's 1000-row ceiling and start losing
  // rows silently as the client grows — and a missing row here means upgrading a
  // follow-up the customer already received.
  const { data: cls } = await db
    .from("campaign_leads")
    .select("id, campaign_id, lead_id, instantly_lead_id")
    .in("lead_id", [...new Set(templates.map((t) => t.lead_id as string))]);

  const clByKey = new Map(
    (cls ?? []).map((c) => [`${c.campaign_id}:${c.lead_id}`, c]),
  );
  const sentSteps = new Set<string>();
  for (const row of delivered ?? []) {
    const ix = Number((row.step as string | null)?.split("_")[1]);
    if (Number.isFinite(ix)) sentSteps.add(`${row.instantly_lead_id}:${ix + 1}`);
  }

  const campaignById = new Map(liveCampaigns.map((c) => [c.id as string, c]));
  const result = { found: 0, upgraded: 0, failed: 0 };

  for (const t of templates) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;

    const cl = clByKey.get(`${t.campaign_id}:${t.lead_id}`);
    if (!cl) continue;
    if (sentSteps.has(`${cl.instantly_lead_id}:${t.step_number}`)) continue; // already delivered — leave it

    const campaign = campaignById.get(t.campaign_id as string);
    if (!campaign) continue;
    result.found++;

    const cdb = createScopedClient(campaign.company_id as string);
    try {
      const written = await writeOne(cdb, {
        campaignId: t.campaign_id as string,
        campaignLeadId: cl.id as string,
        leadId: t.lead_id as string,
        stepOrder: t.step_number as number,
        dueAt: new Date().toISOString(),
        instantlyLeadId: (cl.instantly_lead_id as string | null) ?? null,
        priorAttempts: (t.attempts as number) ?? 0,
      }, campaign);

      if (written && !written.templated) {
        // The new AI draft supersedes the placeholder. Marked rejected rather
        // than deleted so the history still shows a template was in place.
        await cdb.from("email_drafts")
          .update({ status: "rejected", updated_at: new Date().toISOString() })
          .eq("id", t.id);
        result.upgraded++;
      } else {
        await cdb.from("email_drafts")
          .update({ attempts: ((t.attempts as number) ?? 0) + 1 })
          .eq("id", t.id);
        result.failed++;
      }
    } catch {
      result.failed++;
    }
  }

  return result;
}
