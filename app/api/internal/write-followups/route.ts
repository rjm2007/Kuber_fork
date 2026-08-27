import { NextRequest, after } from "next/server";
import { internalAppBaseUrl } from "@/lib/internal-url";
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

  chainIfMoreWork(req, result, body.company_id, body.limit);
  return ok(result);
}

/**
 * Kick off the next batch when this one stopped with work still waiting.
 *
 * Without this, the only thing that started another batch was the 10-minute
 * watchdog — so a batch of ~6 drafts was followed by a ten-minute nap, and
 * throughput sat at ~35/hour. The opening-email generator has chained like this
 * since the day it was written and runs ~480/hour on the same hardware; the gap
 * was never the work per batch, it was the wait between batches. Measured on
 * 27 Aug 2026, when a 355-draft backlog was going to take ten hours.
 *
 * It also makes the writer self-healing on its own. Previously a run that died
 * mid-batch was only picked up by the watchdog, which means follow-ups quietly
 * depended on an unrelated job staying enabled — and when that job was paused,
 * nothing restarted them at all.
 *
 * after() keeps the lambda alive until the next request has actually left the
 * machine, exactly as generate-drafts does, so the chain cannot be cut short by
 * the response being returned first.
 */
function chainIfMoreWork(
  req: NextRequest,
  result: { found: number; written: number; failed: number; ranOutOfTime: boolean },
  companyId: string | undefined,
  limit: number | undefined,
) {
  // Nothing was written but something failed: the LLM is out of credit, the key
  // is unhealthy, or the leads are unusable. Those failures return fast, so
  // chaining would spin as quickly as the network allows and achieve nothing.
  // Stop and let the next scheduled run try again once the cause is fixed.
  if (result.written === 0) return;

  // A batch that neither ran out of time nor filled its quota has drained the
  // queue — there is nothing left to chain for.
  const filledTheBatch = result.found >= (limit ?? 50);
  if (!result.ranOutOfTime && !filledTheBatch) return;

  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return;
  const baseUrl = internalAppBaseUrl(req);

  after(async () => {
    await fetch(`${baseUrl}/api/internal/write-followups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": secret },
      // company_id is carried through so a scoped run stays scoped for the
      // whole chain — a chain that silently widened to every tenant is exactly
      // the incident guardUnscoped exists to prevent.
      body: JSON.stringify({ ...(companyId ? { company_id: companyId } : {}), ...(limit ? { limit } : {}) }),
    }).catch(() => {});
  });
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
  chainIfMoreWork(req, result, companyId, undefined);
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
