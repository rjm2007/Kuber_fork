import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchUserSettingsSchema } from "@/lib/validators/settings";
import {
  getReplyPrompts,
  getSignature,
  getSystemPrompt,
  getClientContext,
  getUserSettings,
} from "@/lib/services/settings";
import { dbForUser } from "@/lib/supabase/scoped";

const SERVICE_ROLE_USER_ID = "00000000-0000-0000-0000-000000000000";

type Db = SupabaseClient;

// Personal settings for the signed-in user (planning.md Phase 1). Every value
// is nullable — null means "inherit the company default". The response carries
// both the raw personal values and the resolved effective ones so the UI can
// show "Using company default" states without a second round-trip.
async function buildResponse(db: Db, userId: string, isSuperAdmin: boolean) {
  const [personal, globalPrompt, replyPrompts, signature, client] = await Promise.all([
    getUserSettings(db, userId),
    getSystemPrompt(db),
    getReplyPrompts(db),
    getSignature(db),
    getClientContext(db),
  ]);

  return {
    draft_prompt: personal?.draft_prompt ?? null,
    draft_template: personal?.draft_template ?? null,
    reply_prompt: personal?.reply_prompt ?? null,
    signature:    personal?.signature ?? null,
    sender_name:  personal?.sender_name ?? null,
    theme:        personal?.theme ?? null,
    theme_mode:   personal?.theme_mode ?? null,
    // Already resolved by requireAuth — no extra profile round-trip.
    is_super_admin: isSuperAdmin,
    defaults: {
      draft_prompt: globalPrompt,
      reply_prompt: replyPrompts.drafter,
      signature:    signature.contact,
      sender_name:  client.defaultSenderName,
    },
  };
}

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.id === SERVICE_ROLE_USER_ID) {
    return fail(400, "NO_PROFILE", "The service-role caller has no personal settings");
  }

  const db = dbForUser(user);
  return ok(await buildResponse(db, user.id, user.isSuperAdmin));
}

export async function PATCH(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.id === SERVICE_ROLE_USER_ID) {
    return fail(400, "NO_PROFILE", "The service-role caller has no personal settings");
  }

  const body = await req.json().catch(() => null);
  const parsed = PatchUserSettingsSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    // Empty strings mean "clear back to inherit", same as explicit null.
    patch[key] = typeof value === "string" && value.trim() === "" ? null : value;
  }

  const db = dbForUser(user);

  if (Object.keys(patch).length > 0) {
    const { error } = await db.from("user_settings").upsert(
      { user_id: user.id, ...patch },
      { onConflict: "user_id" },
    );
    if (error) return fail(500, "INTERNAL", error.message);
  }

  return ok(await buildResponse(db, user.id, user.isSuperAdmin));
}
