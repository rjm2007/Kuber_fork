import { z } from "zod";

// Company-wide settings (the `settings` table). Personal preferences — drafting
// prompt, reply prompt, signature, sender name, theme — live in `user_settings`
// and are validated by UserSettingsSchema below (planning.md Phase 1).
//
// Removed keys: client_products / client_target_markets (duplicated the Product
// Offerings library — planning.md D2), theme / theme_mode (per-user now).
export const PatchSettingsSchema = z.object({
  default_sender_name:   z.string().max(200).optional(),
  system_prompt:         z.string().optional(),
  client_industry:       z.string().max(300).optional(),
  company_context:       z.string().optional(),
  email_signature:       z.string().optional(),
  brand_logo_path:       z.string().optional(),
  signature_name:        z.string().max(200).optional(),
  signature_title:       z.string().max(200).optional(),
  signature_contact:     z.string().max(500).optional(),
  signature_company:     z.string().max(200).optional(),
  email_subject_template:  z.string().max(300).optional(), // supports {product} and {company}
  product_offerings:       z.string().optional(), // JSON: [{name, description}]
  reply_classifier_prompt: z.string().optional(),
  reply_drafter_prompt:    z.string().optional(),
  // Default (name-swap) draft for unenriched / Input Required leads.
  // Supports {{first_name}}, {{name}}, {{company}}.
  generic_email_subject:   z.string().max(300).optional(),
  generic_email_body:      z.string().optional(),
});

// The subset of company settings an employee may edit: the Product Offerings
// library only. Company Details (sender name, industry, company context, brand
// logo) is company identity — one employee editing it rewrites every user's
// outreach — so it is manager/super-admin only, same as the prompts. An
// employee did exactly that on 21 Aug 2026: pasted their own prospecting email
// into company_context and set default_sender_name to their own name.
export const KNOWLEDGE_SETTINGS_KEYS = [
  "product_offerings",
] as const;

export const SETTINGS_KEYS = [
  "default_sender_name",
  "system_prompt",
  "client_industry",
  "company_context",
  "email_signature",
  "brand_logo_path",
  "signature_name",
  "signature_title",
  "signature_contact",
  "signature_company",
  "email_subject_template",
  "product_offerings",
  "reply_classifier_prompt",
  "reply_drafter_prompt",
  "generic_email_subject",
  "generic_email_body",
] as const;

// ── Per-user settings (`user_settings` table) ────────────────────────────────
// Every field is optional; sending null clears the value back to "inherit the
// company default".

const THEME_IDS = ["monochrome", "blue", "green", "purple", "orange", "rose"] as const;
const THEME_MODES = ["dark", "light"] as const;

export const PatchUserSettingsSchema = z.object({
  draft_prompt:   z.string().max(20_000).nullable().optional(),
  draft_template: z.string().max(20_000).nullable().optional(),
  reply_prompt: z.string().max(20_000).nullable().optional(),
  signature:    z.string().max(2_000).nullable().optional(),
  sender_name:  z.string().max(200).nullable().optional(),
  theme:        z.enum(THEME_IDS).nullable().optional(),
  theme_mode:   z.enum(THEME_MODES).nullable().optional(),
});

export type PatchUserSettings = z.infer<typeof PatchUserSettingsSchema>;
