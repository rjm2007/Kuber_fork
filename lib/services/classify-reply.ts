import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { complete } from "@/lib/services/llm";
import { TEMPERATURE_TO_INTEREST } from "@/lib/constants";
import { getReplyPrompts } from "@/lib/services/settings";
import { updateLeadInterestStatus } from "@/lib/services/instantly";

const ClassificationSchema = z.object({
  temperature: z.enum(["hot", "warm", "cold", "neutral", "ooo", "unsubscribed"]),
  interest_status: z.number().nullable(),
  reasoning: z.string(),
});
export type ReplyClassification = z.infer<typeof ClassificationSchema>;

interface ClassifyArgs {
  originalEmailText: string | null;
  replyText: string;
  /** Whose LLM key pays for this. See complete(). */
  companyId: string;
}

export async function classifyReply(db: SupabaseClient, args: ClassifyArgs): Promise<ReplyClassification> {
  const user = [
    `--- OUR COLD EMAIL ---`,
    args.originalEmailText ?? "(not available)",
    ``,
    `--- PROSPECT REPLY ---`,
    args.replyText,
  ].join("\n");

  try {
    const { classifier } = await getReplyPrompts(db);
    const { json } = await complete<ReplyClassification>({
      system: classifier,
      user,
    }, args.companyId);
    const parsed = ClassificationSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  } catch { /* fall through to safe default */ }

  return { temperature: "neutral", interest_status: null, reasoning: "classifier unavailable" };
}

/**
 * Apply a classification to a campaign_lead: set lead_temperature + interest_status locally,
 * update campaign hot/cold counters, and sync the interest back to Instantly (so its sequence
 * stops and its AI doesn't overwrite us).
 */
export async function applyClassification(
  db: SupabaseClient,
  args: {
    campaignLeadId: string | null;
    masterCampaignId: string | null;
    leadEmail: string | null;
    classification: ReplyClassification;
    replyEventId: string;
  },
): Promise<void> {
  const { classification: c } = args;
  const interest = c.interest_status ?? TEMPERATURE_TO_INTEREST[c.temperature] ?? null;
  const now = new Date().toISOString();

  // record the verdict on the reply_event
  await db.from("reply_events")
    .update({ intent_classified: c.temperature })
    .eq("id", args.replyEventId);

  if (args.campaignLeadId) {
    await db.from("campaign_leads").update({
      lead_temperature: c.temperature,
      interest_status: interest,
      updated_at: now,
    }).eq("id", args.campaignLeadId);
  }

  // counters on the master campaign (best-effort, non-fatal)
  if (args.masterCampaignId) {
    try {
      if (c.temperature === "hot" || c.temperature === "warm") {
        await db.rpc("increment_campaign_counter", { p_campaign_id: args.masterCampaignId, p_column: "hot_count" });
      } else if (c.temperature === "cold") {
        await db.rpc("increment_campaign_counter", { p_campaign_id: args.masterCampaignId, p_column: "cold_count" });
      }
    } catch { /* non-fatal */ }
  }

  // sync to Instantly: stops sequence + locks our verdict
  if (args.leadEmail && interest !== null) {
    await updateLeadInterestStatus({
      leadEmail: args.leadEmail,
      interestValue: interest,
      disableAutoInterest: true,
    }).catch(() => { /* non-fatal: webhook will reconcile */ });
  }
}
