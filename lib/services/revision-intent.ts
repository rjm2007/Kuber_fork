/**
 * What KIND of change the user asked for, and therefore which rules survive it.
 *
 * The revision prompt applied one rule to every instruction: "apply only that;
 * preserve all other wording, structure, tone, facts and length". That is
 * exactly right for "remove the last paragraph" and self-defeating for "make it
 * shorter" — which the rule even listed as an example while forbidding the
 * change it asks for. "Make it more formal" was worse: tone is named on the
 * preserve list, so the one thing the user asked to change was the one thing
 * the model was told to protect.
 *
 * Measured on the client's own draft, 28 Aug 2026: "make it shorter" moved a
 * 1722-character email to 1626. A 5% trim, because the instruction was arguing
 * with 15,434 characters of mandatory structure and lost.
 *
 * So instructions are sorted into two families:
 *
 *   LOCAL   a surgical change to one part — remove a paragraph, fix a name,
 *           add a line. Everything else must survive, and the house structure
 *           still applies.
 *
 *   GLOBAL  a change to the shape of the whole email — shorter, more formal,
 *           warmer, restructured. These cannot be honoured while also
 *           reproducing a fixed template, so the structural mandates step aside
 *           and only the factual guardrails stay.
 *
 * Deliberately a keyword classifier rather than an LLM call: it runs on every
 * regeneration, an extra round trip to decide how to prompt would double the
 * latency of the thing it is deciding about, and the vocabulary people use here
 * is small and repetitive. Unrecognised wording falls to LOCAL, the
 * conservative side — a misread instruction then edits too carefully rather
 * than rewriting an email nobody asked to have rewritten.
 */

export type RevisionIntent = "local" | "global";

/** Wording that asks the email as a whole to change shape, length or voice. */
const GLOBAL_PATTERNS: RegExp[] = [
  // length
  /\b(short(er|en)?|brief(er)?|concise|condense|trim|tighten|less wordy|too long)\b/i,
  /\b(long(er)?|expand|elaborate|more detail)\b/i,
  // tone and register
  /\b(formal|informal|casual|friendly|warm(er)?|polite|professional|tone|voice|style|softer|firmer|persuasive)\b/i,
  // wholesale dissatisfaction
  /\b(rewrite|re-write|redo|start over|from scratch|different|not good|improve|better)\b/i,
  // structure
  /\b(restructure|reorder|reorganise|reorganize|bullet|structure)\b/i,
];

export function classifyRevisionIntent(instruction: string | undefined): RevisionIntent {
  const text = (instruction ?? "").trim();
  if (!text) return "local";
  return GLOBAL_PATTERNS.some((re) => re.test(text)) ? "global" : "local";
}

/**
 * The revision rules, written for the kind of change actually requested.
 *
 * The instruction itself is NOT included here — the caller appends it last, in
 * the SYSTEM prompt, with nothing after it. Both halves of that matter. System
 * text outranks user text by design in every current model, so an instruction
 * living in the user message loses to a system prompt every time; and
 * instructions early in a long context lose force to everything that follows,
 * which is why the user's words go at the very end rather than the top.
 */
