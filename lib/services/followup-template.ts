import type { SupabaseClient } from "@supabase/supabase-js";
import { getFollowupFallbackTemplate } from "@/lib/services/settings";

/**
 * The text a follow-up falls back to when it cannot be personalised.
 *
 * Two situations reach here, and they mean the same thing:
 *
 *   the lead has no company data   (an "Input Required" lead — enrichment
 *                                   never produced a description)
 *   the AI failed outright         (no credits, retries exhausted)
 *
 * Before this existed they used two DIFFERENT texts. The AI-failure case read a
 * global setting; the no-data case used a constant hardcoded in
 * generate-drafts.ts that could not be edited anywhere and named "Kuber
 * Polyplast" in the source, so a second client on this system would have sent
 * emails naming the wrong company.
 *
 * Resolution order, most specific first:
 *
 *   1. this campaign's own text for THIS step   campaign_steps.fallback_body
 *   2. the install-wide default                 settings.followup_fallback_body
 *   3. the built-in last resort                 BUILT_IN_FOLLOWUP_FALLBACK
 *
 * Per step rather than per campaign because that is what was asked for: a
 * second nudge and a fourth nudge can reasonably say different things. The cost
 * is more boxes to fill, which is why every level is optional and the default
 * has to be good enough that most campaigns never touch them.
 */

/** Last resort, used only when neither the campaign nor Settings has text.
 *  Deliberately says nothing a specific company would have to own. */
export const BUILT_IN_FOLLOWUP_FALLBACK =
  "Just following up on my earlier note. If it is worth a quick look, " +
  "I would be glad to share details suited to your requirements.";

/** Fills {{first_name}} / {{name}} / {{company}}. Same placeholders the
 *  opening-email template already uses, so there is one syntax to learn. */
export function fillFollowupTemplate(
  text: string,
  vars: { first_name: string; company: string },
): string {
  return text.replace(/\{\{\s*(first_name|name|company)\s*\}\}/gi, (_m, key: string) =>
    key.toLowerCase() === "company" ? vars.company : vars.first_name,
  );
}

/**
 * Resolve the fallback text for one step, unfilled.
 *
 * `stepOrder` is required and must be > 1: step 1 is the opening email and has
 * its own generic template in Settings, which is a different thing entirely.
 *
 * Never throws. A follow-up that cannot be personalised is already the degraded
 * path, and failing to read a setting must not turn it into no email at all —
 * so every lookup falls through to the built-in text.
 */
export async function resolveFollowupTemplate(
  db: SupabaseClient,
  campaignId: string,
  stepOrder: number,
): Promise<string> {
  try {
    if (stepOrder > 1) {
      const { data } = await db
        .from("campaign_steps")
        .select("fallback_body")
        .eq("campaign_id", campaignId)
        .eq("step_order", stepOrder)
        .maybeSingle();

      const perStep = (data?.fallback_body as string | null)?.trim();
      if (perStep) return perStep;
    }

    const fromSettings = (await getFollowupFallbackTemplate(db))?.trim();
    if (fromSettings) return fromSettings;
  } catch {
    // fall through — see the note above
  }
  return BUILT_IN_FOLLOWUP_FALLBACK;
}
