import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getUniboxScope } from "@/lib/auth/scope";
import { getThreads, type UniboxReadState, type UniboxTab } from "@/lib/services/unibox";
import { dbForUser } from "@/lib/supabase/scoped";

function parseInterest(raw: string | null): number | "lead" | undefined {
  if (!raw) return undefined;
  if (raw === "lead") return "lead";
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseReadState(raw: string | null): UniboxReadState | undefined {
  if (!raw || raw === "all") return undefined;
  const valid: UniboxReadState[] = ["unread", "read", "replied", "needs_reply", "no_reply"];
  return valid.includes(raw as UniboxReadState) ? (raw as UniboxReadState) : undefined;
}

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const sp = req.nextUrl.searchParams;
  const db = dbForUser(user);

  const campaignIdsRaw = sp.get("campaign_ids");
  const campaign_ids = campaignIdsRaw
    ? campaignIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const campaign_id: string | undefined = sp.get("campaign_id") ?? undefined;

  // Employees see ONLY threads of leads assigned to them (spec §7). The scope
  // is the security boundary; campaign_id(s) stay purely user-facing filters
  // intersected on top.
  const scope = getUniboxScope(user) ?? undefined;

  const tabRaw = sp.get("tab");
  const tab = tabRaw ? (tabRaw as UniboxTab) : undefined;

  // getThreads intentionally throws rather than swallowing a failed query
  // (see its own comment) — catch it here so that surfaces as a clean fail()
  // JSON body, not an unhandled exception. Next.js's default handling of an
  // unhandled route-handler exception does not reliably produce a JSON body
  // apiFetch can parse, which showed up client-side as a bare "Unexpected
  // end of JSON input" with no indication anything server-side had failed.
  try {
    const result = await getThreads(db, {
      tab,
      campaign_id,
      campaign_ids: campaign_ids?.length ? campaign_ids : undefined,
      eaccount: sp.get("eaccount") ?? undefined,
      q: sp.get("q") ?? undefined,
      unread_only: sp.get("unread_only") === "1",
      read_state: parseReadState(sp.get("status")),
      interest_status: parseInterest(sp.get("interest")),
      cursor: sp.get("cursor") ?? undefined,
      limit: sp.get("limit") ? Number(sp.get("limit")) : 30,
      // The Unibox is a mailbox: it shows every thread in scope, answered or not.
      include_unreplied: true,
      scope,
    });
    return ok(result);
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
