import { NextRequest } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { ok, fail } from "@/lib/api-response";
import { dbId } from "@/lib/validators/id";
import { dbForUser } from "@/lib/supabase/scoped";

const Body = z.object({ label: z.string().trim().min(1, "Name cannot be empty").max(80, "Name is too long (80 max)") });

/** Rename a batch. Allowed for a manager (leads:all) or the person who created it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "leads:write"); } catch (r) { return r as Response; }

  const { id } = await params;
  if (!dbId.safeParse(id).success) return fail(400, "VALIDATION_ERROR", "Invalid batch id");
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request");

  const db = dbForUser(user);
  const { data: batch, error } = await db.from("imports").select("id, created_by").eq("id", id).maybeSingle();
  if (error) return fail(500, "INTERNAL", error.message);
  if (!batch) return fail(404, "NOT_FOUND", "Batch not found");
  if (!canSeeAll(user.member, "leads") && batch.created_by !== user.id) {
    return fail(403, "FORBIDDEN", "Only a manager or the person who created this batch can rename it");
  }

  const { data, error: upErr } = await db.from("imports").update({ label: parsed.data.label }).eq("id", id).select("id, label").single();
  if (upErr) return fail(500, "INTERNAL", upErr.message);
  return ok(data);
}
