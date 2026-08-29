import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { getApiUsageStats, getCreditUsageStats, type ApolloEndpointUsage, type ApolloCreditUsageResponse } from "@/lib/services/apollo";
import { dbForUser } from "@/lib/supabase/scoped";

// credit_usage_stats gives the real, account-wide balance for the current
// billing cycle (same numbers as Apollo's own Settings > Usage page) —
// requires a Master API key, so it's fetched alongside the rate-limit
// snapshot and surfaced as an error rather than thrown if the key is scoped.
// Separately, "consumed"/"history" below is a ledger WE keep from every
// bulk_match call this app makes (enrichment_logs, source=apollo) — useful to
// see what THIS app specifically has spent, distinct from Apollo's full
// account total which may include other integrations/seats.
const ALLOWANCE_STATE_KEY = "apollo_credit_allowance_monthly";

type ApolloLedgerRow = {
  id: string;
  created_at: string;
  event: string;
  error: string | null;
  payload: Record<string, unknown> | null;
};

function creditsOf(row: ApolloLedgerRow): number {
  const v = row.payload?.credits_consumed;
  return typeof v === "number" ? v : 0;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD (UTC) — enrichment_logs.created_at is timestamptz
}

function labelFor(row: ApolloLedgerRow): string {
  switch (row.event) {
    case "CREDITS_CONSUMED": return "Enrichment batch";
    case "CREDITS_EXHAUSTED": return "Skipped — out of credits";
    case "EMAIL_REVEAL_FAILED": return "Email reveal failed";
    default: return row.event;
  }
}

// Lookback wide enough to cover "this month" even on the 1st, capped so one
// slow request can't scan the whole table's history.
const LEDGER_LOOKBACK_DAYS = 90;
const DAILY_CHART_DAYS = 14;
const HISTORY_PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);

  const since = new Date(Date.now() - LEDGER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [keyCheck, ledgerRes, allowanceRes, usageStatsRes, creditUsageRes] = await Promise.all([
    checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: bypassCache }),
    db.from("enrichment_logs")
      .select("id, created_at, event, error, payload")
      .eq("source", "apollo")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
    db.from("system_state").select("value").eq("key", ALLOWANCE_STATE_KEY).maybeSingle(),
    getApiUsageStats().then(
      (stats): { data: ApolloEndpointUsage[] | null; error: string | null } => ({ data: stats, error: null }),
      (err: Error) => ({ data: null, error: err.message }),
    ),
    getCreditUsageStats().then(
      (stats): { data: ApolloCreditUsageResponse | null; error: string | null } => ({ data: stats, error: null }),
      (err: Error) => ({ data: null, error: err.message }),
    ),
  ]);

  const rows = (ledgerRes.data ?? []) as ApolloLedgerRow[];

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  let today = 0, week = 0, month = 0, allTime = 0;
  const dailyMap = new Map<string, number>();
  for (const row of rows) {
    const credits = creditsOf(row);
    allTime += credits;
    if (row.created_at >= startOfToday) today += credits;
    if (row.created_at >= startOfWeek) week += credits;
    if (row.created_at >= startOfMonth) month += credits;
    const key = dayKey(row.created_at);
    dailyMap.set(key, (dailyMap.get(key) ?? 0) + credits);
  }

  const daily: { date: string; credits: number }[] = [];
  for (let i = DAILY_CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, credits: dailyMap.get(key) ?? 0 });
  }

  let allowanceMonthly: number | null = null;
  const rawAllowance = allowanceRes.data?.value;
  if (rawAllowance != null) {
    const n = Number(rawAllowance);
    if (Number.isFinite(n)) allowanceMonthly = n;
  }

  const history = rows.slice(0, HISTORY_PAGE_SIZE).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    event: row.event,
    label: labelFor(row),
    credits_consumed: creditsOf(row),
    matched: row.payload?.matched ?? null,
    archived: row.payload?.archived ?? null,
    verified: row.payload?.verified ?? null,
    unverified: row.payload?.unverified ?? null,
    requested: row.payload?.requested ?? null,
    import_id: row.payload?.import_id ?? null,
    campaign_id: row.payload?.campaign_id ?? null,
    message: row.error ?? null,
  }));

  return ok({
    key: keyCheck,
    allowanceMonthly,
    consumed: { today, week, month, allTime },
    remainingThisMonth: allowanceMonthly != null ? Math.max(0, allowanceMonthly - month) : null,
    daily,
    rateLimits: usageStatsRes.data,
    rateLimitsError: usageStatsRes.error,
    creditUsage: creditUsageRes.data?.credit_usage_stats ?? null,
    creditCycle: creditUsageRes.data?.current_credit_cycle ?? null,
    creditUsageError: creditUsageRes.error,
    history,
    ledgerWindowDays: LEDGER_LOOKBACK_DAYS,
  });
}

/** Sets (or clears with null) the monthly credit budget an admin tracks
 *  outside Apollo — the only way "remaining" can be shown at all, since
 *  Apollo's API has no balance endpoint. Shared across companies, same as the
 *  credit-check cache: the Apollo key behind it is one workspace-wide key. */
export async function PATCH(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null) as { allowanceMonthly?: number | null } | null;
  if (!body || !("allowanceMonthly" in body)) return fail(400, "VALIDATION_ERROR", "allowanceMonthly is required (number or null)");
  if (body.allowanceMonthly != null && (typeof body.allowanceMonthly !== "number" || body.allowanceMonthly < 0)) {
    return fail(400, "VALIDATION_ERROR", "allowanceMonthly must be a non-negative number or null");
  }

  const db = dbForUser(user);
  if (body.allowanceMonthly == null) {
    await db.from("system_state").delete().eq("key", ALLOWANCE_STATE_KEY);
  } else {
    await db.from("system_state").upsert(
      { key: ALLOWANCE_STATE_KEY, value: String(body.allowanceMonthly), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  }

  return ok({ allowanceMonthly: body.allowanceMonthly });
}
