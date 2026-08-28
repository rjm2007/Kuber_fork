import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { plainToHtml, htmlToPlainText } from "@/lib/utils/email-html";
import { complete } from "@/lib/services/llm";
import {
  resolveDraftSystemPrompt,
  resolveCampaignSignature,
  getProductOfferings,
  getCompanyContext,
  getGenericTemplate,
} from "@/lib/services/settings";
import { logLeadEvent } from "@/lib/services/lead-events";
import { splitInstruction, customerProducts } from "@/lib/services/revision-input";
import { PROVIDER_UNAVAILABLE, isProviderOutage } from "@/lib/services/provider-errors";

/** Activity-timeline wording for a finished draft. */
function draftCreatedDetail(stepNumber: number, status: string): string {
  const what = stepNumber > 1
    ? `Follow-up email draft generated (step ${stepNumber})`
    : "Email draft generated";
  // humanInLoop=false auto-approves; say so, or the timeline shows a draft
  // being created and sent with no visible approval in between.
  return status === "approved" ? `${what} and auto-approved` : what;
}

// Short generic nudge used for follow-up steps (step > 1) on un-enriched leads,
// mirroring the "brief low-pressure nudge" rule the AI follow-ups also follow.
const GENERIC_FOLLOWUP_BODY =
  "Just following up on my earlier note about Kuber Polyplast's masterbatch and polymer compounds. " +
  "If it is worth a quick look, I would be glad to share details suited to your requirements.";

// Fills {{first_name}} / {{name}} / {{company}} placeholders in a template.
function fillTemplate(text: string, vars: { first_name: string; company: string }): string {
  return text.replace(/\{\{\s*(first_name|name|company)\s*\}\}/gi, (_m, key: string) =>
    key.toLowerCase() === "company" ? vars.company : vars.first_name,
  );
}

// The LLM writes the full email body from the Email Template system prompt
// (subject patterns, openings, offerings, closings, etc. live there as options).
// Code only adds greeting + signature and turns "brochure" into a download link.

const DraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  product_match: z.string(),
});

const RevisionDraftSchema = DraftSchema.extend({
  /** Footer/signature block. Omit or "unchanged" to keep the current one. */
  signature: z.string().optional(),
});

type DraftLLMOutput = z.infer<typeof DraftSchema>;
type RevisionDraftLLMOutput = z.infer<typeof RevisionDraftSchema>;

type OrgData = {
  name?: string | null;
  domain?: string | null;
  company_description?: string | null;
  sells_to?: string | null;
  keywords?: string[] | null;
  industry?: string | null;
  website?: string | null;
  employees?: number | null;
  city?: string | null;
  country?: string | null;
};

type LeadRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  city: string | null;
  country: string | null;
  assigned_to: string | null;
  organizations: OrgData | OrgData[] | null;
};

export type CampaignLeadTarget = {
  id: string;
  lead_id: string;
  attachment_name?: string | null;
  attachment_path?: string | null;
  attachment_url?: string | null;
  leads: LeadRow | LeadRow[] | null;
};

function unwrapOrg(raw: OrgData | OrgData[] | null | undefined): OrgData | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

function unwrapLead(raw: LeadRow | LeadRow[] | null | undefined): LeadRow | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

// Both moved to provider-errors.ts so provider-keys.ts can share the same
// vocabulary without importing this module, and so the predicates stay testable
// without dragging zod/supabase in. Imported (they are used below) AND
// re-exported, so existing importers of this module are unchanged.
export { PROVIDER_UNAVAILABLE, isProviderOutage };

/** Write the row the service-health banner watches for.
 *
 *  `source: 'llm'` + `DRAFT_LLM_UNAVAILABLE` is what /api/v1/service-health
 *  matches to raise the red "no LLM provider has credits" banner, which every
 *  role sees. Best-effort by design: a logging failure must never mask the
 *  real error or block the caller.
 *
 *  `companyId` is explicit because the watchdog calls this with an UNSCOPED
 *  client — and the banner reads through a company-scoped one, so a row
 *  written without it is invisible to the very UI it exists to feed. Scoped
 *  callers can pass null and let the client stamp it. */
