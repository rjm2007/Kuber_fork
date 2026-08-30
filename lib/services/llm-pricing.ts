/**
 * What a call cost, in USD.
 *
 * Prices are per MILLION tokens, taken from each provider's public pricing.
 * They are a cache, not a source of truth — a provider can change them without
 * telling us — so the rule below matters more than the numbers:
 *
 *   an unknown model returns NULL, never 0.
 *
 * A zero would silently understate every total and nobody would notice. A null
 * is visible: the row is there, the tokens are there, and the cost column says
 * "we do not know", which is a question someone can answer.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic bills cache writes ~1.25x input and reads ~0.1x. Recorded
   *  separately so the cost maths can become exact later without a schema change. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Some providers (OpenRouter) return the cost themselves. When they do it is
   *  authoritative — it accounts for their own margin and per-model routing,
   *  which no local table can track. */
  costUsd?: number | null;
}

/** [input $/1M, output $/1M] */
type Price = readonly [number, number];

/**
 * Keyed by the model id as we send it. Anthropic ids are matched by PREFIX so a
 * dated snapshot (claude-sonnet-5-20260101) resolves to the same price as its
 * base id — the alternative is a null cost every time a provider pins a date.
 */
const PRICES: Record<string, Price> = {
  // ── Anthropic (direct) ────────────────────────────────────────────────────
  "claude-fable-5":    [10, 50],
  "claude-mythos-5":   [10, 50],
  "claude-opus-5":     [5, 25],
  "claude-opus-4-8":   [5, 25],
  "claude-opus-4-7":   [5, 25],
  "claude-opus-4-6":   [5, 25],
  "claude-sonnet-5":   [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5":  [1, 5],

  // ── OpenAI ────────────────────────────────────────────────────────────────
  "gpt-4o":      [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};

function lookup(model: string): Price | null {
  const m = model.trim().toLowerCase();
  if (PRICES[m]) return PRICES[m];
  // Prefix match, longest first, so claude-opus-4-8 wins over claude-opus-4.
  const hit = Object.keys(PRICES)
    .filter((k) => m.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? PRICES[hit] : null;
}

/**
 * Cost of one call, or null when the model's price is unknown.
 *
 * `usage.costUsd` wins when the provider supplied one — OpenRouter does, and its
 * figure includes routing and margin that a local table cannot know.
 */
export function costOf(model: string, usage: TokenUsage): number | null {
  if (typeof usage.costUsd === "number") return usage.costUsd;

  // An OpenRouter model id is "vendor/model"; price the model part.
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const price = lookup(bare);
  if (!price) return null;

  const [inPer, outPer] = price;
  // Cache reads and writes are folded in at their headline input rate for now.
  // Deliberately not modelled at 0.1x/1.25x yet: guessing a multiplier per
  // provider would be less honest than a small, known overstatement, and the
  // raw counts are stored so this can be sharpened without losing history.
  const input = usage.inputTokens + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  return (input / 1e6) * inPer + (usage.outputTokens / 1e6) * outPer;
}

/** True when we can price this model at all — used to decide whether a null
 *  cost is expected (new model) or a bug (known model, missing usage). */
export function isPriceKnown(model: string): boolean {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return lookup(bare) !== null;
}
