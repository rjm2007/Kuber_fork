import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { findSequenceDrift, logSequenceDrift } from "@/lib/services/sequence-drift";

export const maxDuration = 55;

/**
 * Daily check that Instantly's copy of each sequence still matches ours.
 *
 * Read-only against Instantly, and it changes nothing on either side — it only
 * reports. Correcting a drift means deciding WHICH side is right, and that is a
 * judgement call: the fix for the drift found on 27 Aug 2026 was to change our
 * numbers, not Instantly's, because ours were the ones entered wrongly. An
 * auto-repair here would have confidently pushed the wrong values to 96 live
 * campaigns.
 *
 * Daily, not hourly: Instantly rate-limits hard, and a drift that has sat there
 * for weeks does not need catching within the hour — it needs catching at all.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }

  const body = await req.json().catch(() => ({})) as { company_id?: string };
  const db = createAdminClient();

  const report = await findSequenceDrift(db, { companyId: body.company_id });
  await logSequenceDrift(db, report.drifted);

  return ok(report);
}

/** GET for Vercel Cron / manual checks, same shape. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const cronToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authorized =
    safeSecretEqual(cronToken, process.env.CRON_SECRET) ||
    safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET);
  if (!authorized) return fail(401, "UNAUTHORIZED", "Cron authorization required");

  const db = createAdminClient();
  const report = await findSequenceDrift(db, {
    companyId: req.nextUrl.searchParams.get("company_id") ?? undefined,
  });
  await logSequenceDrift(db, report.drifted);
  return ok(report);
}
