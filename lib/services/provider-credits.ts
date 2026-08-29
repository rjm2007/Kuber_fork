import type { SupabaseClient } from "@supabase/supabase-js";
import { type KeyScope, getActiveKey } from "@/lib/services/provider-keys";
import type { CreditCheck } from "@/lib/services/providers/types";
import type { ProviderId } from "@/lib/services/providers/types";

type Db = SupabaseClient;

export type { CreditCheck };

// Cache each provider's check for this long so an active scrape-orgs
// self-chain (which can fire every few seconds during a big batch) doesn't
// hit these credit APIs on every single invocation — one fresh check per
// window is plenty to catch "we just ran out."
const CACHE_TTL_MS = 5 * 60 * 1000;

// Below these, treat the provider as "not enough to bother trying" — not
// necessarily literal zero, since a request can still fail on a balance that
// technically isn't empty (Firecrawl charges whole credits per scrape;
// OpenRouter's error in practice appears well before the balance hits $0).
const FIRECRAWL_MIN_CREDITS = 5;
const OPENROUTER_MIN_BALANCE_USD = 0.10;
const APOLLO_MIN_CREDITS = 5;

// Cached in `system_state`, not `settings`: the provider keys are shared across
// companies, so the balance behind them is one global number — and this is
// called both from a scoped route (service-health) and from the unscoped
// enrichment relay, which cannot satisfy settings.company_id (NOT NULL).
/**
 * Cache key for one provider's balance, per company.
 *
 * system_state is a GLOBAL table keyed only by `key`, so every company shared
 * one row per provider: whichever company refreshed last decided what all the
 * others were shown. That was harmless while the keys themselves were shared,
 * and became wrong the moment provider_keys went per-company — the client could
 * be shown dev's Firecrawl balance and top up the wrong account.
 *
 * "any" keeps the old global row, which is right for the genuinely shared
 * accounts (Apollo, Instantly) and for unauthenticated callers.
 */
function cacheKeyFor(settingsKey: string, scope: KeyScope): string {
  return scope === "any" ? settingsKey : `${settingsKey}:${scope}`;
}

async function getCached(db: Db, key: string): Promise<CreditCheck | null> {
  const { data } = await db.from("system_state").select("value, updated_at").eq("key", key).maybeSingle();
  if (!data) return null;
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > CACHE_TTL_MS) return null;
  try { return JSON.parse(data.value) as CreditCheck; } catch { return null; }
}

async function setCached(db: Db, key: string, value: CreditCheck): Promise<void> {
  await db.from("system_state").upsert(
    { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}

async function fetchFirecrawlCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/team/credit-usage", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return { ok: true, remaining: null, message: `Credit check failed (HTTP ${res.status}) — proceeding rather than blocking on an unrelated API hiccup` };
    const json = await res.json() as {
      success?: boolean;
      data?: {
        remainingCredits?: number;
        planCredits?: number;
        billingPeriodStart?: string | null;
        billingPeriodEnd?: string | null;
      };
    };
    const remaining = json.data?.remainingCredits ?? null;
    const limit = json.data?.planCredits ?? null;
    const billingPeriodStart = json.data?.billingPeriodStart ?? null;
    const billingPeriodEnd = json.data?.billingPeriodEnd ?? null;
    if (remaining == null) return { ok: true, remaining: null, message: "Could not read Firecrawl balance — proceeding" };
    return {
      ok: remaining >= FIRECRAWL_MIN_CREDITS,
      remaining,
      limit,
      billingPeriodStart,
      billingPeriodEnd,
      message: remaining >= FIRECRAWL_MIN_CREDITS ? "OK" : `Firecrawl is out of credits (${remaining} left)`,
    };
  } catch {
    // Network hiccup on the check itself must not block real enrichment work.
    return { ok: true, remaining: null, message: "Credit check errored — proceeding" };
  }
}

async function fetchOpenRouterCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!res.ok) return { ok: true, remaining: null, message: `Credit check failed (HTTP ${res.status}) — proceeding rather than blocking on an unrelated API hiccup` };
    const json = await res.json() as { data?: { total_credits?: number; total_usage?: number } };
    if (json.data?.total_credits == null || json.data?.total_usage == null) {
      return { ok: true, remaining: null, message: "Could not read OpenRouter balance — proceeding" };
    }
    const remaining = json.data.total_credits - json.data.total_usage;
    return {
      ok: remaining >= OPENROUTER_MIN_BALANCE_USD,
      remaining,
      message: remaining >= OPENROUTER_MIN_BALANCE_USD ? "OK" : `OpenRouter is out of credits ($${remaining.toFixed(2)} left)`,
    };
  } catch {
    return { ok: true, remaining: null, message: "Credit check errored — proceeding" };
  }
}

