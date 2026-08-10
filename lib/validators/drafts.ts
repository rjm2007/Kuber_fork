import { z } from "zod";
import { dbId } from "./id";

export const GenerateDraftsSchema = z.object({
  campaign_id: dbId,
  lead_ids: z.array(dbId).optional(),
  limit: z.number().int().min(1).max(200).default(25),
});

export const DraftsQuerySchema = z.object({
  campaign_id: dbId.optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PatchDraftSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), rejection_reason: z.string().min(1) }),
  z.object({ action: z.literal("edit"), subject: z.string().min(1), body: z.string().min(1) }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("restore") }),
]);

export const BulkApproveSchema = z.object({
  draft_ids: z.array(dbId).min(1).max(200),
});

export const RegenerateDraftSchema = z.object({
  custom_instruction: z.string().optional(),
});

// Bulk regeneration. Omitting campaign_lead_ids means "every eligible lead in
// this campaign" — the server resolves the target list either way, so the ids
// here only ever narrow it (see lib/services/regeneration-jobs.ts).
export const BulkRegenerateSchema = z.object({
  campaign_lead_ids: z.array(dbId).min(1).max(500).optional(),
  custom_instruction: z.string().max(4000).optional(),
  step_number: z.number().int().min(1).default(1),
});

export const ManualDraftSchema = z.object({
  campaign_lead_id: dbId,
  step_number: z.number().int().min(2),
  subject: z.string(),
  body: z.string().min(1),
});

export const FollowUpRegenerateSchema = z.object({
  campaign_lead_id: dbId,
  step_number: z.number().int().min(2),
  body: z.string(),
  instruction: z.string().optional(),
});

export const FollowUpStepTemplateRegenerateSchema = z.object({
  step_number: z.number().int().min(2),
  body: z.string(),
  instruction: z.string().optional(),
});

// Follow-up subject is intentionally allowed to be empty — it threads as a
// reply in the same conversation, unlike the step-1 draft's PatchDraftSchema
// "edit" action, which requires a non-empty subject.
export const FollowUpSaveSchema = z.object({
  campaign_lead_id: dbId,
  step_number: z.number().int().min(2),
  subject: z.string(),
  body: z.string().min(1),
});
