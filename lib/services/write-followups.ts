import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { findFollowupsToWrite, type FollowupTarget } from "@/lib/services/followup-schedule";
import { generateOneDraft } from "@/lib/services/generate-drafts";
import { syncApprovedDraftToInstantly } from "@/lib/services/draft-sync";

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

export type WriteFollowupsResult = {
  found: number;
  written: number;
  pushed: number;
  failed: number;
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
    found: targets.length, written: 0, pushed: 0, failed: 0, ranOutOfTime: false,
  };
  if (targets.length === 0) return result;

  // Campaign metadata is read once per campaign, not once per lead: a sweep of
  // 50 follow-ups usually spans only a handful of campaigns.
  const campaignIds = [...new Set(targets.map((t) => t.campaignId))];
  const { data: campaigns } = await db
    .from("campaigns")
    .select("id, name, human_in_loop, ai_prompt_context, company_id")
    .in("id", campaignIds);
  const campaignById = new Map((campaigns ?? []).map((c) => [c.id as string, c]));

  for (const target of targets) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { result.ranOutOfTime = true; break; }

    const campaign = campaignById.get(target.campaignId);
    if (!campaign) { result.failed++; continue; }

    // Scoped to the owning company so every row written here is stamped with it,
    // exactly like sendCampaign does. The sweep above is cross-company by
    // necessity; the writes must not be.
    const cdb = createScopedClient(campaign.company_id as string);

    try {
      const written = await writeOne(cdb, target, campaign);
      if (!written) { result.failed++; continue; }
      result.written++;
      if (written.pushed) result.pushed++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

async function writeOne(
  db: SupabaseClient,
  target: FollowupTarget,
  campaign: { id: string; name: string; human_in_loop: boolean; ai_prompt_context: string | null },
): Promise<{ pushed: boolean } | null> {
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
    undefined,
    campaign.ai_prompt_context ?? undefined,
    undefined,
    target.stepOrder,
  );

  if (!result.ok) return null;

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

  return { pushed };
}
