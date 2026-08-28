import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The standing guidance for one follow-up: the campaign's, plus that step's.
 *
 * Lives on its own because TWO paths write follow-ups and both must apply it.
 * The scheduled writer picks it up when a follow-up is first written; regenerate
 * — single lead or bulk — has to pick up the same thing, or "save the
 * instruction and regenerate everyone" rewrites every email WITHOUT the
 * instruction that was just typed, which is worse than not offering the button.
 *
 * Additive rather than either/or: "mention the Dubai warehouse" belongs on every
 * follow-up while "ask directly for a call" belongs only on the last one, and
 * that last step usually wants both at once.
 */
export async function resolveStandingFollowupInstruction(
  db: SupabaseClient,
  campaignId: string,
  stepOrder: number,
): Promise<string | undefined> {
  if (stepOrder <= 1) return undefined; // opening emails have their own template

  const [{ data: campaign }, { data: step }] = await Promise.all([
    db.from("campaigns").select("followup_instruction").eq("id", campaignId).maybeSingle(),
    db.from("campaign_steps").select("ai_instruction")
      .eq("campaign_id", campaignId).eq("step_order", stepOrder).maybeSingle(),
  ]);

  const parts = [
    campaign?.followup_instruction as string | null,
    step?.ai_instruction as string | null,
  ].map((p) => p?.trim()).filter((p): p is string => !!p);

  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Merge the standing guidance with a one-off instruction typed into the
 * regenerate box.
 *
 * Kept separate from the edit-mode decision on purpose. A one-off instruction
 * ("remove the last paragraph") means EDIT THIS EMAIL, so the previous body is
 * handed to the model. Standing guidance means "write it this way" and must not
 * flip a routine regeneration into an edit of whatever was there before —
 * otherwise every follow-up would be a rewrite of the last one and drift
 * further from the source material each time.
 */
export function mergeInstructions(
  standing: string | undefined,
  oneOff: string | undefined,
): string | undefined {
  const parts = [standing, oneOff].map((p) => p?.trim()).filter((p): p is string => !!p);
  return parts.length ? parts.join(" ") : undefined;
}
