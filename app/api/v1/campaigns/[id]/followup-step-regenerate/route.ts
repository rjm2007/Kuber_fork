import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { FollowUpStepTemplateRegenerateSchema } from "@/lib/validators/drafts";
import { regenerateFollowUpTemplateText } from "@/lib/services/followup-regenerate";

// Campaign-level follow-up template rewrite for the Sequences tab — no per-lead
// draft writes; the client saves via PUT .../steps when the user clicks Save.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  await params; // campaign id validated by auth + client context
  const body = await req.json().catch(() => null);
  const parsed = FollowUpStepTemplateRegenerateSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  try {
    const rewritten = await regenerateFollowUpTemplateText({
      currentBody: parsed.data.body,
      instruction: parsed.data.instruction ?? "Rewrite this follow-up.",
      companyId: user.companyId ?? "any",
    });
    return ok({ body: rewritten.body });
  } catch (e) {
    return fail(502, "GENERATION_FAILED", (e as Error).message);
  }
}
