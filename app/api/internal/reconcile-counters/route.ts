import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { runEnrichmentWatchdog } from "@/lib/services/enrichment-watchdog";

export const maxDuration = 120;

type Db = ReturnType<typeof createAdminClient>;

// Denormalised campaign counters are incremented by scattered webhook code and
// drift over time (planning.md Phase 6.6). This recomputes them from ground
// truth. Runs daily via Vercel Cron; safe to run any time (idempotent).
async function reconcile(db: Db) {
  const { data: campaigns } = await db
    .from("campaigns")
    .select("id, total_leads, sent_count, replied_count, bounced_count, hot_count, cold_count")
    .eq("is_deleted", false);

  let updated = 0;
  for (const c of campaigns ?? []) {
    const { data: cls } = await db
      .from("campaign_leads")
      .select("crm_status, first_sent_at, last_reply_at, lead_temperature")
      .eq("campaign_id", c.id);

    const rows = cls ?? [];
    const truth = {
      total_leads: rows.length,
      // Ground truth for "sent" is delivery (first_sent_at), NOT instantly_lead_id
      // — that only records that Instantly accepted the lead into the sequence,
      // which happens days before the mail actually goes out.
      sent_count: rows.filter((r) => r.first_sent_at != null).length,
      replied_count: rows.filter((r) => r.last_reply_at != null).length,
      // A 'failed' row WITHOUT first_sent_at is not a bounce — Instantly refused
      // the lead at add-time and nothing was ever sent.
      bounced_count: rows.filter((r) => r.crm_status === "failed" && r.first_sent_at != null).length,
      hot_count: rows.filter((r) => r.lead_temperature === "hot").length,
      cold_count: rows.filter((r) => r.lead_temperature === "cold").length,
    };

    const drifted =
      truth.total_leads !== (c.total_leads ?? 0) ||
      truth.sent_count !== (c.sent_count ?? 0) ||
      truth.replied_count !== (c.replied_count ?? 0) ||
      truth.bounced_count !== (c.bounced_count ?? 0) ||
      truth.hot_count !== (c.hot_count ?? 0) ||
      truth.cold_count !== (c.cold_count ?? 0);

    if (drifted) {
      await db.from("campaigns").update({ ...truth, updated_at: new Date().toISOString() }).eq("id", c.id);
      updated++;
    }
  }

  return { campaigns_checked: (campaigns ?? []).length, campaigns_corrected: updated };
}

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  const db = createAdminClient();
  const result = await reconcile(db);
  await runEnrichmentWatchdog(internalAppBaseUrl(req), db);
  return ok(result);
}

/** GET for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`). */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) {
    return fail(401, "UNAUTHORIZED", "Cron authorization required");
  }
  const db = createAdminClient();
  const result = await reconcile(db);
  await runEnrichmentWatchdog(internalAppBaseUrl(req), db);
  return ok(result);
}
