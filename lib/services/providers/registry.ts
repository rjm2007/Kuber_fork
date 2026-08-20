// The provider "factory": one lookup table mapping a provider id to how to
// call it, instead of hardcoded if/else branches in llm.ts. Adding a 7th
// provider later is one new PROVIDER_META entry + one small call function
// registered in PROVIDER_REGISTRY — nothing else in the app changes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithRetry } from "@/lib/http";
import type { CompletionOpts, ProviderCategory, ProviderId } from "@/lib/services/providers/types";

export interface ProviderMeta {
  id: ProviderId;
  category: ProviderCategory;
  label: string;
  modelInputMode: "dropdown" | "freeform" | "none";
  modelOptions?: string[];
  defaultModel?: string;
  /** Shown under the provider name in Settings > Keys, so an admin can tell
   *  what actually breaks if this key is missing. Service providers only —
   *  LLM providers are interchangeable and need no per-provider explanation. */
  description?: string;
}

// Model ID strings for Gemini/Mistral/Groq are pre-filled defaults, not
// verified against each provider's live catalog — all three are freeform
// fields precisely so an admin can override with the exact current model
// name rather than being locked to what's hardcoded here.
export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  openrouter: {
    id: "openrouter", category: "llm", label: "OpenRouter",
    modelInputMode: "freeform", defaultModel: "anthropic/claude-sonnet-4-6",
  },
  openai: {
    id: "openai", category: "llm", label: "OpenAI",
    modelInputMode: "dropdown",
    modelOptions: ["gpt-5.4-mini", "gpt-5-mini", "gpt-4o-mini", "gpt-4o"],
    defaultModel: "gpt-4o-mini",
  },
  anthropic: {
    id: "anthropic", category: "llm", label: "Claude (Anthropic direct)",
    modelInputMode: "dropdown",
    modelOptions: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-5",
  },
  gemini: {
    id: "gemini", category: "llm", label: "Google Gemini",
    modelInputMode: "freeform", defaultModel: "gemini-2.5-flash",
  },
  mistral: {
    id: "mistral", category: "llm", label: "Mistral",
    modelInputMode: "freeform", defaultModel: "mistral-small-latest",
  },
  groq: {
    id: "groq", category: "llm", label: "Groq",
    modelInputMode: "freeform", defaultModel: "llama-3.3-70b-versatile",
  },
  firecrawl: {
    id: "firecrawl", category: "service", label: "Firecrawl",
    modelInputMode: "none",
    description: "Scrapes company websites during enrichment.",
  },
  apollo: {
    id: "apollo", category: "service", label: "Apollo",
    modelInputMode: "none",
    description: "Lead search and contact enrichment.",
  },
  instantly: {
    id: "instantly", category: "service", label: "Instantly",
    modelInputMode: "none",
    description: "Sends campaign email and reports replies back.",
  },
};

export const SERVICE_PROVIDER_IDS = ["apollo", "instantly", "firecrawl"] as const;
export type ServiceProviderId = (typeof SERVICE_PROVIDER_IDS)[number];

export type LlmProviderId = Exclude<ProviderId, ServiceProviderId>;

// Baseline order when no admin override is set. Each tier is tried
// key-by-key (see provider-keys.ts) before falling through to the next
// provider.
export const DEFAULT_LLM_TIER_ORDER: LlmProviderId[] = ["openrouter", "openai", "anthropic", "gemini", "mistral", "groq"];

export interface LlmTierRoles {
  primary: LlmProviderId | null;
  fallback: LlmProviderId | null;
}

/** Reads the super-admin's Primary/Fallback picks (Settings > Keys). Both
 *  null on a fresh install — the seeded llm_tier_config row always exists
 *  (see migration), so this is a plain PK lookup, never an empty table. */
export async function getLlmTierRoles(db: SupabaseClient): Promise<LlmTierRoles> {
  // .limit(1) matters since the multi-tenant split: llm_tier_config now holds
  // one row PER COMPANY. A company-scoped client (every user-facing caller)
  // sees exactly one and this is a no-op. The enrichment relay's pre-flight
  // gate, though, calls this on the UNSCOPED client before it knows which
  // companies its batch spans — without the limit that returns a
  // "multiple rows" error, which this destructuring silently swallows, quietly
  // ignoring the admin's configured Primary/Fallback and falling back to the
  // hardcoded default order. Any company's row answers the pre-flight question
  // ("is some LLM provider usable at all") because the keys are shared.
  const { data } = await db
    .from("llm_tier_config")
    .select("primary_provider, fallback_provider")
    .order("company_id", { ascending: true })
    .limit(1)
    .maybeSingle();
  const primary = data?.primary_provider as LlmProviderId | undefined;
  const fallback = data?.fallback_provider as LlmProviderId | undefined;
  return {
    primary: primary && DEFAULT_LLM_TIER_ORDER.includes(primary) ? primary : null,
    fallback: fallback && DEFAULT_LLM_TIER_ORDER.includes(fallback) ? fallback : null,
  };
}

