import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import { checkFirecrawlCredits } from "@/lib/services/provider-credits";
import { dbForUser } from "@/lib/supabase/scoped";

// Live balance comes from Firecrawl's /v2/team/credit-usage (same numbers as
// their dashboard). Separately, "activity" below is a ledger WE keep from
// every org scrape this app runs (enrichment_logs, source=firecrawl) — scrape
// counts, not credit totals, because scrape payloads don't currently persist
// creditsUsed.
type FirecrawlLedgerRow = {
  id: string;
  created_at: string;
  event: string;
  error: string | null;
  payload: Record<string, unknown> | null;
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function labelFor(row: FirecrawlLedgerRow): string {
  switch (row.event) {
    case "SCRAPE_SUCCESS": return "Scrape succeeded";
    case "SCRAPE_FAILED": return "Scrape failed";
    case "SCRAPE_EMPTY": return "Scrape empty";
    case "SCRAPE_CACHE_HIT": return "Cache hit (no credits)";
    default: return row.event;
  }
}

const LEDGER_LOOKBACK_DAYS = 90;
const DAILY_CHART_DAYS = 14;
const HISTORY_PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);

  const since = new Date(Date.now() - LEDGER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [keyCheck, ledgerRes] = await Promise.all([
    checkFirecrawlCredits(db, user.companyId ?? "any", { fresh: bypassCache }),
    db.from("enrichment_logs")
      .select("id, created_at, event, error, payload")
      .eq("source", "firecrawl")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  const rows = (ledgerRes.data ?? []) as FirecrawlLedgerRow[];

  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  let today = 0, week = 0, month = 0, allTime = 0;
  let success = 0, failed = 0, empty = 0, cacheHit = 0;
  const dailyMap = new Map<string, { scrapes: number; successes: number; failures: number }>();

  for (const row of rows) {
    // Cache hits don't hit Firecrawl — count them separately, not in "scrapes".
    const isLiveScrape = row.event !== "SCRAPE_CACHE_HIT";
    if (isLiveScrape) {
      allTime += 1;
      if (row.created_at >= startOfToday) today += 1;
      if (row.created_at >= startOfWeek) week += 1;
      if (row.created_at >= startOfMonth) month += 1;
    }

    if (row.event === "SCRAPE_SUCCESS") success += 1;
    else if (row.event === "SCRAPE_FAILED") failed += 1;
    else if (row.event === "SCRAPE_EMPTY") empty += 1;
    else if (row.event === "SCRAPE_CACHE_HIT") cacheHit += 1;

    const key = dayKey(row.created_at);
    const entry = dailyMap.get(key) ?? { scrapes: 0, successes: 0, failures: 0 };
    if (isLiveScrape) entry.scrapes += 1;
    if (row.event === "SCRAPE_SUCCESS") entry.successes += 1;
    if (row.event === "SCRAPE_FAILED" || row.event === "SCRAPE_EMPTY") entry.failures += 1;
    dailyMap.set(key, entry);
  }

  const daily: { date: string; scrapes: number; successes: number; failures: number }[] = [];
  for (let i = DAILY_CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    daily.push({ date: key, ...(dailyMap.get(key) ?? { scrapes: 0, successes: 0, failures: 0 }) });
  }

  const history = rows.slice(0, HISTORY_PAGE_SIZE).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    event: row.event,
    label: labelFor(row),
    domain: typeof row.payload?.domain === "string" ? row.payload.domain : null,
    chars: typeof row.payload?.chars === "number" ? row.payload.chars : null,
    message: row.error ?? null,
  }));

  const remaining = keyCheck.remaining;
  const planCredits = keyCheck.limit ?? null;
  const usedThisCycle =
    remaining != null && planCredits != null ? Math.max(0, planCredits - remaining) : null;

  return ok({
    key: keyCheck,
    credits: {
      remaining,
      planCredits,
      usedThisCycle,
      billingPeriodStart: keyCheck.billingPeriodStart ?? null,
      billingPeriodEnd: keyCheck.billingPeriodEnd ?? null,
    },
    activity: {
      today,
      week,
      month,
      allTime,
      success,
      failed,
      empty,
      cacheHit,
    },
    daily,
    history,
    ledgerWindowDays: LEDGER_LOOKBACK_DAYS,
  });
}