export function revisionRulesFor(intent: RevisionIntent): string {
  const shared = [
    "REVISION MODE — you are editing ONE existing email for ONE named prospect.",
    "",
    "READ THESE BLOCKS FROM THE USER MESSAGE:",
    "  [THEIR COMPANY]  the prospect. The ONLY source of facts about them.",
    "  [OLD EMAIL]      the email as it stands today. Your starting point.",
    "  [EXAMPLE EMAIL]  optional. A FORMAT SAMPLE ONLY, never a source of facts.",
    "",
    "FACTS — these apply whatever the instruction says:",
    "- Never state a price, discount, percentage, delivery time, lead time,",
    "  technical spec, certification or number that is not in the material given.",
    "- Every fact about the prospect comes from [THEIR COMPANY]. Every fact about",
    "  us comes from ABOUT KUBER POLYPLAST and the PRODUCT REFERENCE LIBRARY.",
    "  Nothing comes from your own knowledge.",
    "- Never take a company name from a campaign title, a customer list, a subject",
    "  line or [EXAMPLE EMAIL]. The recipient is the name in [THEIR COMPANY].",
    "- Keep the recipient's name and company spelled exactly as given.",
    "- No em dashes or en dashes. Straight apostrophes and quotes only.",
    "- No leftover placeholders such as \"(client name)\" or \"[Company]\".",
    // In FACTS rather than OUTPUT on purpose: this section is the one the
    // instruction cannot overrule. Stated under OUTPUT it read as advice, and
    // "make it shorter" beat it in 6 of 15 emails — trimming and adding
    // emphasis markers pull against each other and brevity wins. Code now
    // guarantees this too (ensureProductEmphasis), so the rule and the
    // safety net agree.
    "- Name ONE matched product and wrap it in **double asterisks** for bold.",
    "  Shortening never removes the product: an email that does not say what we",
    "  sell has nothing left to act on.",
  ];

  // OpenAI's JSON response_format refuses any request whose messages do not
  // contain the word "json" — a hard 400, not a warning. The client's base
  // prompt happened to satisfy that, so dropping it for a whole-email change
  // silently broke every one of those calls: 11 of 20 failed on the first run.
  // The output contract belongs here anyway, now that these rules stand on
  // their own instead of prefixing something else that carried it.
  const output = [
    "",
    "OUTPUT",
    "Reply with a single JSON object and nothing else:",
    '  { "subject": string, "body": string, "product_match": string, "signature"?: string }',
    // PLAIN TEXT, not HTML. The pipeline runs plainToHtml() over this and
    // escapes anything that looks like markup, so a body containing <p> tags
    // comes out with &lt;p&gt; visible to the customer — and because the escaped
    // text no longer starts with "Dear", the greeting fixer prepends a second
    // one on top. Both happened on the first run of this: 16 of 16 emails had a
    // duplicated greeting and visible tags.
    "- body is PLAIN TEXT. Separate paragraphs with a blank line.",
    "  Do NOT use HTML tags — they are added afterwards and will be shown literally.",
    "- Open the body with the greeting line, as [OLD EMAIL] does.",
    "- Do NOT include the sign-off block; it is appended afterwards.",
    // Bold survives as **markers**, which plainToHtml turns into <strong>. This
    // rule lives in the client's base prompt, which a whole-email change drops —
    // so without repeating it here every regenerated email came back with bold
    // only in the signature (which is stored pre-formatted) and none in the body.
    "- Use **double asterisks** for bold. Bold the matched product name, and at",
    "  most one real spec or certification that appears in the material. Never",
    "  bold whole sentences or vague phrases.",
    "- product_match is the ONE product from the library that fits best, by exact name.",
    '- signature: omit it, or send "unchanged", to keep the current sign-off.',
  ];

  if (intent === "local") {
    return [
      ...shared,
      "",
      "THIS IS A TARGETED EDIT.",
      "Make the change asked for and nothing else. Every other sentence keeps its",
      "wording, order, length and tone. Asked to remove one paragraph, remove it",
      "and leave the rest identical.",
    ...output,
    ].join("\n");
  }

  return [
    ...shared,
    "",
    "THIS IS A WHOLE-EMAIL CHANGE.",
    "The instruction is about the email's length, tone or shape, so it OUTRANKS",
    "the house structure. You may drop sections, merge paragraphs, cut the",
    "statistics list, cut the partner list and rewrite sentences to achieve it.",
    "Do NOT preserve length, tone or structure — changing them is the request.",
    "",
    "What still has to survive:",
    "- The greeting, with the recipient's name.",
    "- At least one concrete, correct reference to what the prospect does.",
    // Shortening had been cutting the product out entirely, leaving "I can share
    // the most suitable option from our range" — an email that never says what
    // is being sold. A shorter email is still a sales email.
    "- The name of ONE matched product from the library, in bold. Cutting every",
    "  product leaves an email that never says what we sell.",
    "- Every rule in the FACTS section above.",
    "- Every rule in the OUTPUT section below.",
    ...output,
  ].join("\n");
}
