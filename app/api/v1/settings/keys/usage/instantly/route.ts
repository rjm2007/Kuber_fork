import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { checkInstantlyCredits } from "@/lib/services/provider-credits";
import {
  listInstantlyAccounts,
  getCampaignAnalyticsOverview,
  getCampaignAnalyticsDaily,
  type InstantlyCampaignAnalyticsOverview,
  type InstantlyDailyAnalytics,
} from "@/lib/services/instantly";
import { dbForUser } from "@/lib/supabase/scoped";

const DAILY_CHART_DAYS = 14;

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Live sending accounts + campaign analytics for Settings > Keys > Usage >
 *  Instantly. Each external call is independent — a Growth-plan-only endpoint
 *  failing (e.g. analytics on a lower tier) must not blank out the accounts
 *  list next to it, so failures are caught per-call and surfaced individually. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);

  const now = new Date();
  const startDate = toDateOnly(new Date(now.getTime() - (DAILY_CHART_DAYS - 1) * 24 * 60 * 60 * 1000));
  const endDate = toDateOnly(now);

  const [keyCheck, accountsRes, overviewRes, dailyRes] = await Promise.all([
    checkInstantlyCredits(db, "any" /* one shared Instantly workspace */, { fresh: bypassCache }),
    listInstantlyAccounts().then(
      (items) => ({ data: items, error: null as string | null }),
      (err: Error) => ({ data: null, error: err.message }),
    ),
    getCampaignAnalyticsOverview().then(
      (data): { data: InstantlyCampaignAnalyticsOverview | null; error: string | null } => ({ data, error: null }),
      (err: Error) => ({ data: null, error: err.message }),
    ),
    getCampaignAnalyticsDaily({ startDate, endDate }).then(
      (data): { data: InstantlyDailyAnalytics[] | null; error: string | null } => ({ data, error: null }),
      (err: Error) => ({ data: null, error: err.message }),
    ),
  ]);

  const accounts = accountsRes.data ?? [];

  return ok({
    key: keyCheck,
    accounts: {
      data: accountsRes.data ? accounts.map((a) => ({
        email: a.email,
        status: a.status,
        daily_limit: a.daily_limit ?? null,
        first_name: a.first_name ?? null,
        last_name: a.last_name ?? null,
      })) : null,
      error: accountsRes.error,
      totalDailyCapacity: accounts.reduce((sum, a) => sum + (a.daily_limit ?? 0), 0),
      activeCount: accounts.filter((a) => a.status === 1).length,
      totalCount: accounts.length,
    },
    overview: overviewRes,
    daily: dailyRes,
  });
}
