import type { SupabaseClient } from "@supabase/supabase-js";
import { htmlToPlainText } from "@/lib/utils/email-html";
import { z } from "zod";
import { complete } from "@/lib/services/llm";
import { resolveCampaignSignature, resolveReplyPrompt, getProductOfferings, getCompanyContext } from "@/lib/services/settings";
import { appendSignatureToBody } from "@/lib/reply-body-html";
import { listThreadEmails, type InstantlyEmail } from "@/lib/services/instantly";

const ReplySchema = z.object({ subject: z.string(), body: z.string() });
const RevisionReplySchema = ReplySchema.extend({
  signature: z.string().optional(),
});

// How a reply is written lives in the editable `reply_drafter_prompt` setting,
// which now carries these rules plus its own precedence section putting the
// Additional instruction above them. Code used to append a NON-NEGOTIABLE
// block here that mostly duplicated that prompt and directly contradicted it:
// the prompt's "most important rule" asks for a one or two sentence answer to a
// short transactional reply, while the code demanded "3 to 6 sentences" and
// claimed to override anything above it. Same defect as the cold-email path.

const REPLY_REVISION_PREFIX = [
  "REVISION MODE — you are editing an existing reply draft, not writing a new one.",
  "Apply ONLY the user's Instruction to the Current reply subject, body, and signature/footer below.",
  "Preserve wording, structure, and tone everywhere the Instruction does not touch.",
  "Example: if asked to remove the last paragraph, delete it and leave the rest identical.",
  "The signature/footer IS editable. If the Instruction asks to change or remove the footer/signature, put the result in \"signature\" (empty string to remove it).",
  "If the Instruction does not mention the footer/signature, return signature as \"unchanged\".",
  "Do NOT invent a different reply from scratch.",
  "Return STRICT JSON: {\"subject\": string, \"body\": string, \"signature\": string}.",
  "\"body\" is the reply WITHOUT the signature/footer. \"signature\" is the footer block.",
  "",
].join("\n");

function stripTrailingSignature(plain: string, signatureBlock: string): string {
  if (!signatureBlock.trim()) return plain;
  const sigLines = signatureBlock.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (sigLines.length === 0) return plain;
  const first = sigLines[0];
  const idx = plain.lastIndexOf(first);
  if (idx > 20) {
    const tail = plain.slice(idx);
    const matched = sigLines.filter((line) => tail.includes(line)).length;
    if (matched >= Math.min(2, sigLines.length)) return plain.slice(0, idx).trimEnd();
  }
  return plain;
}

function resolveRevisedSignature(returned: string | undefined, original: string): string {
  if (returned === undefined) return original;
  const t = returned.trim();
  if (!t || /^(unchanged|same|keep)$/i.test(t)) return original;
  return t;
}

interface GenerateReplyArgs {
  /** Whose LLM key pays for this. See complete(). */
  companyId: string;
  replyDraftId: string;
  masterCampaignId: string | null;
  campaignName: string;
  replyText: string;
  replySubject: string | null;
  originalEmailText: string | null;
  threadId?: string | null;
  aiPromptContext?: string | null;
  customInstruction?: string;
  /** Previous reply draft to edit when a custom instruction is provided. */
  previousDraft?: { subject: string | null; body: string | null } | null;
}