/** The actual order complete() tries providers in: Primary first (if set),
 *  Fallback second (if set and different), then every remaining provider in
 *  DEFAULT_LLM_TIER_ORDER's relative order. This only moves 0-2 providers to
 *  the front — it never drops a configured provider from the list, so a
 *  provider beyond the two explicit picks still serves as a tier-3+ backup. */
export async function resolveLlmTierOrder(db: SupabaseClient): Promise<LlmProviderId[]> {
  const { primary, fallback } = await getLlmTierRoles(db);
  const ordered: LlmProviderId[] = [];
  if (primary) ordered.push(primary);
  if (fallback && fallback !== primary) ordered.push(fallback);
  for (const p of DEFAULT_LLM_TIER_ORDER) {
    if (!ordered.includes(p)) ordered.push(p);
  }
  return ordered;
}

const DEFAULT_MAX_TOKENS = 2048;

// Drafting is a rule-following task, not a creative one: the same lead and the
// same instruction must produce the same email. Left unset, every provider
// defaults to ~1.0 (maximum randomness), which is what produced a 9/9-to-2/9
// spread in template adherence across one 20-lead batch on 19 Aug 2026.
// Low but not zero: 0 makes openings repeat verbatim across leads, which reads
// as a mass mailing to anyone who receives two of them.
const DEFAULT_TEMPERATURE = 0.2;

async function parseJsonResponse(text: string): Promise<object> {
  if (!text.trim()) throw new Error("Empty LLM response");
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    throw new Error(`No parseable JSON in LLM response: ${cleaned.slice(0, 120)}`);
  }
}

function extractOpenAIStyleContent(data: unknown): string {
  const choice = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: string }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

function throwHttpError(provider: string, status: number, body: string): never {
  throw Object.assign(new Error(`${provider} ${status}: ${body}`), { status });
}

// OpenRouter passes response_format through to any provider that supports it.
// The old check only matched OpenAI ids, so the configured primary model
// (anthropic/claude-sonnet-4-6) ran with no structured-output enforcement at
// all and relied purely on the prompt asking nicely for JSON.
function supportsJsonResponseFormat(model: string): boolean {
  return /^(openai|anthropic|google|mistralai|meta-llama)\//.test(model)
    || /gpt|o1|o3|o4|claude|gemini/i.test(model);
}

// ── OpenRouter ───────────────────────────────────────────────────────────
async function callOpenRouter(secret: string, model: string, opts: CompletionOpts): Promise<object> {
  const payload: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (supportsJsonResponseFormat(model)) payload.response_format = { type: "json_object" };

  const res = await fetchWithRetry("llm", "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      "X-Title": "Kuber Polyplast",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throwHttpError("OpenRouter", res.status, await res.text());
  return parseJsonResponse(extractOpenAIStyleContent(await res.json()));
}

// ── OpenAI-compatible (OpenAI itself, Mistral, Groq all share this shape) ──
async function callOpenAICompatible(baseUrl: string, providerLabel: string, secret: string, model: string, opts: CompletionOpts): Promise<object> {
  const res = await fetchWithRetry("llm", baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      model,
      // Newer OpenAI model families (o1/o3, gpt-5.x) reject the legacy
      // `max_tokens` field outright (HTTP 400) — confirmed live against
      // gpt-5.4-mini. `max_completion_tokens` works across old and new
      // chat-completions models on all three OpenAI-compatible providers.
      max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
  });
  if (!res.ok) throwHttpError(providerLabel, res.status, await res.text());
  return parseJsonResponse(extractOpenAIStyleContent(await res.json()));
}

const callOpenAI = (secret: string, model: string, opts: CompletionOpts) =>
  callOpenAICompatible("https://api.openai.com/v1/chat/completions", "OpenAI", secret, model, opts);
const callMistral = (secret: string, model: string, opts: CompletionOpts) =>
  callOpenAICompatible("https://api.mistral.ai/v1/chat/completions", "Mistral", secret, model, opts);
const callGroq = (secret: string, model: string, opts: CompletionOpts) =>
  callOpenAICompatible("https://api.groq.com/openai/v1/chat/completions", "Groq", secret, model, opts);

// ── Anthropic (direct Messages API — different auth + response shape) ─────
async function callAnthropic(secret: string, model: string, opts: CompletionOpts): Promise<object> {
  const res = await fetchWithRetry("llm", "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": secret,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!res.ok) throwHttpError("Anthropic", res.status, await res.text());
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return parseJsonResponse(text);
}

// ── Gemini (different request/response shape entirely) ────────────────────
async function callGemini(secret: string, model: string, opts: CompletionOpts): Promise<object> {
  const res = await fetchWithRetry(
    "llm",
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": secret },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: opts.user }] }],
        systemInstruction: { parts: [{ text: opts.system }] },
        generationConfig: {
          maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
          responseMimeType: "application/json",
        },
      }),
    },
  );
  if (!res.ok) throwHttpError("Gemini", res.status, await res.text());
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  return parseJsonResponse(text);
}

export type LlmCallFn = (secret: string, model: string, opts: CompletionOpts) => Promise<object>;

export const LLM_CALL_REGISTRY: Record<LlmProviderId, LlmCallFn> = {
  openrouter: callOpenRouter,
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
  mistral: callMistral,
  groq: callGroq,
};
