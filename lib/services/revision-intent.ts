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
  ];

  if (intent === "local") {
    return [
      ...shared,
      "",
      "THIS IS A TARGETED EDIT.",
      "Make the change asked for and nothing else. Every other sentence keeps its",
      "wording, order, length and tone. Asked to remove one paragraph, remove it",
      "and leave the rest identical.",
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
    "- Every rule in the FACTS section above.",
    "- The sign-off block exactly as it appears in [OLD EMAIL], unless the",
    "  instruction is specifically about the sign-off.",
  ].join("\n");
}