export async function generateReplyDraft(
  db: SupabaseClient,
  args: GenerateReplyArgs,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // Optional: pull full thread for context (mind the 20/min cap; one call per reply is fine)
    let threadContext = "";
    if (args.threadId) {
      try {
        const emails: InstantlyEmail[] = await listThreadEmails(args.threadId);
        threadContext = emails
          .map((e) => {
            const who = e.ue_type === 2 ? "PROSPECT" : "US";
            const txt = (e.body?.text ?? "").trim();
            return txt ? `--- ${who} ---\n${txt}` : "";
          })
          .filter(Boolean)
          .join("\n\n");
      } catch { /* fall back to just the reply + original */ }
    }
    if (!threadContext) {
      threadContext = [
        `--- US (cold email) ---`, args.originalEmailText ?? "(not available)",
        ``, `--- PROSPECT (reply) ---`, args.replyText,
      ].join("\n");
    }

    // Resolve campaign owner (their prompt + signature) and additional AI
    // context from the master campaign. Replies speak with the same voice as
    // the cold email that started the thread (planning.md D1).
    let signatureBlock = "";
    let aiPromptContext = args.aiPromptContext?.trim() || null;
    let campaignName = args.campaignName;
    let campaignOwnerId: string | null = null;
    if (args.masterCampaignId) {
      const { data: campaign } = await db
        .from("campaigns")
        .select("name, signature_override, created_by, ai_prompt_context")
        .eq("id", args.masterCampaignId)
        .maybeSingle();
      if (campaign) {
        campaignOwnerId = campaign.created_by ?? null;
        if (!aiPromptContext && campaign.ai_prompt_context?.trim()) {
          aiPromptContext = campaign.ai_prompt_context.trim();
        }
        if (campaign.name) campaignName = campaign.name;
        signatureBlock = await resolveCampaignSignature(db, campaign).catch(() => "");
      }
    }

    const [drafter, products, companyContext] = await Promise.all([
      resolveReplyPrompt(db, campaignOwnerId),
      getProductOfferings(db),
      getCompanyContext(db),
    ]);
    const productBlock = products.length > 0
      ? "\n\nPRODUCT REFERENCE LIBRARY:\n\n" + products.map((p) => `${p.name.toUpperCase()}\n${p.description}`).join("\n\n")
      : "";

    const revisionInstruction = args.customInstruction?.trim() || "";
    const previousPlain = args.previousDraft?.body
      ? stripTrailingSignature(htmlToPlainText(args.previousDraft.body), signatureBlock)
      : "";
    const isRevision =
      !!revisionInstruction &&
      !!(args.previousDraft?.body?.trim() || args.previousDraft?.subject?.trim()) &&
      previousPlain.length > 0;

    const system = isRevision
      ? REPLY_REVISION_PREFIX
        + drafter
        + (companyContext ? `\n\nCompany context: ${companyContext}` : "")
        + productBlock
        + (aiPromptContext ? `\n\nAdditional campaign context:\n${aiPromptContext}` : "")
      : drafter
        + (companyContext ? `\n\nCompany context: ${companyContext}` : "")
        + productBlock
        + (aiPromptContext ? `\n\nAdditional campaign context:\n${aiPromptContext}` : "");

    const user = isRevision
      ? [
          `Campaign: "${campaignName}"`,
          "",
          "Current reply subject:",
          args.previousDraft?.subject?.trim() || "(none)",
          "",
          "Current reply body (without signature/footer):",
          previousPlain,
          "",
          "Current signature / footer (editable when the Instruction asks about footer/signature):",
          signatureBlock || "(none)",
          "",
          `Instruction: ${revisionInstruction}`,
        ].join("\n")
      : [
          `Campaign: "${campaignName}"`,
          `Original reply subject: ${args.replySubject ?? "(none)"}`,
          ``,
          `Full conversation so far (oldest first):`,
          threadContext,
          aiPromptContext ? `Campaign context: ${aiPromptContext}` : "",
          args.customInstruction ? `Additional instruction: ${args.customInstruction}` : "",
        ].filter(Boolean).join("\n");

    const { json } = await complete<{ subject: string; body: string; signature?: string }>({ system, user }, args.companyId);
    const parsed = isRevision ? RevisionReplySchema.safeParse(json) : ReplySchema.safeParse(json);
    if (!parsed.success) throw new Error("Reply shape mismatch");

    let body = parsed.data.body.trim()
      .replace(/\[Your Name\]/gi, "");
    if (!isRevision) {
      body = body.replace(/\n+\s*(best regards|regards|sincerely|thanks|thank you|cheers)[.,]?\s*$/i, "");
    }
    body = body.replace(/\n{3,}/g, "\n\n").trim();

    const effectiveSignature = isRevision
      ? resolveRevisedSignature(
          "signature" in parsed.data && typeof parsed.data.signature === "string"
            ? parsed.data.signature
            : undefined,
          signatureBlock,
        )
      : signatureBlock;
    if (effectiveSignature) {
      body = appendSignatureToBody(body, effectiveSignature);
    }

    await db.from("reply_drafts").update({
      subject: parsed.data.subject,
      body,
      status: "draft",
      updated_at: new Date().toISOString(),
    }).eq("id", args.replyDraftId);

    return { ok: true };
  } catch (err) {
    await db.from("reply_drafts").update({
      status: "failed",
      error: (err as Error).message,
      updated_at: new Date().toISOString(),
    }).eq("id", args.replyDraftId);
    return { ok: false, reason: (err as Error).message };
  }
}
