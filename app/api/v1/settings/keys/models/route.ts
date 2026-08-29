import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PROVIDER_META } from "@/lib/services/providers/registry";
import { getActiveKey } from "@/lib/services/provider-keys";
import type { ProviderId } from "@/lib/services/providers/types";
import { dbForUser } from "@/lib/supabase/scoped";

export type ProviderModelOption = { id: string; name: string | null };

// OpenAI's /v1/models returns every model family (embeddings, TTS, image,
// moderation…). Only chat-completions models make sense as the app's LLM,
// so everything else is filtered out before it reaches the picker.
const OPENAI_NON_CHAT = /embedding|whisper|tts|dall-e|audio|realtime|moderation|transcribe|image|babbage|davinci|codex/i;

async function listOpenRouterModels(secret: string | null): Promise<ProviderModelOption[]> {
  // Public catalog endpoint — the key is optional but sent when present.
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json() as { data?: Array<{ id: string; name?: string }> };
  return (data.data ?? []).map((m) => ({ id: m.id, name: m.name ?? null }));
}

async function listOpenAiModels(secret: string): Promise<ProviderModelOption[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json() as { data?: Array<{ id: string }> };
  return (data.data ?? [])
    .filter((m) => !OPENAI_NON_CHAT.test(m.id))
    .map((m) => ({ id: m.id, name: null }));
}

async function listAnthropicModels(secret: string): Promise<ProviderModelOption[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
  return (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? null }));
}

/** GET /api/v1/settings/keys/models?provider=openrouter — live model catalog
 *  for the picker in Settings > Keys, fetched with the provider's configured
 *  key so the list always reflects what that key can actually use. Providers
 *  without a catalog integration return an empty list and the UI falls back
 *  to its static options / freeform input. */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const provider = req.nextUrl.searchParams.get("provider") as ProviderId | null;
  if (!provider || !(provider in PROVIDER_META)) {
    return fail(400, "INVALID_PROVIDER", `Unknown provider "${provider}"`);
  }
  if (PROVIDER_META[provider].category !== "llm") {
    return fail(400, "INVALID_PROVIDER", `${provider} has no model catalog`);
  }

  const db = dbForUser(user);
  const key = await getActiveKey(db, provider, user.companyId ?? "any");

  try {
    let models: ProviderModelOption[] = [];
    if (provider === "openrouter") {
      models = await listOpenRouterModels(key?.secret ?? null);
    } else if (provider === "openai") {
      if (!key) return fail(400, "NO_KEY", "Add an OpenAI key first to load its model list");
      models = await listOpenAiModels(key.secret);
    } else if (provider === "anthropic") {
      if (!key) return fail(400, "NO_KEY", "Add an Anthropic key first to load its model list");
      models = await listAnthropicModels(key.secret);
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return ok({ models });
  } catch (e) {
    return fail(502, "PROVIDER_ERROR", (e as Error).message);
  }
}