export async function logLlmUnavailable(
  db: SupabaseClient,
  companyId: string | null,
  error: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.from("enrichment_logs").insert({
      source: "llm",
      event: "DRAFT_LLM_UNAVAILABLE",
      error: error.slice(0, 500),
      ...(companyId ? { company_id: companyId } : {}),
      payload,
      created_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

/**
 * Whether a freshly written draft waits for a human.
 *
 * Only an OPENING email can. Follow-ups are not certified by anyone — agreed
 * with the client on 21 Aug 2026 — and the follow-up writer already passes
 * humanInLoop=false for that reason. Regeneration did not: it passed the
 * campaign's real setting, so regenerating a follow-up on a human-in-the-loop
 * campaign quietly demoted it from 'approved' to 'draft'. That takes it out of
 * the set syncApprovedDraftToInstantly rebuilds from, so Instantly falls back to
 * its own generic string and the customer receives boilerplate — with the
 * personalised text sitting right there in the UI looking correct.
 *
 * Decided here rather than at each caller so there is one answer to the
 * question, and a third caller cannot get it wrong again.
 */
function statusForStep(humanInLoop: boolean, stepNumber: number): "draft" | "approved" {
  return humanInLoop && stepNumber === 1 ? "draft" : "approved";
}

/**
 * Clear the "no LLM credits" banner once drafting works again.
 *
 * /api/v1/service-health takes the NEWEST source='llm' row per company and
 * shows a red banner while it carries an error — so a success row is what lets
 * a fixed key win over a stale failure. Only org scraping ever wrote one, which
 * meant that after topping up a key the alarm stayed on for the full six-hour
 * window unless someone happened to enrich a company. Reported 28 Aug 2026: key
 * replaced at 12:24, last failure 12:20, banner still up.
 *
 * Called once per batch rather than per draft — the banner only needs one row
 * to flip, and one per draft would bury the log it lives in.
 *
 * Best-effort: a logging failure must never turn a successful batch into a
 * failed one.
 */
export async function logLlmRecovered(
  db: SupabaseClient,
  companyId: string | null,
): Promise<void> {
  try {
    await db.from("enrichment_logs").insert({
      source: "llm",
      event: "DRAFT_LLM_RECOVERED",
      error: null,
      ...(companyId ? { company_id: companyId } : {}),
      payload: {},
      created_at: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

/** One place for what happens when a draft attempt throws.
 *
 *  Previously both catch blocks wrote status 'failed' and nothing else:
 *  rejection_reason stayed null, so the campaign view showed "No draft" with no
 *  explanation, and nothing reached enrichment_logs, which is what the
 *  service-health banner reads. A whole campaign could die of an empty billing
 *  account with no indication anywhere in the UI. */
async function recordDraftFailure(
  db: SupabaseClient,
  draftId: string,
  leadId: string,
  campaignId: string,
  stepNumber: number,
  err: unknown,
): Promise<void> {
  const message = (err as Error).message ?? "Unknown error";
  const outage = isProviderOutage(message);
  const now = new Date().toISOString();

  await db.from("email_drafts").update({
    status: "failed",
    rejection_reason: `${outage ? PROVIDER_UNAVAILABLE + ": " : ""}${message}`.slice(0, 500),
    updated_at: now,
  }).eq("id", draftId);

  if (outage) {
    // db is company-scoped here, so the insert stamps company_id itself.
    await logLlmUnavailable(db, null, message, {
      campaign_id: campaignId, draft_id: draftId, step: stepNumber,
    });
  }

  await logLeadEvent(db, leadId, "draft_failed", "Email draft generation failed", {
    metadata: { campaign_id: campaignId, draft_id: draftId, step: stepNumber, reason: message, provider_outage: outage },
  });
}

/** Drop the appended signature so the model edits the email body only. */
function stripTrailingSignature(plain: string, signatureBlock: string): string {
  if (!signatureBlock.trim()) return plain;
  const sigLines = signatureBlock
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (sigLines.length === 0) return plain;

  const out = plain.trimEnd();
  const first = sigLines[0];
  const idx = out.lastIndexOf(first);
  if (idx > 40) {
    const tail = out.slice(idx);
    // Only cut if the tail roughly matches the signature (avoid chopping body text
    // that happens to share a first line with the sig, e.g. a person's name).
    const matched = sigLines.filter((line) => tail.includes(line)).length;
    if (matched >= Math.min(2, sigLines.length)) {
      return out.slice(0, idx).trimEnd();
    }
  }
  return out;
}

export type PreviousDraftContent = {
  subject: string | null;
  body: string | null;
};

// When the user regenerates with an instruction ("remove the last paragraph"),
// the CURRENT email is the base — not a fresh write from lead data.
//
// The blocks are named because the user's one textarea carries two different
// things (a change and, often, a whole example email) and the model could not
// tell them apart. It resolved the ambiguity by copying the example's prospect:
// "Astral Ltd" reached 97 of 100 emails in one campaign. Naming the blocks and
// stating which one is authoritative for facts is the fix; see splitInstruction.
const REVISION_SYSTEM_PREFIX = [
  "REVISION MODE — you are rewriting one existing cold email for one named prospect.",
  "",
  "═══ HOW TO READ THE USER MESSAGE ═══",
  "It contains labelled blocks:",
  "  [THEIR COMPANY]  who we are writing to. The ONLY source of facts about them.",
  "  [OLD EMAIL]      the current draft. Your starting point.",
  "  [EXAMPLE EMAIL]  optional. A FORMAT SAMPLE, not a source of facts.",
  "  [THE CHANGE]     what the user wants done. Highest priority.",
  "Two more blocks are below this line: [OUR COMPANY] is the \"ABOUT KUBER POLYPLAST\"",
  "section, and [OUR PRODUCTS] is the \"PRODUCT REFERENCE LIBRARY\" section.",
  "",
  "═══ HARD RULES ═══",
  "1. The recipient's company is the name in [THEIR COMPANY]. Nothing else is.",
  "2. [EXAMPLE EMAIL] is formatting only. Any company name, contact name, product or",
  "   detail inside it belongs to a DIFFERENT prospect. Never copy those. Replace",
  "   every one with the matching value from [THEIR COMPANY].",
  "3. Never take a company name from a campaign title, a customer/reference list, a",
  "   subject line, or your own knowledge.",
  "4. Placeholders — \"(write about the customer's company)\", \"(client name)\",",
  "   \"[Company]\", \"Dear Chris\" — must never appear in the output. Replace each with",
  "   the real value.",
  "5. If a fact is missing from [THEIR COMPANY], omit the claim. Never guess what they",
  "   make. Never write \"your website\" as a substitute for their name.",
  "6. If [THEIR COMPANY] says \"Not available\", write a correct generic email that still",
  "   addresses them by company name, and pick the closest fit from [OUR PRODUCTS].",
  "",
  "═══ WHAT [THE CHANGE] MEANS ═══",
  "EDIT (\"remove the last paragraph\", \"shorter\", \"add a line about X\"): apply only",
  "that; preserve all other wording, structure, tone, facts and length. If the",
  "Instruction is \"remove the last paragraph\", delete it and leave every other",
  "sentence identical.",
  "FORMAT ([EXAMPLE EMAIL] is present): reproduce its structure, wording and",
  "formatting exactly, filling every customer-specific slot from [THEIR COMPANY].",
  "",
  "═══ EVERY EMAIL MUST ═══",
  "- Name the prospect's company at least once, spelled as in [THEIR COMPANY].",
  "- State what they actually make, grounded in [THEIR COMPANY].",
  "- Tie it to ONE item from [OUR PRODUCTS]; set product_match to its exact name",
  "  (or \"unchanged\" if [THE CHANGE] does not ask to change the product).",
  "- Open with the greeting as the first line of body.",
  "- Contain no em dashes.",
  "",
  "═══ BODY vs SIGNATURE ═══",
  "\"body\" is the greeting plus the message. It must NOT contain a sign-off, sender",
  "name, job title, phone, WhatsApp, email address or postal address — those are",
  "appended separately and would otherwise appear twice. If [EXAMPLE EMAIL] ends",
  "with such a block, it belongs in \"signature\", not \"body\".",
  "The signature IS editable: when [THE CHANGE] asks to alter the footer, put the",
  "result in \"signature\" (empty string to remove it). Otherwise return \"unchanged\".",
  "",
  "Return STRICT JSON: {\"subject\": string, \"body\": string, \"signature\": string, \"product_match\": string}.",
  "",
].join("\n");

function attachmentNote(name?: string | null): string {
  return name
    ? `a brochure file "${name}" is included with this email, so mention "brochure" once in the closing`
    : "No attachment, so do NOT mention any attachment or brochure anywhere in the body";
}

/** Everything known about the prospect. Absent facts say so rather than being
 *  omitted, so a gap never reads as an invitation to invent one. */
function buildProspectBlock(lead: LeadRow, attachment: string): string {
  const org = unwrapOrg(lead.organizations);
  const v = (x: string | number | null | undefined) => {
    const s = x === null || x === undefined ? "" : String(x).trim();
    return s || "Not available";
  };
  const website = org?.website?.trim() || (org?.domain ? `https://${org.domain}` : "");
  return [
    "[THEIR COMPANY]",
    `Contact:          ${v([lead.first_name, lead.last_name].filter(Boolean).join(" "))}`,
    `Job title:        ${v(lead.title ?? lead.headline)}`,
    `Location:         ${v([lead.city, lead.country].filter(Boolean).join(", "))}`,
    `Company name:     ${v(org?.name)}`,
    `Website:          ${v(website)}`,
    `Industry:         ${v(org?.industry)}`,
    `Size:             ${org?.employees ? `${org.employees} employees` : "Not available"}`,
    `Headquarters:     ${v([org?.city, org?.country].filter(Boolean).join(", "))}`,
    `What they make:   ${v(customerProducts(org))}`,
    `About them:       ${v(org?.company_description)}`,
    `They sell to:     ${v(org?.sells_to)}`,
    `Attachment:       ${attachment}`,
  ].join("\n");
}

// The campaign NAME is deliberately absent. It used to be the first line here,
// and with no company name in the prompt the model read it as the prospect:
// 23 emails opened "I came across Apollo" from `Campaign: "APOLLO CAMPAIGN 5"`,
// addressed to Pipeco Tanks, Hamilton Tanks and others. Only the campaign's
// ai_prompt_context survives, labelled so it cannot be mistaken for a company.
function buildRevisionUserPrompt(
  lead: LeadRow,
  change: string,
  example: string,
  previous: { subject: string; body: string; signature: string },
  stepNumber: number,
  attachmentName?: string | null,
  aiPromptContext?: string,
): string {
  const parts = [`Email step: ${stepNumber} of 3`];
  if (aiPromptContext?.trim()) parts.push(`Campaign context: ${aiPromptContext.trim()}`);

  parts.push(
    "",
    buildProspectBlock(lead, attachmentNote(attachmentName)),
    "",
    "[OLD EMAIL]",
    `Subject: ${previous.subject || "(empty)"}`,
    "Body:",
    previous.body,
    "Signature:",
    previous.signature || "(none)",
  );

  if (example) {
    parts.push(
      "",
      "[EXAMPLE EMAIL] — format sample only. Any company name, contact name or detail",
      "inside it belongs to a DIFFERENT prospect and must be replaced with the values",
      "in [THEIR COMPANY].",
      example,
    );
  }

  parts.push("", "[THE CHANGE]", change);
  return parts.join("\n");
}

function resolveRevisedSignature(returned: string | undefined, original: string): string {
  if (returned === undefined) return original;
  const t = returned.trim();
  if (!t || /^(unchanged|same|keep)$/i.test(t)) return original;
  return t;
}

// How an email gets written now lives entirely in the editable system prompt
// (Settings → the company `system_prompt`, or a user's personal draft_prompt).
// Code used to append a block of "NON-NEGOTIABLE RULES" here that restated the
// mandatory structure and claimed priority over everything above it. That made
// a regenerate instruction like "keep it to 30 words" unwinnable: the model
// obeyed the code-level rule and re-emitted the full offerings / key strengths
// / accolades boilerplate on every lead. The rules moved into the system prompt,
// which now carries its own precedence section putting the Additional
// instruction above the default structure.
//
// What code still contributes is DATA, not style: who the sender is
// (ABOUT KUBER POLYPLAST), the product library, the campaign context, and the
// lead's own details. Everything below is that data plus mechanical assembly.

function buildCompanyBlock(companyContext: string): string {
  if (!companyContext.trim()) return "";
  return "\n\nABOUT KUBER POLYPLAST — the sender. Every claim you make about Kuber must be grounded here or in the product library:\n\n" + companyContext.trim();
}

function buildProductReferenceBlock(products: Awaited<ReturnType<typeof getProductOfferings>>): string {
  if (products.length === 0) return "";
  const entries = products.map((p) => `${p.name.toUpperCase()}\n${p.description}`);
  return "\n\nPRODUCT REFERENCE LIBRARY — pick the ONE best fit for this lead and set product_match to its exact name:\n\n" + entries.join("\n\n");
}

// The lead's own details. Kuber's details are in the system prompt (they are the
// same for every lead); this is only what changes per prospect. The system
// prompt's precedence section is what makes "Additional instruction" win, so it
// is passed plainly here rather than wrapped in another layer of shouting.
function buildUserPrompt(
  lead: LeadRow,
  campaignName: string,
  customInstruction?: string,
  aiPromptContext?: string,
  stepNumber = 1,
  attachmentName?: string | null,
): string {
  const org = unwrapOrg(lead.organizations);
  const lines = [
    `Campaign: "${campaignName}"`,
    `Email step: ${stepNumber} of 3${stepNumber > 1 ? " (a follow-up to a previous cold email the prospect did not reply to)" : ""}`,
    `Name: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unknown"}`,
    `Title: ${lead.title ?? lead.headline ?? "Unknown"}`,
    `Seniority: ${lead.seniority ?? "Unknown"}`,
    `Country: ${lead.country ?? "Unknown"}`,
    `Company: ${org?.name ?? "Unknown"}`,
    `Website: ${org?.domain ? `https://${org.domain}` : "N/A"}`,
    `What they do: ${org?.company_description ?? "Not available"}`,
    `Their end markets / customers: ${org?.sells_to ?? "Not available"}`,
    `Keywords: ${(org?.keywords ?? []).join(", ") || "Not available"}`,
    `Attachment: ${attachmentNote(attachmentName)}`,
  ];
  if (aiPromptContext?.trim()) lines.push(`Campaign context: ${aiPromptContext.trim()}`);
  if (customInstruction?.trim()) {
    lines.push(`Additional instruction: ${customInstruction.trim()}`);
  }
  return lines.join("\n");
}

// Bug fix (found while testing the enrichment pipeline): fetchDraftTargets'
// retry cap and countPendingDrafts' "stop retrying, exhausted" check both
// work by counting existing `email_drafts` rows with status='failed' for a
// lead. That means any failure path that returns `{ ok: false }` WITHOUT
// first creating one of those rows is invisible to both — the lead never
// accumulates a strike, never hits the 3-attempt cap, and stays "pending"
// forever. Since campaign_leads.draft_id also never gets set, the batch
// worker's self-trigger (`after()` in the route) sees the same lead as
// still-pending on every subsequent call and re-fires itself indefinitely.
// Confirmed live: one lead stuck in this state produced dozens of
// self-triggered POSTs in a few minutes with no end in sight.
//
// This records a `failed` marker (+ a `draft_failed` activity-log entry, for
// the same reason a human should see it, not just the retry counter) so
// early-exit failures count toward the cap exactly like an LLM-extraction
// failure already does. uq_email_drafts_campaign_lead_step is a PARTIAL
// unique index (`WHERE status NOT IN ('rejected','failed')`), so a
// status='failed' insert is exempt from it by construction and can't
// collide with whatever row caused the original failure — this insert is
// effectively always safe, not just best-effort.
async function recordUnattemptedFailure(db: SupabaseClient, target: CampaignLeadTarget, campaignId: string, stepNumber: number, reason: string): Promise<void> {
  await db.from("email_drafts").insert({
    lead_id: target.lead_id,
    campaign_id: campaignId,
    step_number: stepNumber,
    status: "failed",
    created_at: new Date().toISOString(),
  });
  await logLeadEvent(db, target.lead_id, "draft_failed", "Email draft generation failed", {
    metadata: { campaign_id: campaignId, step: stepNumber, reason },
  });
}

/** Generate one draft for a campaign lead. Returns draft id on success. */
export async function generateOneDraft(
  db: SupabaseClient,
  target: CampaignLeadTarget,
  campaignId: string,
  humanInLoop: boolean,
  campaignName: string,
  userId?: string,
  customInstruction?: string,
  aiPromptContext?: string,
  existingDraftId?: string,
  stepNumber = 1,
  /** Set when this draft is part of a bulk regeneration run; surfaced in the lead's activity log. */
  bulkJobId?: string,
  /**
   * When regenerating with a custom instruction, pass the previous version so
   * the model edits that email instead of writing a new one from lead data.
   */
  previousDraft?: PreviousDraftContent | null,
): Promise<{ ok: true; draftId: string; status: string } | { ok: false; reason: string }> {
  const lead = unwrapLead(target.leads);
  if (!lead) {
    await recordUnattemptedFailure(db, target, campaignId, stepNumber, "Lead not found");
    return { ok: false, reason: "Lead not found" };
  }
  if (!lead.email) {
    await recordUnattemptedFailure(db, target, campaignId, stepNumber, "Lead has no email");
    return { ok: false, reason: "Lead has no email" };
  }

  // --- Fetch full campaign for attachment + owner resolution ---
  const { data: campaign } = await db
    .from("campaigns")
    .select("id, created_by, signature_override, attachment_name, attachment_path, attachment_url, ai_prompt_context")
    .eq("id", campaignId)
    .maybeSingle();

  // Personal voice (signature + system prompt) belongs to whoever actually owns
  // this LEAD, not whoever created the campaign — a campaign is a shared
  // container (planning.md Phase 4 / spec §5), so a manager-created campaign
  // holding three employees' leads must not sign every one of them with the
  // manager's own signature. Falls back to the campaign creator only for a
  // still-unassigned pool lead, which has no more specific owner yet.
  const promptOwnerId = lead.assigned_to ?? campaign?.created_by ?? null;

  // Signature: campaign override → lead owner's personal signature → company default.
  const signatureBlock = await resolveCampaignSignature(db, { ...campaign, created_by: promptOwnerId });

  // Per-lead attachment overrides campaign default. Instantly's API cannot send
  // real file attachments, so an "attachment" is delivered as a hosted download
  // link embedded in the body — and if there is none, the LLM is told so.
  const effectiveAttachmentName = target.attachment_name ?? campaign?.attachment_name ?? null;
  const effectiveAttachmentPath =
    (target.attachment_name ? target.attachment_path : campaign?.attachment_path) ?? null;
  let effectiveAttachmentUrl =
    (target.attachment_name ? target.attachment_url : campaign?.attachment_url) ?? null;
  if (effectiveAttachmentPath) {
    // Regenerate a long-lived signed URL — the one stored at upload time expires in 7 days.
    const { data: signed } = await db.storage
      .from("campaign-attachments")
      .createSignedUrl(effectiveAttachmentPath, 60 * 60 * 24 * 365);
    if (signed?.signedUrl) effectiveAttachmentUrl = signed.signedUrl;
  }

  // --- Draft row (insert or reuse) ---
  let draftId = existingDraftId;

  if (!draftId) {
    const { data: draft, error: dErr } = await db
      .from("email_drafts")
      .insert({
        lead_id: lead.id,
        campaign_id: campaignId,
        step_number: stepNumber,
        status: "generating",
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (dErr || !draft) {
      // The most likely cause is exactly this: the "generating" insert hit
      // uq_email_drafts_campaign_lead_step because a live (non-rejected,
      // non-failed) draft already exists for this campaign+lead+step — e.g.
      // a stale campaign_leads.draft_id was reset to null while the row it
      // used to point at was left behind. Record the failure anyway so this
      // lead stops being re-selected forever instead of erroring identically
      // on every self-triggered retry.
      const reason = dErr?.message ?? "Failed to create draft";
      await recordUnattemptedFailure(db, target, campaignId, stepNumber, reason);
      return { ok: false, reason };
    }
    draftId = draft.id;
  }

  if (!draftId) return { ok: false, reason: "No draft row created" };

  const activeDraftId = draftId;

  // ── Un-enriched lead → generic (name-swap) template, no LLM call ─────────────
  // When the company has no usable profile (no website / unscrapeable / enrichment
  // failed → lead status "input_required"), there is nothing to personalise with.
  // Use the ready-made template and only fill in the recipient's name/company.
  // Exception: a regenerate WITH an instruction must still edit the existing
  // email — falling through to the template would wipe the user's draft.
  const org = unwrapOrg(lead.organizations);
  const hasOrgData = !!org?.company_description?.trim();
  const revisionInstruction = customInstruction?.trim() || "";
  const previousPlainBody = previousDraft?.body
    ? stripTrailingSignature(htmlToPlainText(previousDraft.body), signatureBlock)
    : "";
  /** Rewriting an existing draft with nothing said about what to change.
   *
   *  Keyed on previousDraft rather than on the instruction text: a campaign's
   *  STANDING guidance ("mention the Dubai warehouse") also arrives as a
   *  customInstruction, and that is not someone asking to edit this particular
   *  email. The previous body is handed over only for a genuine one-off edit,
   *  so its absence is the honest signal for "just write another one". */
  const isPlainRegeneration = !!existingDraftId && !previousDraft?.body?.trim();

  const isRevision =
    !!revisionInstruction &&
    !!(previousDraft?.body?.trim() || previousDraft?.subject?.trim()) &&
    previousPlainBody.length > 0;

  if (!hasOrgData && !isRevision) {
    try {
      const template = await getGenericTemplate(db);
      const firstName = lead.first_name?.trim() ?? "";
      const vars = { first_name: firstName, company: org?.name?.trim() || "your company" };

      const greeting = firstName ? `Dear ${firstName},` : "Dear Sir/Ma'am,";
      let genericBody =
        (stepNumber > 1 ? fillTemplate(GENERIC_FOLLOWUP_BODY, vars) : fillTemplate(template.body, vars)).trim();

      // Defense in depth: never mention a brochure on follow-ups or when none is attached.
      if (stepNumber > 1 || !effectiveAttachmentName) {
        genericBody = genericBody
          .replace(/[^.\n]*\bbrochure\b[^.\n]*\.\s*/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      // Tokenise the brochure mention in the BODY text before assembly so the
      // download link can never land inside the signature (planning.md 6.6).
      const BROCHURE_TOKEN = "XBROCHURELINKX";
      const linkBrochure = stepNumber === 1 && !!effectiveAttachmentName && !!effectiveAttachmentUrl && /brochure/i.test(genericBody);
      if (linkBrochure) genericBody = genericBody.replace(/brochure/i, BROCHURE_TOKEN);

      let finalBody = plainToHtml([greeting, genericBody, signatureBlock].filter(Boolean).join("\n\n"));
      if (linkBrochure) {
        finalBody = finalBody.replace(
          BROCHURE_TOKEN,
          `<a href="${effectiveAttachmentUrl}" target="_blank" rel="noopener">brochure</a>`,
        );
      }
      const finalSubject = stepNumber > 1 ? "" : fillTemplate(template.subject, vars);

      const finalStatus = statusForStep(humanInLoop, stepNumber);
      const now = new Date().toISOString();

      await db.from("email_drafts").update({
        subject: finalSubject,
        body: finalBody,
        status: finalStatus,
        ...(finalStatus === "approved" ? { approved_at: now, reviewed_by: userId ?? null } : {}),
        updated_at: now,
      }).eq("id", activeDraftId);

      if (stepNumber === 1) {
        await db.from("campaign_leads").update({
          draft_id: activeDraftId,
          crm_status: finalStatus === "approved" ? "approved" : "draft",
          updated_at: now,
        }).eq("id", target.id);
      }

      await logLeadEvent(db, lead.id, "draft_created", draftCreatedDetail(stepNumber, finalStatus), {
        actorId: userId ?? null,
        metadata: { campaign_id: campaignId, draft_id: activeDraftId, step: stepNumber, status: finalStatus, generic_template: true, ...(bulkJobId ? { bulk_job_id: bulkJobId } : {}) },
      });

      return { ok: true, draftId: activeDraftId, status: finalStatus };
    } catch (err) {
      // Mark only the draft row failed — campaign_leads.draft_id stays NULL so
      // the auto-generator retries this lead on the next batch instead of
      // skipping it forever (planning.md Phase 6.5).
      await recordDraftFailure(db, activeDraftId, lead.id, campaignId, stepNumber, err);
      return { ok: false, reason: (err as Error).message };
    }
  }

  try {
    const [baseSystemPrompt, products, companyContext] = await Promise.all([
      resolveDraftSystemPrompt(db, promptOwnerId, stepNumber),
      getProductOfferings(db),
      getCompanyContext(db),
    ]);
    // Style, structure and precedence all live in the system prompt now; code
    // only supplies the data it is written against (sender, products) and the
    // per-campaign context. Revision mode prefixes hard edit rules so an
    // instruction like "remove the last paragraph" cannot trigger a full rewrite.
    const systemPrompt = isRevision
      ? REVISION_SYSTEM_PREFIX
        + baseSystemPrompt
        + buildCompanyBlock(companyContext)
        + buildProductReferenceBlock(products)
      : baseSystemPrompt
        + buildCompanyBlock(companyContext)
        + buildProductReferenceBlock(products);

    // One textarea carries both "what to change" and, often, a whole example
    // email. Separating them is what stops the example's prospect being copied.
    const { change, example } = splitInstruction(revisionInstruction);

    const userPrompt = isRevision
      ? buildRevisionUserPrompt(
          lead,
          change,
          example,
          {
            subject: previousDraft?.subject?.trim() || "",
            body: previousPlainBody,
            signature: signatureBlock,
          },
          stepNumber,
          effectiveAttachmentName,
          aiPromptContext ?? campaign?.ai_prompt_context ?? undefined,
        )
      : buildUserPrompt(lead, campaignName, customInstruction, aiPromptContext, stepNumber, effectiveAttachmentName);

    const { json } = await complete<DraftLLMOutput | RevisionDraftLLMOutput>({
      system: systemPrompt,
      user: userPrompt,
      // Drafting runs at 0.2 so it follows the rules and does not invent facts.
      // That determinism makes a plain "write it again" pointless: same prompt,
      // same lead, same email — byte for byte, which is exactly what pressing
      // Regenerate returned. When someone asks for another version with no
      // instruction, variety IS the request, so this one case gets room to
      // differ. An instruction-led revision stays at the low default: "remove
      // the last paragraph" wants precision, not imagination.
      ...(isPlainRegeneration ? { temperature: 0.8 } : {}),
    });

    const validated = isRevision
      ? RevisionDraftSchema.safeParse(json)
      : DraftSchema.safeParse(json);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      console.error("Draft schema validation failed for lead", lead.id, issues, json);
      throw new Error(`Draft shape mismatch — ${issues}`);
    }

    // A follow-up threads as a reply, so the signature is already sitting in the
    // message directly above it. Appending it again reads as a bot and pads a
    // deliberately short nudge with more footer than body — measured 25 Aug 2026,
    // a 235-character follow-up carried a 90-character signature. Step 1 keeps it.
    const signatureForStep = stepNumber > 1 ? "" : signatureBlock;

    // A REVISION lets the model hand back its own signature, which is right for
    // an opening email — the user may have asked to change the sign-off. It is
    // never right for a follow-up: the original signature is already visible in
    // the quoted message directly above, and the model happily invents one when
    // asked to revise. Seen live 28 Aug 2026 — regenerating a 240-character
    // follow-up returned it unchanged except for a six-line signature bolted on
    // the end, which is the whole email again in footer.
    const effectiveSignature = stepNumber > 1
      ? ""
      : isRevision
        ? resolveRevisedSignature(
            "signature" in validated.data && typeof validated.data.signature === "string"
              ? validated.data.signature
              : undefined,
            signatureForStep,
          )
        : signatureForStep;

    // Safety nets only — these clean up output, they never impose structure or
    // length, so a custom instruction can still shape the email freely. The
    // unfilled-placeholder and duplicate-sign-off strips exist because the
    // signature is appended below; the em-dash strip is because em dashes are a
    // well-known AI-writing tell and compliance with the prompt rule is not
    // guaranteed. In revision mode we keep intentional closings (the footer
    // lives in `signature`, not in these strips).
    let aiBody = validated.data.body
      .trim()
      .replace(/\[Your Name\]/gi, "")
      .replace(/\[Your (Title|Position)\]/gi, "")
      .replace(/\[Your Contact Information\]/gi, "")
      .replace(/\[Your Company\]/gi, "");
    if (!isRevision) {
      aiBody = aiBody.replace(
        /\n+\s*(best regards|regards|sincerely|warm regards|thanks|thank you|cheers)[.,]?\s*$/i,
        "",
      );
    } else {
      // A pasted example email usually ends with its own sign-off block, and the
      // model tends to keep it in `body` even though the signature is appended
      // below. That put "Ashish Sharma" twice into 99 of 100 emails in one
      // campaign (and his WhatsApp number into all 100). Same helper the
      // previous body is normalised with, so it only cuts a real repeat.
      aiBody = stripTrailingSignature(aiBody, effectiveSignature);
    }
    aiBody = aiBody
      .replace(/\s*[—–]\s*/g, ", ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (stepNumber > 1 || !effectiveAttachmentName) {
      aiBody = aiBody.replace(
        /[^.\n]*\b(please find (the\s+)?attached|find attached|attached (our|the|is|you will find)|our attached|brochure)\b[^.\n]*\.\s*/gi,
        "",
      ).replace(/\n{3,}/g, "\n\n").trim();
    }

    // The prompt asks for the greeting as the body's first line, so a custom
    // instruction ("address them as Dear Sir") can actually change it. Code no
    // longer prepends one unconditionally; it only fills in when the model
    // skipped the greeting, so an email can never open mid-sentence.
    if (!/^\s*(dear|hi|hello|greetings|good (morning|afternoon|evening))\b/i.test(aiBody)) {
      const greetingName = lead.first_name?.trim();
      aiBody = `${greetingName ? `Dear ${greetingName},` : "Dear Sir/Ma'am,"}\n\n${aiBody}`;
    }

    // Instantly cannot send real attachments, so deliver the brochure as a
    // link — tokenised in the AI body BEFORE assembly so the anchor can never
    // land inside the signature block (planning.md 6.6).
    const BROCHURE_TOKEN = "XBROCHURELINKX";
    const linkBrochure = stepNumber === 1 && !!effectiveAttachmentName && !!effectiveAttachmentUrl && /brochure/i.test(aiBody);
    if (linkBrochure) aiBody = aiBody.replace(/brochure/i, BROCHURE_TOKEN);

    let finalBody = plainToHtml([aiBody, effectiveSignature].filter(Boolean).join("\n\n"));
    if (linkBrochure) {
      finalBody = finalBody.replace(
        BROCHURE_TOKEN,
        `<a href="${effectiveAttachmentUrl}" target="_blank" rel="noopener">brochure</a>`,
      );
    }

    // Follow-ups must thread as a reply in the original conversation, which
    // Instantly does by leaving the subject empty — a hard rule, not left to
    // the LLM's judgment (it will invent one anyway if not forced here).
    const finalSubject = stepNumber > 1 ? "" : validated.data.subject;

    const finalStatus = statusForStep(humanInLoop, stepNumber);
    const now = new Date().toISOString();

    await db.from("email_drafts").update({
      subject: finalSubject,
      body: finalBody,
      status: finalStatus,
      ...(finalStatus === "approved" ? { approved_at: now, reviewed_by: userId ?? null } : {}),
      updated_at: now,
    }).eq("id", activeDraftId);

    // Only step 1 drives the lead's primary crm_status/draft_id — that's the
    // pipeline the sidebar badge, "Certify all", and "draft-ready" counts read.
    // A follow-up (step > 1) is generated for a lead whose step-1 email is
    // already sent; it must not flip that lead back to looking like "draft"
    // everywhere. Follow-up drafts live entirely in their own mini-panel,
    // queried directly by step_number (see /drafts/[id]/siblings).
    if (stepNumber === 1) {
      await db.from("campaign_leads").update({
        draft_id: activeDraftId,
        crm_status: finalStatus === "approved" ? "approved" : "draft",
        updated_at: now,
      }).eq("id", target.id);
    }

    await logLeadEvent(db, lead.id, "draft_created", draftCreatedDetail(stepNumber, finalStatus), {
      actorId: userId ?? null,
      metadata: { campaign_id: campaignId, draft_id: activeDraftId, step: stepNumber, status: finalStatus, ...(bulkJobId ? { bulk_job_id: bulkJobId } : {}) },
    });

    return { ok: true, draftId: activeDraftId, status: finalStatus };
  } catch (err) {
    // Mark only the draft row failed — campaign_leads.draft_id stays NULL so
    // the auto-generator retries this lead on the next batch instead of
    // skipping it forever (planning.md Phase 6.5). fetchDraftTargets caps
    // retries at 3 failed versions per lead/step.
    await recordDraftFailure(db, activeDraftId, lead.id, campaignId, stepNumber, err);
    return { ok: false, reason: (err as Error).message };
  }
}

/** Fetch campaign_leads eligible for draft generation (batch). */
export async function fetchDraftTargets(
  db: SupabaseClient,
  campaignId: string,
  limit = 10,
  stepNumber = 1,
): Promise<CampaignLeadTarget[]> {
  const { data: generatingDrafts } = await db
    .from("email_drafts")
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .eq("status", "generating");

  const generatingLeadIds = new Set((generatingDrafts ?? []).map((d) => d.lead_id));

  // Failed drafts leave draft_id NULL so leads are retried — but cap retries at
  // 3 failed versions per lead/step to stop a pathological lead looping the LLM
  // forever (planning.md Phase 6.5). Beyond the cap, retry is manual.
  // Outage failures are excluded: they say nothing about the lead. The null
  // branch keeps historic rows (written before rejection_reason was recorded)
  // counting exactly as they did before.
  const { data: failedDrafts } = await db
    .from("email_drafts")
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .eq("step_number", stepNumber)
    .eq("status", "failed")
    .or(`rejection_reason.is.null,rejection_reason.not.like.${PROVIDER_UNAVAILABLE}%`);
  const failCount = new Map<string, number>();
  for (const d of failedDrafts ?? []) {
    failCount.set(d.lead_id, (failCount.get(d.lead_id) ?? 0) + 1);
  }
  const overFailCap = (leadId: string) => (failCount.get(leadId) ?? 0) >= 3;

  // Capped leads are excluded IN THE QUERY, not just from the rows it returns.
  // Filtering afterwards meant they still occupied the fetch window: every
  // campaign_leads row of a bulk import shares one created_at, so `order by
  // created_at` is a tie and the capped leads sat at the front of it. On
  // ANKIT's 100-lead campaign all 20 slots of the window were capped leads,
  // fetchDraftTargets returned zero targets, and the route concluded
  // "no_more_pending" and stopped self-chaining — with 44 leads still waiting.
  // Topping up credits would not have restarted it.
  //
  // The nil uuid keeps the list non-empty so the filter can be applied
  // unconditionally — `not.in.()` is a syntax error, and wrapping the builder
  // in a conditional helper instead sent tsc into TS2589 ("type instantiation
  // excessively deep") on Supabase's chained generics. A sentinel that matches
  // no lead is the cheaper answer than fighting the type.
  //
  // ponytail: sends the capped ids as a literal `not.in` list, fine while
  // campaigns are hundreds of leads (100 uuids ≈ 3.7KB of URL). If one ever
  // runs to five figures, push the cap into a SQL view or an RPC.
  const cappedLeadIds = [
    "00000000-0000-0000-0000-000000000000",
    ...[...failCount.entries()].filter(([, n]) => n >= 3).map(([id]) => id),
  ];
  const notCapped = `(${cappedLeadIds.join(",")})`;

  if (stepNumber === 1) {
    const { data: rows } = await db
      .from("campaign_leads")
      .select(`
        id, lead_id,
        attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
        leads!lead_id!inner(
          id, first_name, last_name, email, title, headline, seniority, city, country, assigned_to,
          organizations(name, domain, website, industry, employees, city, country, company_description, sells_to, keywords)
        )
      `)
      .eq("campaign_id", campaignId)
      .is("draft_id", null)
      .in("crm_status", ["new", "enriched", "draft"])
      .not("lead_id", "in", notCapped)
      .not("leads.email", "is", null)
      .order("created_at", { ascending: true })
      .limit(limit * 2);

    return (rows ?? [])
      .filter((r) => !generatingLeadIds.has(r.lead_id) && !overFailCap(r.lead_id))
      .slice(0, limit) as CampaignLeadTarget[];
  }

  // For follow-up steps: find approved/sent leads that don't yet have a draft for this step.
  const { data: existingStepDrafts } = await db
    .from("email_drafts")
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .eq("step_number", stepNumber);

  const alreadyHasStep = new Set((existingStepDrafts ?? []).map((d) => d.lead_id));

  const { data: rows } = await db
    .from("campaign_leads")
    .select(`
      id, lead_id,
      attachment_path, attachment_name, attachment_mime, attachment_size, attachment_url,
      leads!lead_id!inner(
        id, first_name, last_name, email, title, headline, seniority, city, country, assigned_to,
        organizations(name, domain, website, industry, employees, city, country, company_description, sells_to, keywords)
      )
    `)
    .eq("campaign_id", campaignId)
    .in("crm_status", ["approved", "sent"])
    .not("lead_id", "in", notCapped)
    .not("leads.email", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit * 2);

  return (rows ?? [])
    .filter((r) => !generatingLeadIds.has(r.lead_id) && !alreadyHasStep.has(r.lead_id) && !overFailCap(r.lead_id))
    .slice(0, limit) as CampaignLeadTarget[];
}

/**
 * Count leads still pending draft generation. Leads that have exhausted their
 * retry cap (3 failed versions) are excluded — otherwise the worker would loop
 * forever thinking there's work left (pairs with fetchDraftTargets' cap).
 */
export async function countPendingDrafts(db: SupabaseClient, campaignId: string): Promise<number> {
  const { data: pending } = await db
    .from("campaign_leads")
    .select("lead_id")
    .eq("campaign_id", campaignId)
    .is("draft_id", null)
    .in("crm_status", ["new", "enriched", "draft"]);

  let pendingCount = pending?.length ?? 0;
  if (pendingCount > 0) {
    const { data: failedDrafts } = await db
      .from("email_drafts")
      .select("lead_id")
      .eq("campaign_id", campaignId)
      .eq("step_number", 1)
      .eq("status", "failed")
      .or(`rejection_reason.is.null,rejection_reason.not.like.${PROVIDER_UNAVAILABLE}%`);
    const failCount = new Map<string, number>();
    for (const d of failedDrafts ?? []) {
      failCount.set(d.lead_id, (failCount.get(d.lead_id) ?? 0) + 1);
    }
    pendingCount = (pending ?? []).filter((p) => (failCount.get(p.lead_id) ?? 0) < 3).length;
  }

  const { count: generatingCount } = await db
    .from("email_drafts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "generating");

  return pendingCount + (generatingCount ?? 0);
}
