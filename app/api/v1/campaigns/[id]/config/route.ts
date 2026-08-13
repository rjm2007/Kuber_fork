import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchCampaignSchema } from "@/lib/validators/campaigns";
import { patchInstantlyCampaignConfig } from "@/lib/services/instantly";
import { assertCampaignSettingsAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

// Each sub-campaign now costs a read plus a write instead of a blind write:
// campaign_schedule is replaced wholesale by Instantly, so the current one has
// to be read back before a single field can be changed without wiping the rest
// (see patchInstantlyCampaignConfig). A wide campaign can hold ~30 country
// buckets, so worst case is ~60 sequential calls. 120s matches the other
// multi-step Instantly routes in this app (send, bulk-delete) and leaves
// comfortable headroom; the default platform timeout would not.
export const maxDuration = 120;

// PATCH /api/v1/campaigns/[id]/config
// Edits campaign schedule/config on live campaigns and syncs to all Instantly
// sub-campaigns. Unlike the main PATCH /campaigns/[id] route this is not
// restricted to draft/processing status — schedule settings (daily limit, send
// window, days) are safe to change on active campaigns.
//
// A campaign is a shared container (spec §5) that can hold leads owned by
// several employees at once. These settings (sender identity, daily limit,
// sending window, send days) are campaign-wide, not per-lead-owner, so whoever
// edits them changes what every lead in the container sends under.
//
// Managers may always edit. An employee may edit only a campaign no other
// employee is part of — there, the only leads affected are their own. See
// EDGE_CASES.md §2.10.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchCampaignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  try { await assertCampaignSettingsAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: existing } = await db.from("campaigns").select("id").eq("id", id).maybeSingle();
  if (!existing) return fail(404, "NOT_FOUND", "Campaign not found");

  // Persist to DB
  const { error } = await db
    .from("campaigns")
    .update({ ...parsed.data, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  // Sync to all Instantly sub-campaigns (fire-and-forget per sub; collect errors)
  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("instantly_campaign_id")
    .eq("campaign_id", id)
    .not("instantly_campaign_id", "is", null);

  // Daily limit, window and send days are genuinely campaign-wide and belong on
  // every sub-campaign. Timezone deliberately does NOT travel down: each
  // sub-campaign holds its own recipient-country timezone, computed at fan-out
  // (campaign-fanout.ts pickTimezone), and holding a distinct one is the only
  // reason these sub-campaigns exist. campaigns.schedule_timezone is just the
  // fallback used for leads whose country can't be resolved — propagating it
  // here overwrote India/Germany/Australia with the master's zone on every save.
  // See docs/campaign-timezone-rca.md.
  const syncErrors: string[] = [];
  for (const sub of subs ?? []) {
    if (!sub.instantly_campaign_id) continue;
    try {
      await patchInstantlyCampaignConfig(sub.instantly_campaign_id, {
        name:       parsed.data.name,
        dailyLimit: parsed.data.daily_limit,
        windowFrom: parsed.data.window_from,
        windowTo:   parsed.data.window_to,
        sendDays:   parsed.data.send_days,
      });
    } catch (e) {
      syncErrors.push((e as Error).message);
    }
  }

  return ok({ updated: true, sync_errors: syncErrors });
}
