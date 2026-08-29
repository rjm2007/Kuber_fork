import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok } from "@/lib/api-response";
import {
  checkOpenRouterCredits, checkOpenAICredits, checkAnthropicCredits,
  type CreditCheckOptions,
} from "@/lib/services/provider-credits";
import type { CreditCheck } from "@/lib/services/providers/types";
import { PROVIDER_META, getLlmTierRoles } from "@/lib/services/providers/registry";
import type { ProviderId } from "@/lib/services/providers/types";
import { dbForUser } from "@/lib/supabase/scoped";

// Same set Settings > Keys > Credentials manages — the deep-fallback tiers
// (Gemini/Mistral/Groq) stay out of the UI same as they do there.
const VISIBLE_LLM_PROVIDERS: ProviderId[] = ["openrouter", "openai", "anthropic"];

const CHECKERS: Partial<Record<ProviderId, (db: ReturnType<typeof dbForUser>, scope: string, opts?: CreditCheckOptions) => Promise<CreditCheck>>> = {
  openrouter: checkOpenRouterCredits,
  openai: checkOpenAICredits,
  anthropic: checkAnthropicCredits,
};

const VOLUME_CHART_DAYS = 14;

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** LLM provider validity/balance + draft generation volume for Settings >
 *  Keys > Usage > AI. There is no per-call token/cost log today (see
 *  lib/services/llm.ts — complete() has no usage-tracking hook), so "volume"
 *  is counted from what the app actually produced: rows in email_drafts and
 *  reply_drafts, which is a true count of generations, not tokens/cost. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const bypassCache = new URL(req.url).searchParams.get("refresh") === "1";
  const db = dbForUser(user);
  const since = new Date(Date.now() - VOLUME_CHART_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [providers, tierRoles, draftRows, replyRows] = await Promise.all([
    Promise.all(
      VISIBLE_LLM_PROVIDERS.map(async (id) => {
        const meta = PROVIDER_META[id];
        const checker = CHECKERS[id];
        const result = checker
          ? await checker(db, user.companyId ?? "any", { fresh: bypassCache })
          : { ok: false, remaining: null, message: `No credit check wired up for ${id}` };
        return { id, label: meta.label, ok: result.ok, remaining: result.remaining, message: result.message };
      }),
    ),
    getLlmTierRoles(db),
    db.from("email_drafts").select("created_at").gte("created_at", since),
    db.from("reply_drafts").select("created_at").gte("created_at", since),
  ]);

  const dailyMap = new Map<string, { drafts: number; replies: number }>();
  for (const row of draftRows.data ?? []) {
    const key = dayKey(row.created_at as string);
    const entry = dailyMap.get(key) ?? { drafts: 0, replies: 0 };
    entry.drafts += 1;
    dailyMap.set(key, entry);
  }
  for (const row of replyRows.data ?? []) {
    const key = dayKey(row.created_at as string);
    const entry = dailyMap.get(key) ?? { drafts: 0, replies: 0 };
    entry.replies += 1;
    dailyMap.set(key, entry);
  }

  const now = new Date();
  const daily: { date: string; drafts: number; replies: number }[] = [];
  for (let i = VOLUME_CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const entry = dailyMap.get(key) ?? { drafts: 0, replies: 0 };
    daily.push({ date: key, ...entry });
  }

  const totalDrafts = draftRows.data?.length ?? 0;
  const totalReplies = replyRows.data?.length ?? 0;

  return ok({
    providers,
    tierRoles,
    volume: {
      windowDays: VOLUME_CHART_DAYS,
      totalDrafts,
      totalReplies,
      totalGenerations: totalDrafts + totalReplies,
      daily,
    },
  });
}