// OpenAI (and Anthropic/Gemini/Mistral/Groq below) expose no "remaining
// balance" endpoint reachable with a regular API key — the best available
// signal is whether the key itself is live. A real mid-run quota failure
// from an actual completion call is caught separately and surfaces via
// /api/v1/service-health / provider_keys.status, same as the other
// providers' hard failures.
async function fetchOpenAICredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "OpenAI rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `OpenAI key check failed (HTTP ${res.status}) — proceeding rather than blocking on an unrelated API hiccup` };
    return { ok: true, remaining: null, message: "OpenAI key is valid (balance isn't exposed by this API — real quota failures surface when a call is actually made)" };
  } catch {
    return { ok: true, remaining: null, message: "OpenAI key check errored — proceeding" };
  }
}

async function fetchAnthropicCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "Anthropic rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `Anthropic key check failed (HTTP ${res.status}) — proceeding` };
    return { ok: true, remaining: null, message: "Anthropic key is valid (balance isn't exposed by this API)" };
  } catch {
    return { ok: true, remaining: null, message: "Anthropic key check errored — proceeding" };
  }
}

async function fetchGeminiCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(secret)}`);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "Gemini rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `Gemini key check failed (HTTP ${res.status}) — proceeding` };
    return { ok: true, remaining: null, message: "Gemini key is valid (balance isn't exposed by this API)" };
  } catch {
    return { ok: true, remaining: null, message: "Gemini key check errored — proceeding" };
  }
}

async function fetchMistralCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "Mistral rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `Mistral key check failed (HTTP ${res.status}) — proceeding` };
    return { ok: true, remaining: null, message: "Mistral key is valid (balance isn't exposed by this API)" };
  } catch {
    return { ok: true, remaining: null, message: "Mistral key check errored — proceeding" };
  }
}

async function fetchGroqCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${secret}` } });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "Groq rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `Groq key check failed (HTTP ${res.status}) — proceeding` };
    return { ok: true, remaining: null, message: "Groq key is valid (balance isn't exposed by this API)" };
  } catch {
    return { ok: true, remaining: null, message: "Groq key check errored — proceeding" };
  }
}

// Pull a numeric remaining/used/total triple out of a nested Apollo credit
// object without assuming one exact shape. Apollo's docs (Get Current User
// Profile, ?include_credit_usage=true) describe several credit categories
// (lead, direct_dial, export, ai, power_up) each nested under either a plain
// {remaining|used|total} shape or a per-scope {team|user}: {limit|consumed}
// shape depending on plan. Only reachable as a fallback now — see
// extractApolloRemaining for the shape this account actually returns.
function extractRemaining(node: unknown): number | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (typeof n.remaining === "number") return n.remaining;
  if (typeof n.total === "number" && typeof n.used === "number") return n.total - n.used;
  if (typeof n.limit === "number" && typeof n.consumed === "number") return n.limit - n.consumed;
  // Team/user scoped shape: prefer whichever scope is present.
  for (const scope of ["team", "user"]) {
    const scoped = extractRemaining(n[scope]);
    if (scoped != null) return scoped;
  }
  return null;
}

// api_profile returns a FLAT object, not the nested {credit_usage: {lead: …}}
// shape guessed above — live response confirmed 2026-08-01:
//
//   num_credits_remaining:      0     <- the spendable pool
//   effective_num_lead_credits: 4000  <- plan entitlement, NOT a balance
//   num_lead_credits_used:      0
//
// That distinction is the whole point of this function. On that live account
// the entitlement pair reads "4000 credits, none used" while every
// people/bulk_match call was answering 422 "insufficient credits", because the
// unified pool behind it was empty. num_credits_remaining is the only field
// that tracks what Apollo will actually let you spend, so it wins outright —
// subtracting the entitlement pair would report a healthy 4000 and re-create
// the exact silent stall this check exists to catch.
function extractApolloRemaining(data: Record<string, unknown>): number | null {
  const root = (data.data as Record<string, unknown> | undefined) ?? data;

  if (typeof root.num_credits_remaining === "number") return root.num_credits_remaining;

  // Plans that report through the nested credit_usage object instead.
  const creditUsage = (root.credit_usage ?? data.credit_usage) as Record<string, unknown> | undefined;
  const nested = extractRemaining(creditUsage?.lead_credits ?? creditUsage?.lead);
  if (nested != null) return nested;

  // Entitlement minus usage — last resort, only when no pool field exists at
  // all. Overstates the balance whenever the two are tracked separately (see
  // above), so it must stay below both branches, never above them.
  if (typeof root.effective_num_lead_credits === "number" && typeof root.num_lead_credits_used === "number") {
    return root.effective_num_lead_credits - root.num_lead_credits_used;
  }
  return null;
}

function extractApolloLimit(data: Record<string, unknown>): number | null {
  const root = (data.data as Record<string, unknown> | undefined) ?? data;
  if (typeof root.effective_num_lead_credits === "number") return root.effective_num_lead_credits;
  const creditUsage = (root.credit_usage ?? data.credit_usage) as Record<string, unknown> | undefined;
  const lead = (creditUsage?.lead_credits ?? creditUsage?.lead) as Record<string, unknown> | undefined;
  if (typeof lead?.limit === "number") return lead.limit;
  return null;
}

