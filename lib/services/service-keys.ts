// Key resolution for the "service" providers — Apollo, Instantly, Firecrawl.
//
// LLM providers rotate: complete() walks a tier order and retries the next key
// when one fails. Service providers can't do that — Apollo is not substitutable
// for Instantly — so there is no loop here. The first healthy key wins, and
// .env.local stays the last-resort tier exactly as it does for LLM keys, which
// means this file is a no-op until someone actually adds a key in the UI.
//
// Deliberately uncached, matching lib/services/settings.ts: a module-level
// cache on serverless produces "I changed the key but it didn't apply" bugs
// when a stale instance serves the request, and these are single-row indexed
// reads sitting next to multi-hundred-ms third-party HTTP calls.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveKey, type KeyScope } from "@/lib/services/provider-keys";
import { createScopedClient } from "@/lib/supabase/scoped";
import type { ServiceProviderId } from "@/lib/services/providers/registry";

/** Key in the shared `settings` table holding the selected Instantly sender.
 *  Older deployments may still contain a comma-separated pool; the Email &
 *  Sending settings page requires choosing one before replacing that value. */
export const SENDING_ACCOUNTS_SETTING_KEY = "instantly_sending_accounts";

function parseEmailList(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** DB setting first, INSTANTLY_SENDING_ACCOUNTS as the fallback tier. */
export async function getSendingAccounts(db: SupabaseClient): Promise<string[]> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", SENDING_ACCOUNTS_SETTING_KEY)
    .maybeSingle();

  const fromDb = parseEmailList(data?.value);
  return fromDb.length > 0 ? fromDb : parseEmailList(process.env.INSTANTLY_SENDING_ACCOUNTS);
}

/** Resolves to the DB key if one is configured, else the .env.local value,
 *  else null when the integration has no credential at all. */
export async function getServiceSecret(
  provider: ServiceProviderId,
  scope: KeyScope,
): Promise<string | null> {
  const db = scope === "any" ? createAdminClient() : createScopedClient(scope);
  const resolved = await getActiveKey(db, provider, scope);
  return resolved?.secret ?? null;
}

/** Same, but throws the message the caller would otherwise have to write.
 *  Use at the top of any function that cannot proceed without the key. */
export async function requireServiceSecret(
  provider: ServiceProviderId,
  label: string,
  scope: KeyScope,
): Promise<string> {
  const secret = await getServiceSecret(provider, scope);
  if (!secret) {
    throw new Error(`${label} API key not configured — add one in Settings > Keys`);
  }
  return secret;
}
