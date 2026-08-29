import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderId } from "@/lib/services/providers/types";
import { SERVICE_PROVIDER_IDS } from "@/lib/services/providers/registry";
import { isOutOfCredits } from "@/lib/services/provider-errors";

type Db = SupabaseClient;

// Every provider's static .env.local fallback — the permanent last-resort
// tier, not just a migration bridge. With zero rows in provider_keys, every
// getActiveKey() call resolves here, so this system is a no-op on day one.
export const ENV_KEY_VARS: Record<ProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  apollo: "APOLLO_API_KEY",
  instantly: "INSTANTLY_API_KEY",
};

const ENV_MODEL_PRIMARY = "LLM_PRIMARY_MODEL"; // openrouter only, legacy name
const ENV_MODEL_FALLBACK = "LLM_FALLBACK_MODEL"; // openai only, legacy name

export type KeySource = "db" | "env";
export interface ResolvedKey {
  source: KeySource;
  keyId: string | null;
  secret: string;
}

/**
 * Whose keys to consider.
 *
 * `"any"` means "deliberately cross-tenant" and must be spelled out at the call
 * site. It exists for the integrations where one account genuinely IS shared —
 * Apollo and Instantly are a single workspace serving every company — so that
 * sharing reads as a decision in the code rather than an oversight.
 */
export type KeyScope = string | "any";

/** Rows healthy right now, or cooling-off with an expired cooldown, ordered
 *  cheapest-to-try first. `exclude` lets a rotation loop skip keys it has
 *  already tried within the same request.
 *
 *  `scope` is REQUIRED, and that is the whole point. This function used to take
 *  only `db` and trust it to be a company-scoped client. Every LLM path called
 *  it with the admin client instead, which bypasses RLS — and provider_keys has
 *  RLS on with zero policies, so the database could not catch it either. The
 *  query therefore returned BOTH companies' keys and picked whichever sorted
 *  first by priority.
 *
 *  Measured live on 2026-08-29, before this filter existed:
 *
 *    openai    -> candidates: CLIENT, DEV  -> winner CLIENT "Backup"
 *    apollo    -> candidates: DEV, CLIENT  -> winner DEV "KEY-1"
 *    firecrawl -> candidates: DEV, CLIENT  -> winner DEV "KEY-1"
 *
 *  i.e. dev's AI work was billed to the client's OpenAI key, and the client's
 *  scraping ran on dev's Firecrawl key. Passing the scope explicitly makes the
 *  filter impossible to forget: a caller that wants cross-tenant has to say so. */
export async function getActiveKey(
  db: Db,
  provider: ProviderId,
  scope: KeyScope,
  opts?: { exclude?: Set<string> },
): Promise<ResolvedKey | null> {
  const exclude = opts?.exclude ?? new Set<string>();
  const nowIso = new Date().toISOString();

  let query = db
    .from("provider_keys")
    .select("id, secret_vault_id")
    .eq("provider", provider)
    .eq("is_active", true)
    .or(`status.eq.healthy,and(status.eq.cooling_off,cooling_off_until.lte.${nowIso})`);

  // Belt and braces: the filter is applied here even when the caller also hands
  // us a scoped client, because the scoped proxy is exactly what the LLM paths
  // were failing to use.
  if (scope !== "any") query = query.eq("company_id", scope);

  const { data: rows } = await query
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  const candidate = (rows ?? []).find((r) => !exclude.has(r.id as string));

  if (candidate) {
    const { data: secret } = await db.rpc("provider_key_read_secret", { p_vault_id: candidate.secret_vault_id });
    if (typeof secret === "string" && secret) {
      return { source: "db", keyId: candidate.id as string, secret };
    }
    // Vault read failed unexpectedly (shouldn't happen for a row we just
    // selected) — fall through to the env tier rather than surface an
    // opaque failure.
  }

  const envSecret = process.env[ENV_KEY_VARS[provider]];
  if (envSecret?.trim()) return { source: "env", keyId: null, secret: envSecret };

  return null;
}