async function fetchApolloCredits(secret: string): Promise<CreditCheck> {
  try {
    const res = await fetch(
      "https://api.apollo.io/api/v1/users/api_profile?include_credit_usage=true",
      { headers: { "x-api-key": secret, accept: "application/json" } },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, limit: null, message: "Apollo rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, limit: null, message: `Apollo key check failed (HTTP ${res.status}) — proceeding` };

    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const remaining = extractApolloRemaining(data);
    const limit = extractApolloLimit(data);

    if (remaining == null) {
      return { ok: true, remaining: null, limit, message: "Apollo key is valid (couldn't read a credit balance from this response shape — check Settings > Keys > Re-check after Apollo's first real use to confirm parsing)" };
    }
    return {
      ok: remaining >= APOLLO_MIN_CREDITS,
      remaining,
      limit,
      message: remaining >= APOLLO_MIN_CREDITS ? "OK" : `Apollo is low on lead credits (${remaining} left)`,
    };
  } catch {
    return { ok: true, remaining: null, limit: null, message: "Apollo key check errored — proceeding" };
  }
}

async function fetchInstantlyCredits(secret: string): Promise<CreditCheck> {
  try {
    // /accounts is the cheapest authenticated GET — it also confirms the
    // workspace actually has sending accounts, which campaigns require.
    const res = await fetch("https://api.instantly.ai/api/v2/accounts?limit=1", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, remaining: null, message: "Instantly rejected the API key (401/403) — invalid key" };
    }
    if (!res.ok) return { ok: true, remaining: null, message: `Instantly key check failed (HTTP ${res.status}) — proceeding` };
    return { ok: true, remaining: null, message: "Instantly key is valid" };
  } catch {
    return { ok: true, remaining: null, message: "Instantly key check errored — proceeding" };
  }
}

const FETCHERS: Record<ProviderId, (secret: string) => Promise<CreditCheck>> = {
  firecrawl: fetchFirecrawlCredits,
  apollo: fetchApolloCredits,
  instantly: fetchInstantlyCredits,
  openrouter: fetchOpenRouterCredits,
  openai: fetchOpenAICredits,
  anthropic: fetchAnthropicCredits,
  gemini: fetchGeminiCredits,
  mistral: fetchMistralCredits,
  groq: fetchGroqCredits,
};

/** Cached, provider-specific credit check against the currently-ACTIVE key
 *  only (not every stored key) — this is a coarse pre-flight gate, and
 *  getActiveKey() is already called fresh (uncached) on every real request
 *  inside complete()/scrapePage(), so rotation freshness never depends on
 *  this 5-minute cache.
 *
 *  `fresh` skips the cache read (but still refreshes it) — used both for the
 *  case where a human just topped up and is retrying by hand (being told
 *  "out of credits" for another five minutes would read as the fix not
 *  having worked) and for the Settings > Keys > Usage refresh button, so the
 *  admin sees a live balance rather than a stale pre-flight snapshot.
 *  Automated callers (watchdogs, self-chains) should leave it off; they
 *  retry anyway. */
export interface CreditCheckOptions { fresh?: boolean }

async function checkCredits(
  db: Db,
  provider: ProviderId,
  settingsKey: string,
  scope: KeyScope,
  opts?: CreditCheckOptions,
): Promise<CreditCheck> {
  const cacheKey = cacheKeyFor(settingsKey, scope);
  const cached = opts?.fresh ? null : await getCached(db, cacheKey);
  if (cached) return cached;

  // "any": this reports a balance for the service-health banner and caches
  // it in the cross-tenant system_state row — it never selects the key that
  // gets SPENT (that is complete()/scrapePage()). Per-company balances are
  // a follow-up; showing a shared reading costs nobody money.
  const resolved = await getActiveKey(db, provider, scope);
  if (!resolved) {
    const fresh = { ok: false, remaining: null, message: `No usable ${provider} key configured` };
    await setCached(db, cacheKey, fresh);
    return fresh;
  }

  const fresh = await FETCHERS[provider](resolved.secret);
  await setCached(db, settingsKey, fresh);
  return fresh;
}

export const checkFirecrawlCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "firecrawl", "credit_check_firecrawl", scope, opts);
export const checkApolloCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "apollo", "credit_check_apollo", scope, opts);
export const checkInstantlyCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "instantly", "credit_check_instantly", scope, opts);
export const checkOpenRouterCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "openrouter", "credit_check_openrouter", scope, opts);
export const checkOpenAICredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "openai", "credit_check_openai", scope, opts);
export const checkAnthropicCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "anthropic", "credit_check_anthropic", scope, opts);
export const checkGeminiCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "gemini", "credit_check_gemini", scope, opts);
export const checkMistralCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "mistral", "credit_check_mistral", scope, opts);
export const checkGroqCredits = (db: Db, scope: KeyScope, opts?: CreditCheckOptions) => checkCredits(db, "groq", "credit_check_groq", scope, opts);

/** Used by the "Re-check" button on a specific stored key — bypasses the
 *  currently-active-key resolution and the 5-minute cache entirely, since
 *  the whole point is to test one specific key right now. */
export function checkSpecificKey(provider: ProviderId, secret: string): Promise<CreditCheck> {
  return FETCHERS[provider](secret);
}
