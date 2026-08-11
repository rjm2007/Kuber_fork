import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CampaignStepsSchema } from "@/lib/validators/campaigns";
import { patchInstantlySequences, type InstantlyStep } from "@/lib/services/instantly";
import { assertCampaignAccess, assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }
  const { data } = await db
    .from("campaign_steps")
    .select("id,step_order,delay,delay_unit,subject,body")
    .eq("campaign_id", id)
    .order("step_order");
  return ok({ steps: data ?? [] });
}

// Sequence steps are campaign-wide templates that propagate live to every
// Instantly sub-campaign already sending, i.e. to every lead in this container
// (spec §5, EDGE_CASES.md §2.10). So: managers always, and an employee only on a
// campaign no other employee is part of, where the only leads they can affect
// are their own. GET above stays open to any employee with campaign access so
// they can still view the sequence content read-only.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const parsed = CampaignStepsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid steps", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  // Replace all steps for this campaign
  await db.from("campaign_steps").delete().eq("campaign_id", id);
  const { error } = await db.from("campaign_steps").insert(
    parsed.data.steps.map((s) => ({
      ...s,
      campaign_id: id,
      created_at: new Date().toISOString(),
    })),
  );
  if (error) return fail(500, "INTERNAL", error.message);

  // Propagate to any Instantly sub-campaigns already created
  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("instantly_campaign_id")
    .eq("campaign_id", id)
    .not("instantly_campaign_id", "is", null);

  const steps: InstantlyStep[] = parsed.data.steps.map((s) => ({
    subject: s.subject,
    body: s.body,
    delay: s.delay,
    delayUnit: s.delay_unit,
  }));

  for (const sub of subs ?? []) {
    if (sub.instantly_campaign_id) {
      await patchInstantlySequences(sub.instantly_campaign_id, steps).catch((e) => {
        console.error("patchInstantlySequences failed:", e);
        // don't fail the whole request if one sub-campaign patch fails
      });
    }
  }

  return ok({ updated: true });
}
