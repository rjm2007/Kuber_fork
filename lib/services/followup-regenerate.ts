import { z } from "zod";
import { complete } from "@/lib/services/llm";
import { plainToHtml, htmlToPlainText } from "@/lib/utils/email-html";

const FollowUpRewriteSchema = z.object({
  body: z.string(),
});

/**
 * Isolated follow-up rewrite — deliberately independent of the step-1 draft
 * pipeline (generateOneDraft / buildUserPrompt). Uses ONLY the current
 * follow-up text and the user's instruction: no lead/org data, no Kuber
 * context, no product library, no shared base system prompt. A follow-up is
 * a short reply-style nudge, not a second cold pitch, and must never be
 * generated the same way as the original draft.
 */
export async function regenerateFollowUpText(opts: {
  leadFirstName: string | null;
  currentBody: string; // HTML
  instruction: string;
  /** Whose LLM key pays for this. See complete(). */
  companyId: string;
}): Promise<{ body: string }> {
  const system = [
    "You rewrite short cold-email follow-up nudges.",
    "Rules:",
    "- 2-4 short sentences, casual \"just checking in\" tone.",
    "- Do not reintroduce a company pitch, product list, or bullet points.",
    "- Do not write a subject line — follow-ups always thread as a reply.",
    "- Apply the user's instruction to the CURRENT follow-up text below; rewrite it, don't start over from scratch.",
    "Return strict JSON: {\"body\": \"...\"}",
  ].join("\n");

  const user = [
    `Recipient first name: ${opts.leadFirstName?.trim() || "there"}`,
    "",
    "Current follow-up email:",
    htmlToPlainText(opts.currentBody),
    "",
    `Instruction: ${opts.instruction}`,
  ].join("\n");

  const { json } = await complete<{ body: string }>({ system, user }, opts.companyId);
  const validated = FollowUpRewriteSchema.safeParse(json);
  if (!validated.success) throw new Error("Follow-up rewrite shape mismatch");

  return { body: plainToHtml(validated.data.body.trim()) };
}

/**
 * Campaign-level follow-up template rewrite for the Sequences tab.
 * Output keeps the literal {{firstName}} placeholder — not a real name.
 */
export async function regenerateFollowUpTemplateText(opts: {
  currentBody: string; // HTML or plain
  instruction: string;
  /** Whose LLM key pays for this. See complete(). */
  companyId: string;
}): Promise<{ body: string }> {
  const system = [
    "You rewrite short cold-email follow-up nudges as campaign templates.",
    "Rules:",
    "- 2-4 short sentences, casual \"just checking in\" tone.",
    "- Do not reintroduce a company pitch, product list, or bullet points.",
    "- Do not write a subject line — follow-ups always thread as a reply.",
    "- Greet the recipient with the literal placeholder {{firstName}} (exact spelling, with double braces) — never substitute a real name.",
    "- Keep any other {{variable}} placeholders from the current text unchanged.",
    "- Apply the user's instruction to the CURRENT follow-up text below; rewrite it, don't start over from scratch.",
    "Return strict JSON: {\"body\": \"...\"}",
  ].join("\n");

  const user = [
    "Current follow-up template:",
    htmlToPlainText(opts.currentBody),
    "",
    `Instruction: ${opts.instruction}`,
  ].join("\n");

  const { json } = await complete<{ body: string }>({ system, user }, opts.companyId);
  const validated = FollowUpRewriteSchema.safeParse(json);
  if (!validated.success) throw new Error("Follow-up template rewrite shape mismatch");

  return { body: plainToHtml(validated.data.body.trim()) };
}
