import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { writeDueFollowups } from "@/lib/services/write-followups";

export const maxDuration = 55;

/**
 * Writes the personalised follow-ups that fall due within the next day, and
 * pushes each to Instantly.
 *
 * Scheduled daily rather than every few minutes: a follow-up's due date moves in
 * days, so a tighter cadence would only re-ask the same question. The 10-minute
 * enrichment-watchdog calls this too, which is the safety net — see §10.5 of
 * docs/system-architecture.md.
 *
 * SAFE TO RUN TWICE. The sweep skips any (lead, step) that already has a draft,
 * so a double fire, a retry, or an overlap with the watchdog writes nothing a
 * second time and cannot double-spend tokens.
 *
 * SELF-HEALING. It asks "due within a day and not yet written", not "due
 * today". A missed day is picked up by the next run, including anything already
 * overdue, so a failed schedule delays follow-ups rather than losing them.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }

  const body = await req.json().catch(() => ({})) as { limit?: number; company_id?: string };

  const guard = guardUnscoped(body.company_id);
  if (guard) return guard;

  const result = await writeDueFollowups(createAdminClient(), {
    limit: body.limit,
    companyId: body.company_id,
  });

  // ranOutOfTime means the batch hit its time budget with work still waiting.
  // The caller (or the next scheduled run) simply calls again; there is no
  // self-chain here because nothing is time-critical to the minute.
  return ok(result);
}

/** GET for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`), same shape as
 *  reconcile-counters and enrichment-watchdog. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) {
    return fail(401, "UNAUTHORIZED", "Cron authorization required");
  }

  const companyId = req.nextUrl.searchParams.get("company_id") ?? undefined;
  const guard = guardUnscoped(companyId);
  if (guard) return guard;

  const result = await writeDueFollowups(createAdminClient(), { companyId });
  return ok(result);
}

/**
 * Refuses a company-wide sweep from anywhere that is not production.
 *
 * Local development points at the SAME Supabase and the SAME Instantly workspace
 * as production. An unscoped sweep on a developer machine therefore writes into
 * the client's live campaigns and pushes text to their real Instantly leads.
 * That is not hypothetical: on 25 Aug 2026 a local test of this very route wrote
 * 6 follow-ups into the client's APOLLO CAMPAIGN 2 and pushed all 6.
 *
 * Production (Vercel sets NODE_ENV=production) still sweeps every company, which
 * is what the daily cron needs. Everywhere else must name the tenant it means.
 * Deliberately a hard refusal rather than a warning: a warning in a log nobody
 * reads is what allowed the first incident.
 */
function guardUnscoped(companyId: string | undefined) {
  if (companyId) return null;
  if (process.env.NODE_ENV === "production") return null;
  return fail(
    400,
    "COMPANY_ID_REQUIRED",
    "Refusing an unscoped follow-up sweep outside production. Local runs share the "
      + "client's live database and Instantly workspace, so pass company_id to name the "
      + "tenant you mean (the dev company is 00000000-0000-0000-0000-00000000000a).",
  );
}
