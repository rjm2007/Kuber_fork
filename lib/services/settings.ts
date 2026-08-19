import type { SupabaseClient } from "@supabase/supabase-js";
import { DRAFT_JSON_SUFFIX, MANDATORY_FORMATTING_RULES } from "@/lib/services/llm";

// Settings live in two layers (planning.md Phase 1):
//   • `settings`       — company-wide defaults, editable by managers only.
//   • `user_settings`  — one row per user; every column is nullable and NULL
//     means "inherit the company default". Generation always resolves through
//     the CAMPAIGN OWNER's user_settings first, then the company default.
//
// No module-level caching here: these are single-row indexed reads that sit
// next to multi-second LLM calls, and the old per-instance 60s cache caused
// "my edit didn't apply" confusion on serverless (stale instances).

export type ClientContext = {
  industry: string;
  defaultSenderName: string;
};

export async function getSystemPrompt(db: SupabaseClient): Promise<string> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", "system_prompt")
    .maybeSingle();

  return data?.value?.trim() ?? "";
}

export { DRAFT_JSON_SUFFIX };

export async function getClientContext(db: SupabaseClient): Promise<ClientContext> {
  const { data: rows } = await db
    .from("settings")
    .select("key, value")
    .in("key", ["client_industry", "default_sender_name"]);

  const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value ?? ""]));

  return {
    industry: map.client_industry || "Plastics & Polymer Manufacturing",
    defaultSenderName: map.default_sender_name || "Kuber Polyplast",
  };
}

// ── Per-user settings ─────────────────────────────────────────────────────────

export type UserSettings = {
  user_id: string;
  draft_prompt: string | null;
  draft_template: string | null;
  reply_prompt: string | null;
  signature: string | null;
  sender_name: string | null;
  theme: string | null;
  theme_mode: string | null;
};

export async function getUserSettings(db: SupabaseClient, userId: string | null | undefined): Promise<UserSettings | null> {
  if (!userId) return null;
  const { data } = await db
    .from("user_settings")
    .select("user_id, draft_prompt, draft_template, reply_prompt, signature, sender_name, theme, theme_mode")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as UserSettings | null) ?? null;
}

/** The campaign owner's personal drafting prompt, else the company default. */
export async function resolveDraftPrompt(db: SupabaseClient, ownerId: string | null | undefined): Promise<string> {
  const user = await getUserSettings(db, ownerId);
  const personal = user?.draft_prompt?.trim();
  if (personal) return personal;
  return getSystemPrompt(db);
}

/**
 * Rules that hold no matter whose template is in use.
 *
 * A personal prompt REPLACES the company system prompt (resolveDraftPrompt
 * above returns early), which meant a sales rep pasting their own email
 * silently switched off every truthfulness rule the company prompt carried.
 * They are re-asserted here so a template can shape the email freely without
 * also disabling the things that create liability.
 */
export const NON_NEGOTIABLE_RULES = [
  "",
  "",
  "NON-NEGOTIABLE (these outrank everything above):",
  "- Never state a price, discount, percentage, delivery time, lead time, technical",
  "  spec, certification or number that is not present in the material given to you.",
  "  Qualitative claims are fine; invented numbers are not.",
  "- Never invent a need. If you cannot name the physical product this prospect",
  "  would actually buy, do not manufacture a connection to it.",
  "- Every fact about the prospect comes from the prospect details in the user",
  "  message. Every fact about us comes from the company and product blocks.",
  "  Nothing comes from your own knowledge.",
  "- No em dashes or en dashes anywhere. Straight apostrophes and quotes only.",
  "- Placeholders must never survive into the output: text in brackets such as",
  "  \"(write about the customer's company)\", \"(client name)\", \"[Company]\", or a",
  "  sample name like \"Dear Chris\" must be replaced with this prospect's real value.",
].join("\n");

/**
 * How a personal TEMPLATE is framed for the model.
 *
 * Without this the template is handed over as bare content with no explanation
 * of what to do with it, so the model treats it as loose inspiration and
 * rewrites it. Measured 19 Aug 2026 on 20 leads: 48% of the template's own
 * elements survived generation, and the worst element survived twice in twenty.
 */
