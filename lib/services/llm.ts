import type { SupabaseClient } from "@supabase/supabase-js";
import { createScopedClient } from "@/lib/supabase/scoped";
import { getActiveKey, markKeyFailed, markKeySucceeded, resolveModel } from "@/lib/services/provider-keys";
import { LLM_CALL_REGISTRY, PROVIDER_META, resolveLlmTierOrder, type LlmProviderId } from "@/lib/services/providers/registry";
import type { CompletionOpts } from "@/lib/services/providers/types";

export type { CompletionOpts };

export interface LlmResult<T> {
  json: T;
  tier: number; // position (1-indexed) in the resolved tier order of the provider that served this
}

/** Exhausts every configured key for one provider (priority order, via
 *  provider-keys.ts) before giving up on that provider entirely. Only
 *  returns null when the provider has no usable key at all (no DB row and
 *  no env fallback) — that's "skip this tier," not a failure to report. */
async function tryProvider<T>(db: SupabaseClient, companyId: string, provider: LlmProviderId, opts: CompletionOpts): Promise<T | null> {
  const call = LLM_CALL_REGISTRY[provider];
  const meta = PROVIDER_META[provider];
  const tried = new Set<string>();
  let lastErr: Error | null = null;

  for (;;) {
    const resolved = await getActiveKey(db, provider, companyId, { exclude: tried });
    if (!resolved) break;

    try {
      const model = await resolveModel(db, provider, meta.defaultModel ?? "");
      const json = (await call(resolved.secret, model, opts)) as T;
      if (resolved.keyId) await markKeySucceeded(db, resolved.keyId);
      return json;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!resolved.keyId) break; // env-sourced — nothing left to rotate to
      await markKeyFailed(db, resolved.keyId, { status: (err as { status?: number }).status, message: lastErr.message });
      tried.add(resolved.keyId);
    }
  }

  if (lastErr) throw lastErr;
  return null; // provider not configured at all — not an error, just skip this tier
}

/**
 * Run one completion against the first LLM provider that has a usable key for
 * THIS company.
 *
 * `companyId` is required. It used to be an optional `db`, defaulting to the
 * admin client when omitted — and every caller omitted it, so key selection saw
 * every company's rows and picked whichever sorted first. On 2026-08-29 that
 * meant dev's drafting ran on the client's OpenAI key. See getActiveKey().
 *
 * The scoped client is built here rather than taken as an argument so a caller
 * cannot accidentally hand in an unscoped one; the tier order and the selected
 * model are per-company too, and both now read through it.
 */
export async function complete<T = object>(opts: CompletionOpts, companyId: string): Promise<LlmResult<T>> {
  const client = createScopedClient(companyId);
  const tierOrder = await resolveLlmTierOrder(client);
  const errors: string[] = [];

  for (let i = 0; i < tierOrder.length; i++) {
    const provider = tierOrder[i];
    try {
      const json = await tryProvider<T>(client, companyId, provider, opts);
      if (json !== null) return { json, tier: i + 1 };
    } catch (err) {
      errors.push(`${PROVIDER_META[provider].label}: ${(err as Error).message}`);
    }
  }

  if (errors.length) throw new Error(errors.join(" | "));
  throw new Error("No LLM provider configured — add a key in Settings > Keys, or set an env var like OPENROUTER_API_KEY");
}

export interface ExtractionOutput {
  description: string;
  primary_products: string[];
}

export const EXTRACTION_SYSTEM = `You extract company facts for B2B sales. Return ONLY valid JSON, no markdown fences: { "description": string (2-3 sentences: what they manufacture and who they sell to), "primary_products": string[] }`;

// Appended to EVERY drafting/reply system prompt — personal or company —
// after whichever one is in effect (resolveDraftSystemPrompt / resolveReplyPrompt
// are strict either/or: a personal prompt fully REPLACES the company default,
// not layers on top of it). The company default has its own detailed
// FORMATTING section; a personal prompt is usually free prose about tone and
// content that never mentions formatting at all, so emails came out with zero
// bold anywhere — technically on-brief, visually flat.
//
// Kept deliberately narrow: formatting only, never length/structure/tone, so
// it can't fight a personal prompt's own rules the way an earlier "override
// everything" block did on the reply path (see generate-reply.ts history —
// that one dictated sentence counts and got reverted for contradicting the
// prompt it was appended to).
//
// Defined in lib/constants.ts (not here) so Settings — a client component —
// can show employees the same text without pulling this server-only module
// (admin client, provider keys) into the browser bundle.
export { MANDATORY_FORMATTING_RULES } from "@/lib/constants";

// Appended only to a drafting prompt that does not already declare this JSON
// contract itself (see resolveDraftSystemPrompt) — e.g. a user's personal
// prompt written as free prose. The greeting rule must match what code does:
// code appends the signature and only fills in a greeting when one is missing,
// so the model is asked to open with the greeting itself.
export const DRAFT_JSON_SUFFIX =
  '\n\nReturn ONLY valid JSON with no markdown fences: {"subject": string, "body": string, "product_match": string}.\n' +
  'product_match must be the exact name of the matched product from the PRODUCT REFERENCE LIBRARY, or "none" if no product fits.\n' +
  '"body" is the complete email for a first email, or the full 2-4 sentence nudge for a follow-up. Begin it with the greeting line ("Dear {first name}," or "Dear Sir/Ma\'am,"), and follow any Additional instruction that asks for a different salutation. Do NOT write a sign-off or signature block; the signature is appended in code.\n' +
  'If an Additional instruction is given alone, it overrides the default structure and length asked for above.\n' +
  'If a Current subject/body/signature is also provided (REVISION MODE), apply ONLY that instruction — do not rewrite the rest. The signature/footer is editable when asked.\n' +
  '"subject" is the filled subject line for a first email; for a follow-up you may return an empty string (the subject is cleared in code anyway).';