export async function getConfiguredModel(db: Db, provider: ProviderId): Promise<string | null> {
  // See getLlmTierRoles() — provider_settings is one row PER COMPANY per
  // provider now. Scoped callers match exactly one; the unscoped enrichment
  // relay would otherwise get a "multiple rows" error that this destructuring
  // swallows, silently dropping the admin's selected model.
  const { data } = await db
    .from("provider_settings")
    .select("selected_model")
    .eq("provider", provider)
    .order("company_id", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.selected_model ?? null;
}

/** DB selection > provider's legacy env var > hardcoded default. */
export async function resolveModel(
  db: Db,
  provider: ProviderId,
  hardcodedDefault: string,
): Promise<string> {
  const dbModel = await getConfiguredModel(db, provider);
  if (dbModel) return dbModel;
  const envVar = provider === "openrouter" ? ENV_MODEL_PRIMARY : provider === "openai" ? ENV_MODEL_FALLBACK : null;
  const envModel = envVar ? process.env[envVar] : undefined;
  return envModel || hardcodedDefault;
}

export async function markKeySucceeded(db: Db, keyId: string | null): Promise<void> {
  if (!keyId) return;
  await db.from("provider_keys").update({
    status: "healthy",
    cooling_off_until: null,
    last_used_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", keyId);
}

export interface KeyFailureInfo {
  status?: number;
  message: string;
}

/** Is there an LLM key worth trying for this company right now?
 *
 *  Reads the health already recorded on provider_keys rather than asking a
 *  provider for a balance — a balance check is itself an API call, and that
 *  habit is what made Apollo's usage impossible to account for. A
 *  process-level env key counts as usable, because getActiveKey falls back to
 *  it when every stored key is out.
 *
 *  Checked PER COMPANY: provider_keys is company-scoped, and one tenant's
 *  healthy key says nothing about another's. Pass an unscoped client — the
 *  company filter is explicit here. */
export async function hasUsableLlmKey(db: Db, companyId: string): Promise<boolean> {
  const envLlmKeyConfigured = (Object.entries(ENV_KEY_VARS) as [ProviderId, string][])
    .filter(([provider]) => !(SERVICE_PROVIDER_IDS as readonly string[]).includes(provider))
    .some(([, envVar]) => (process.env[envVar] ?? "").trim().length > 0);
  if (envLlmKeyConfigured) return true;

  const { data } = await db
    .from("provider_keys")
    .select("id")
    .eq("company_id", companyId)
    .not("provider", "in", `(${SERVICE_PROVIDER_IDS.join(",")})`)
    .eq("is_active", true)
    .or(`status.eq.healthy,and(status.eq.cooling_off,cooling_off_until.lte.${new Date().toISOString()})`)
    .limit(1);

  return (data ?? []).length > 0;
}

/** Only call this after fetchWithRetry has already exhausted its in-place
 *  retries against this exact key — 402 is non-retryable there, and 429
 *  retries in-place up to 3x before giving up, so by the time an error
 *  reaches here, retrying the same key again is not going to help. */
export async function markKeyFailed(db: Db, keyId: string | null, info: KeyFailureInfo): Promise<void> {
  if (!keyId) return;
  const now = Date.now();
  const updates: Record<string, unknown> = {
    last_error: info.message.slice(0, 500),
    last_error_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };

  if (info.status === 401 || info.status === 403) {
    // Bad credential — no amount of waiting fixes it. Stays dead until an
    // admin fixes it or re-checks it via the UI.
    updates.status = "dead";
    updates.cooling_off_until = null;
  } else if (isOutOfCredits(info.message)) {
    // An empty balance does not refill on a timer, so cooling off is the wrong
    // response to it: the cooldown expired, getActiveKey handed the same dry
    // key straight back out, and the next batch of leads burned their retries
    // on it. That loop capped 20 of the 100 leads in ANKIT's APOLLO CAMPAIGN 1
    // on 7 Aug 2026 — permanently skipped for a reason that had nothing to do
    // with them. Dead until a human tops up and hits Re-check, which sets the
    // row back to healthy (settings/keys/[id]/check).
    updates.status = "dead";
    updates.cooling_off_until = null;
  } else if (info.status === 402) {
    updates.status = "cooling_off";
    updates.cooling_off_until = new Date(now + 30 * 60 * 1000).toISOString();
  } else if (info.status === 429) {
    updates.status = "cooling_off";
    updates.cooling_off_until = new Date(now + 5 * 60 * 1000).toISOString();
  }
  // else (5xx, network): record last_error only, don't touch status — not
  // attributable to this specific key; rotating within the same provider
  // won't help a provider-wide outage.

  await db.from("provider_keys").update(updates).eq("id", keyId);
}
