/**
 * Pure helpers for turning what a user typed into the regenerate box, and what
 * enrichment stored about a prospect, into prompt-ready text.
 *
 * Deliberately dependency-free so `revision-input.test.ts` can run it directly
 * (`npx tsx lib/services/revision-input.test.ts`) without dragging supabase in.
 */

/** Used when the paste is ONLY an example email, with no covering instruction. */
export const DEFAULT_TEMPLATE_CHANGE =
  "Rewrite this email following the example's structure and wording exactly, using this prospect's real details.";

// How a pasted cold email starts. Not anchored to a line start: users routinely
// run the two together ("WRITE ALL THE EMAIL ONLY LIKE THIS-I'm reaching out...").
const EMAIL_OPENER =
  /(dear\s+[^\n,]{1,40},|i['’]m reaching out\b|i am reaching out\b|i hope this (message|email) finds you well)/i;

/**
 * Separate a regenerate instruction into the change being asked for and the
 * example email pasted underneath it.
 *
 * Why this exists: the two arrive in one textarea, so the model could not tell
 * "copy this shape" from "these are the facts" and copied the example's
 * prospect verbatim — "Astral Ltd" reached 97 of 100 emails in one campaign,
 * "Butyl Products" and "EES Shipping" 9 each in others.
 *
 * The two guards are load-bearing. Checked against all 51 instructions in
 * draft_regeneration_jobs: 17 contain a pasted email (all ≥769 chars, all
 * mention Kuber), 34 do not (all ≤353 chars). Without the length+Kuber guards,
 * a short directive like "write actual client name instead of Dear cheris"
 * false-splits on its own "Dear ..." and loses the actual instruction.
 */
export function splitInstruction(raw: string | null | undefined): { change: string; example: string } {
  const text = (raw ?? "").trim();
  if (text.length < 400 || !/kuber/i.test(text)) return { change: text, example: "" };

  const match = EMAIL_OPENER.exec(text);
  if (!match) return { change: text, example: "" };

  const change = text.slice(0, match.index).trim();
  const example = text.slice(match.index).trim();
  if (!example) return { change: text, example: "" };

  return { change: change || DEFAULT_TEMPLATE_CHANGE, example };
}

// Apollo/Firecrawl keywords are a mix of real products and filler. A prospect
// like Pipeco carries 53 of them; unfiltered, "grp water tanks" drowns in
// "b2b, services, productivity". Dropped terms describe any B2B company at all.
const GENERIC_KEYWORDS = new Set([
  "b2b", "b2c", "services", "service", "manufacturing", "distribution",
  "innovation", "sustainability", "consulting", "productivity", "marketing",
  "sales", "technology", "quality management", "supply chain", "engineering",
  "design", "product development", "project management", "supply chain management",
  "logistics & supply chain", "customer experience", "after sales",
  "international standards", "quality", "solutions", "products",
]);

const MAX_PRODUCT_KEYWORDS = 12;

/** The prospect's own products, for the "What they make" prompt line. */
export function customerProducts(org: { keywords?: string[] | null; industry?: string | null } | null): string {
  const kws = (org?.keywords ?? [])
    .map((k) => (k ?? "").trim())
    .filter((k) => k.length > 0 && !GENERIC_KEYWORDS.has(k.toLowerCase()))
    .slice(0, MAX_PRODUCT_KEYWORDS);
  return kws.length > 0 ? kws.join(", ") : (org?.industry ?? "").trim();
}
