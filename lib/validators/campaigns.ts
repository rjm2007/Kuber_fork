import { z } from "zod";
import { dbId } from "./id";

export const CreateCampaignSchema = z.object({
  name: z.string().min(1),
  human_in_loop: z.boolean().default(true),
  send_mode: z.enum(["now", "scheduled"]).default("now"),
  schedule_start_at: z.string().datetime().optional(),
  window_from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  window_to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  send_days: z.record(z.string(), z.boolean()).optional(),
  schedule_timezone: z.string().optional(),
  daily_limit: z.number().int().min(1).max(500).default(30),
  ai_prompt_context: z.string().optional(),
  sender_name: z.string().optional(),
  // Each entry is the wait AFTER the previous email before this follow-up sends
  // (mirrors Instantly's own per-step delay/delay_unit semantics directly).
  followup_steps: z.array(z.object({
    delay: z.number().int().min(1).max(365),
    delay_unit: z.enum(["minutes", "hours", "days"]).default("days"),
  })).optional(),

  // Campaign attachment fields (set by upload endpoint)
  attachment_path: z.string().optional(),
  attachment_name: z.string().optional(),
  attachment_mime: z.string().optional(),
  attachment_size: z.number().int().optional(),
  attachment_url:  z.string().optional().nullable(),
  // Per-admin signature
  signature_user_id: dbId.optional(),
});

export const PatchCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  human_in_loop: z.boolean().optional(),
  send_mode: z.enum(["now", "scheduled"]).optional(),
  schedule_start_at: z.string().datetime().optional(),
  window_from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  window_to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  send_days: z.record(z.string(), z.boolean()).optional(),
  schedule_timezone: z.string().optional(),
  daily_limit: z.number().int().min(1).max(500).optional(),
  sender_name: z.string().optional(),
  ai_prompt_context: z.string().optional(),
});

export const AddLeadsToCampaignSchema = z.object({
  lead_ids: z.array(dbId).min(1),
});

export const CampaignLeadsQuerySchema = z.object({
  crm_status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PatchCampaignLeadSchema = z.object({
  campaign_lead_id: dbId,
  crm_status: z.enum([
    "new", "enriched", "draft", "approved", "sent", "replied", "won", "closed", "failed", "skipped",
  ]),
});

// Replacing a bounced contact. `first_name` is required and doubles as the desk
// label for a shared inbox ("Sales Team") — the drafter greets off first_name,
// so leaving it blank is what produces "Dear Sir/Ma'am". Everything else about
// the new lead (company, country, owner) is inherited from the bounced one.
export const ReplaceBouncedLeadSchema = z.object({
  email: z.string().email(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().max(80).optional(),
  title: z.string().trim().max(120).optional(),
});

export const CampaignStepInput = z.object({
  step_order: z.number().int().min(1),
  delay: z.number().int().min(0),
  delay_unit: z.enum(["minutes", "hours", "days"]).default("days"),
  subject: z.string().default(""),
  body: z.string().default(""),
  /** Extra guidance for this step only, on top of the campaign-wide one.
   *  Capped because it rides into the prompt — a long instruction crowds out
   *  the company research the follow-up is supposed to be built from. */
  ai_instruction: z.string().trim().max(1000).nullable().optional(),
  /** Per-step follow-up text for when the email cannot be personalised.
   *  Empty/null means inherit the Settings default — see
   *  lib/services/followup-template.ts. */
  fallback_body: z.string().trim().max(2000).nullable().optional(),
});

export const CampaignStepsSchema = z.object({
  steps: z.array(CampaignStepInput).min(1).max(10),
  /** Applied to every follow-up in the campaign. */
  followup_instruction: z.string().trim().max(1000).nullable().optional(),
});

export const SendCampaignSchema = z.object({
  campaign_lead_ids: z.array(dbId).min(1).optional(),
});