const TEMPLATE_CONTRACT = [
  "You are reproducing an approved email template for ONE named prospect.",
  "The template below decides the structure, the wording, the order, the tone and",
  "the length. You decide only what goes in the prospect-specific slots.",
  "",
  "HOW TO USE THE TEMPLATE",
  "- Reproduce every paragraph, bullet, statistic, award, client name and closing",
  "  line it contains, in the same order, with the same wording. Do not improve it,",
  "  shorten it, reorder it, summarise it, or drop a section because you judge it",
  "  irrelevant to this particular prospect. If the template lists four product",
  "  types, all four appear. If it ends with a specific ask, that ask appears.",
  "- The ONLY things you may change are the prospect-specific parts: their company",
  "  name, what they manufacture, their industry and end markets, and any sentence",
  "  the template explicitly asks you to write about them.",
  "- Where the template contains a bracketed instruction such as",
  "  \"(Write about the customer's company and products)\", that bracket is an",
  "  instruction to you, not text to print. Replace the whole bracket with one or",
  "  two real sentences about THIS prospect, drawn from their details below.",
  "- If a detail is missing for this prospect, drop that clause rather than",
  "  guessing, and keep the rest of the template intact.",
  "",
  "TEMPLATE STARTS",
].join("\n");

/** The campaign owner's personal email template, if they have set one. */
export async function resolveDraftTemplate(
  db: SupabaseClient,
  ownerId: string | null | undefined,
): Promise<string | null> {
  const user = await getUserSettings(db, ownerId);
  return user?.draft_template?.trim() || null;
}

export function buildTemplateSystemPrompt(template: string): string {
  return `${TEMPLATE_CONTRACT}\n\n${template.trim()}\n\nTEMPLATE ENDS`;
}

/** The campaign owner's personal reply prompt, else the company default. */
export async function resolveReplyPrompt(db: SupabaseClient, ownerId: string | null | undefined): Promise<string> {
  const user = await getUserSettings(db, ownerId);
  const personal = user?.reply_prompt?.trim();
  const base = personal || (await getReplyPrompts(db)).drafter;
  return `${base.trimEnd()}${MANDATORY_FORMATTING_RULES}`;
}

/** The campaign owner's personal "From" name, else the company default. */
export async function resolveSenderName(db: SupabaseClient, ownerId: string | null | undefined): Promise<string> {
  const user = await getUserSettings(db, ownerId);
  const personal = user?.sender_name?.trim();
  if (personal) return personal;
  const client = await getClientContext(db);
  return client.defaultSenderName;
}

// ── Client-context block appended to draft prompts ───────────────────────────
// Products come from the Product Offerings library (the single source of truth);
// the old client_products / client_target_markets settings were removed as
// duplicates (planning.md D2).

