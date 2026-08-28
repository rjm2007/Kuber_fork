/**
 * Every failure must reach the client as a sentence they can act on.
 *
 * The trap this pins: OpenAI reports an exhausted wallet as a 429, the same
 * status a rate limit uses. Classified as "busy", the client waits for a
 * recovery that never comes instead of topping up.
 *
 *   node scripts/check-fallback-reason.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Mirrors lib/services/fallback-reason.ts — no TypeScript runner in this repo.
function classify(raw) {
  const e = (raw ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("insufficient_quota") || e.includes("credit_balance_exhausted")
    || e.includes("no credits remaining") || e.includes("out of credits")
    || e.includes("requires more credits") || e.includes("402")
    || e.includes("every configured llm key")) return "no_credits";
  if (e.includes("429") || e.includes("rate limit") || e.includes("timeout")
    || e.includes("timed out") || e.includes("etimedout") || e.includes("503")
    || e.includes("overloaded")) return "service_busy";
  if (e.includes("no organization") || e.includes("missing company")
    || e.includes("not enriched") || e.includes("no company")) return "thin_data";
  if (e.includes("empty") || e.includes("unparseable") || e.includes("invalid json")
    || e.includes("too short")) return "unusable_output";
  return "unknown";
}

// The real errors seen in production this week.
assert.equal(classify('OpenAI 429: {"error":{"message":"You have no credits remaining. Add credits to continue","type":"insufficient_quota","code":"credit_balance_exhausted"}}'), "no_credits");
assert.equal(classify('OpenRouter 402: This request requires more credits, or fewer max_tokens'), "no_credits");
assert.equal(classify("OpenRouter is out of credits ($-0.16 left)"), "no_credits");
assert.equal(classify("Every configured LLM key is out of credits or rejected — draft generation is paused."), "no_credits");

// A bare 429 with no quota wording is a genuine rate limit.
assert.equal(classify("OpenAI 429: Rate limit reached for gpt-4o"), "service_busy");
assert.equal(classify("request timed out after 60000ms"), "service_busy");
assert.equal(classify("503 Service Unavailable"), "service_busy");

assert.equal(classify("lead has no organization record"), "thin_data");
assert.equal(classify("model returned empty body"), "unusable_output");
assert.equal(classify("something nobody has seen before"), "unknown");
assert.equal(classify(null), "unknown");
assert.equal(classify(""), "unknown");

// Only thin data is unfixable — everything else must offer a way forward, or
// the client is left staring at a Template badge with nothing to do about it.
const src = readFileSync(new URL("../lib/services/fallback-reason.ts", import.meta.url), "utf8");
const unfixable = [...src.matchAll(/code: "(\w+)",\s*\n\s*message:[^\n]*\n\s*fixable: false/g)].map((m) => m[1]);
assert.deepEqual(unfixable, ["thin_data"]);

console.log("ok — fallback reasons");
