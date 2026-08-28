/**
 * Why a follow-up fell back to the template, in words the client can act on.
 *
 * The person reading this bought "a personalised email per company". When they
 * see 5 of 80 marked Template, "OpenAI 429 insufficient_quota" tells them
 * nothing and reads like our software broke. The useful question is only ever
 * one of two things:
 *
 *   • Can I fix this?          -> top up credits, then regenerate
 *   • Is this just how it is?  -> we genuinely know too little about that
 *                                 company, and the template IS the right answer
 *
 * So every failure maps to one of a small set of sentences, each written to
 * answer that question. Anything unrecognised gets the honest catch-all rather
 * than a leaked stack trace.
 */

export type FallbackReason = {
  /** Shown next to the Template badge. One sentence, no jargon. */
  message: string;
  /** True when topping up / retrying will actually change the outcome. Drives
   *  whether the UI offers a Regenerate button or explains this is final. */
  fixable: boolean;
  /** Stable key for grouping the per-step breakdown ("3 AI credits ran out"). */
  code: "no_credits" | "bad_key" | "service_busy" | "thin_data" | "unusable_output" | "unknown";
};

const NO_CREDITS: FallbackReason = {
  code: "no_credits",
  message: "AI credits ran out — top up and regenerate to personalise this one.",
  fixable: true,
};
const BAD_KEY: FallbackReason = {
  code: "bad_key",
  message: "The AI provider is rejecting the API key. Check or replace it in Settings > Keys.",
  fixable: true,
};
const SERVICE_BUSY: FallbackReason = {
  code: "service_busy",
  message: "The AI service was busy. Regenerate to try again.",
  fixable: true,
};
const THIN_DATA: FallbackReason = {
  code: "thin_data",
  message: "Not enough details about this company to personalise. The template is the safe choice here.",
  fixable: false,
};
const UNUSABLE: FallbackReason = {
  code: "unusable_output",
  message: "The AI could not produce a usable email for this lead. Regenerate to try again.",
  fixable: true,
};
const UNKNOWN: FallbackReason = {
  code: "unknown",
  message: "This one could not be written automatically. Regenerate to try again.",
  fixable: true,
};

/**
 * Classify a raw provider/generation error.
 *
 * Order matters: "insufficient_quota" arrives as a 429 from OpenAI, the same
 * status a rate limit uses, so the credit check has to run BEFORE the busy
 * check or a dead wallet is reported as a passing blip and the client waits
 * for a recovery that never comes.
 */
export function classifyFallback(rawError: string | null | undefined): FallbackReason {
  const e = (rawError ?? "").toLowerCase();
  if (!e) return UNKNOWN;

  if (
    e.includes("insufficient_quota") || e.includes("credit_balance_exhausted")
    || e.includes("no credits remaining") || e.includes("out of credits")
    || e.includes("requires more credits") || e.includes("402")
    || e.includes("every configured llm key")
  ) return NO_CREDITS;

  // A rejected key is NOT a billing problem, and saying so sends someone to top
  // up an account that has money in it. Seen live 28 Aug 2026: an OpenRouter key
  // returning "401 Missing Authentication header" was reported to the user as
  // "Out of credits". Checked before the rate-limit rule because 403 appears in
  // both vocabularies.
  if (e.includes("401") || e.includes("403") || e.includes("missing authentication")
      || e.includes("invalid api key") || e.includes("incorrect api key")
      || e.includes("unauthorized") || e.includes("no auth credentials")) return BAD_KEY;

  if (e.includes("429") || e.includes("rate limit") || e.includes("timeout")
      || e.includes("timed out") || e.includes("etimedout") || e.includes("503")
      || e.includes("overloaded")) return SERVICE_BUSY;

  if (e.includes("no organization") || e.includes("missing company")
      || e.includes("not enriched") || e.includes("no company")) return THIN_DATA;

  if (e.includes("empty") || e.includes("unparseable") || e.includes("invalid json")
      || e.includes("too short")) return UNUSABLE;

  return UNKNOWN;
}