async function buildClientContextBlock(db: SupabaseClient): Promise<string> {
  const [client, products] = await Promise.all([
    getClientContext(db),
    getProductOfferings(db),
  ]);
  const lines = ["Client context:", `Industry: ${client.industry}`];
  if (products.length > 0) {
    lines.push(`Products: ${products.map((p) => p.name).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Full drafting system prompt for a campaign: the owner's prompt (or company
 * default) + JSON output instructions + the client-context block.
 */
export async function resolveDraftSystemPrompt(db: SupabaseClient, ownerId: string | null | undefined): Promise<string> {
  const template = await resolveDraftTemplate(db, ownerId);

  // A template is a shape to reproduce, so it gets the template contract and
  // NOT the formatting rules: those force bullet lists and bolding, which
  // rewrite a template that deliberately has neither. The template is the
  // format. Everything else (JSON contract, company/product context, the
  // non-negotiables) still applies.
  const base = template
    ? buildTemplateSystemPrompt(template)
    : `${(await resolveDraftPrompt(db, ownerId)).trimEnd()}${MANDATORY_FORMATTING_RULES}`;

  const withJson =
    /["']subject["']/.test(base) && /["']body["']/.test(base) && /["']product_match["']/.test(base)
      ? base
      : `${base.trimEnd()}${DRAFT_JSON_SUFFIX}`;
  const contextBlock = await buildClientContextBlock(db);
  return `${withJson}${NON_NEGOTIABLE_RULES}\n\n${contextBlock}`;
}

export async function getEmailSignature(db: SupabaseClient): Promise<string> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", "email_signature")
    .maybeSingle();
  return data?.value?.trim() || "";
}

// ── Structured signature ────────────────────────────────────────────────────

const SIGNATURE_KEYS = [
  "signature_name",
  "signature_title",
  "signature_contact",
  "signature_company",
] as const;

const SIGNATURE_DEFAULTS = {
  name:    "Kuber Polyplast Sales Team",
  title:   "Business Development",
  // TODO: Replace +91-XXXXXXXXXX with the real phone number before sending live campaigns.
  contact: "Kuber Polyplast\n+91-XXXXXXXXXX\nsales@kuberpolyplast.com",
  company: "Kuber Polyplast",
};

export interface Signature {
  name: string;
  title: string;
  contact: string;
  company: string;
}

export async function getSignature(db: SupabaseClient): Promise<Signature> {
  const { data: rows } = await db
    .from("settings")
    .select("key, value")
    .in("key", [...SIGNATURE_KEYS]);

  const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value ?? ""]));

  return {
    name:    map.signature_name?.trim()    || SIGNATURE_DEFAULTS.name,
    title:   map.signature_title?.trim()   || SIGNATURE_DEFAULTS.title,
    contact: map.signature_contact?.trim() || SIGNATURE_DEFAULTS.contact,
    company: map.signature_company?.trim() || SIGNATURE_DEFAULTS.company,
  };
}

// ── Campaign signature resolver ──────────────────────────────────────────────

/**
 * Resolve the signature block for a campaign:
 *   1. campaign.signature_override (free-text, wins always)
 *   2. the campaign OWNER's personal signature (user_settings)
 *   3. company default (settings.signature_contact)
 */
export async function resolveCampaignSignature(
  db: SupabaseClient,
  campaign: {
    signature_override?: string | null;
    created_by?: string | null;
  },
): Promise<string> {
  if (campaign.signature_override?.trim()) {
    return campaign.signature_override.trim();
  }

  const owner = await getUserSettings(db, campaign.created_by);
  if (owner?.signature?.trim()) {
    return owner.signature.trim();
  }

  const sig = await getSignature(db);
  return sig.contact;
}

// ── Dynamic product offerings ─────────────────────────────────────────────────

export type ProductOffering = { name: string; description: string };

export async function getProductOfferings(db: SupabaseClient): Promise<ProductOffering[]> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", "product_offerings")
    .maybeSingle();

  try { return JSON.parse(data?.value ?? "[]") as ProductOffering[]; } catch { return []; }
}

// ── Reply classification & drafting prompts (company defaults) ───────────────

export type ReplyPrompts = { classifier: string; drafter: string };

export async function getReplyPrompts(db: SupabaseClient): Promise<ReplyPrompts> {
  const { data: rows } = await db
    .from("settings")
    .select("key, value")
    .in("key", ["reply_classifier_prompt", "reply_drafter_prompt"]);

  const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value ?? ""]));

  return {
    classifier: map.reply_classifier_prompt?.trim() ?? "",
    drafter: map.reply_drafter_prompt?.trim() ?? "",
  };
}

export async function getCompanyContext(db: SupabaseClient): Promise<string> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", "company_context")
    .maybeSingle();

  return data?.value?.trim() ?? "";
}

// ── Generic (name-swap) template for un-enriched leads ────────────────────────
// Leads with no usable company profile (status "input_required" — the company has
// no website, an unscrapeable site, or enrichment failed) can still join a campaign.
// They get this ready-made template with only the recipient's name/company filled
// in, instead of an AI-personalised draft. Overridable via the settings keys
// `generic_email_subject` / `generic_email_body`; falls back to the defaults below.
// Supported placeholders in both fields: {{first_name}}, {{name}}, {{company}}.

export type GenericTemplate = { subject: string; body: string };

const GENERIC_TEMPLATE_DEFAULTS: GenericTemplate = {
  subject: "Reliable masterbatch & polymer compounds for {{company}}",
  body:
    "I hope this message finds you well. I am reaching out from Kuber Polyplast regarding {{company}}.\n\n" +
    "We manufacture colour, white, black and additive masterbatches used across packaging, moulding and extrusion. Manufacturers work with us for consistent quality batch after batch and dependable, on-time supply.\n\n" +
    "If improving material quality or cost is on your radar, I would be glad to understand {{company}}'s requirements and share options that fit. Would you be open to a short conversation?",
};

export async function getGenericTemplate(db: SupabaseClient): Promise<GenericTemplate> {
  const { data: rows } = await db
    .from("settings")
    .select("key, value")
    .in("key", ["generic_email_subject", "generic_email_body"]);

  const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value ?? ""]));

  return {
    subject: map.generic_email_subject?.trim() || GENERIC_TEMPLATE_DEFAULTS.subject,
    body: map.generic_email_body?.trim() || GENERIC_TEMPLATE_DEFAULTS.body,
  };
}

/** Kept for call-site compatibility; the settings layer is no longer cached. */
export function invalidateSettingsCache() {}
