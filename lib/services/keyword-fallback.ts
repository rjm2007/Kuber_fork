/**
 * Rescue a keyword Apollo returns nothing for.
 *
 * Apollo's q_keywords matches close to literally against how a company
 * describes ITSELF, not against descriptive English. Measured against the live
 * account on 2026-09-07 (scripts/diagnose-client-keywords.ts) using the exact
 * terms the client typed that morning:
 *
 *   "Plastic HDPE pipes"        ->     0     "hdpe pipe"        -> 1,110
 *   "Shopping Bag Manufacturer" ->     0     "shopping bags"    -> 1,022
 *   "Plastic Taps"              ->     0     "taps"             -> 3,182
 *   "Garbage Bag Manufacturer"  ->     0     "garbage bags"     ->   219
 *   "Plastic Corrugated Pipes"  ->     0     "corrugated pipe"  ->   203
 *   "Pipe and Extrusion"        ->     0     "pipe extrusion"   ->   228
 *   "Plastic Bag Manufacturer"  ->     5     "plastic bags"     ->   885
 *
 * Eleven keywords, nine of them zero, and the client concluded the product was
 * broken. Nothing was broken and nothing was charged - people-search is free -
 * but they had no way to know that adding the word "Manufacturer" is what
 * emptied the result set.
 *
 * Because search costs no credits, trying a few shorter forms is free. What is
 * NOT free is doing it silently: the caller is expected to report which term
 * actually ran, so the client learns the rule rather than depending on us
 * guessing for them forever.
 */

/** Words that describe what a company DOES rather than what it calls itself.
 *  Apollo has no "Manufacturer" in its index for these firms - the company name
 *  and description say "poly bags", not "Poly Bag Manufacturer". */
const NOISE = /\b(manufacturers?|manufacturing|suppliers?|supplying|exporters?|importers?|makers?|producers?|companies|company|factory|factories|industry|industries|products?|items?|unit|units|solutions?|services?)\b/gi;

/** Dropped only as a LEADING word and only when something survives: Apollo
 *  does index "plastic film" and "plastic bags", so this is a fallback to try
 *  after the noise-word strip, never a rewrite applied up front. */
const LEADING_GENERIC = /^(plastic|poly)\s+(?=\S)/i;

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Crude but adequate for trade nouns: bags/bag, pipes/pipe, boxes/box. */
function togglePlural(phrase: string): string | null {
  const parts = phrase.split(" ");
  const last = parts[parts.length - 1];
  if (!last) return null;
  let swapped: string;
  if (/(ches|shes|sses|xes|zes)$/i.test(last)) swapped = last.slice(0, -2);
  else if (/ies$/i.test(last)) swapped = last.slice(0, -3) + "y";
  else if (/s$/i.test(last) && !/ss$/i.test(last)) swapped = last.slice(0, -1);
  else if (/(ch|sh|ss|x|z)$/i.test(last)) swapped = last + "es";
  else if (/y$/i.test(last) && !/[aeiou]y$/i.test(last)) swapped = last.slice(0, -1) + "ies";
  else swapped = last + "s";
  if (swapped === last || swapped.length < 2) return null;
  return [...parts.slice(0, -1), swapped].join(" ");
}

/**
 * Shorter forms to try, best first. Never includes the original, never empty,
 * and capped so a rescue costs a couple of seconds rather than a minute.
 */
export function keywordVariants(keyword: string, limit = 4): string[] {
  const original = squash(keyword).toLowerCase();
  if (!original) return [];

  const seeds: string[] = [];
  const push = (v: string | null | undefined) => {
    const s = squash(v ?? "").toLowerCase();
    // A single leftover generic word ("plastic", "poly") matches half of Apollo
    // and is worse than returning nothing.
    if (!s || s === original || /^(plastic|poly|and|the)$/.test(s)) return;
    if (!seeds.includes(s)) seeds.push(s);
  };

  const deNoised = squash(original.replace(NOISE, " "));
  push(deNoised);
  // "Pipe and Extrusion" -> "pipe extrusion": conjunctions are punctuation to
  // Apollo, not a query operator.
  const base = deNoised || original;
  push(squash(base.replace(/\s+(and|&|\/|,)\s+/g, " ")));
  push(togglePlural(base));
  push(base.replace(LEADING_GENERIC, ""));
  push(togglePlural(base.replace(LEADING_GENERIC, "")));
  push(original.replace(LEADING_GENERIC, ""));

  return seeds.slice(0, limit);
}

/** Below this a rescue is not worth reporting as a save - it is noise. */
export const MIN_USEFUL_RESULTS = 25;

/**
 * Which rescued variant to actually run.
 *
 * NOT simply the biggest number. Taking the raw maximum turned "Plastic Taps"
 * into "tap" (6,445) - a word that also matches tap water and tapping, i.e. it
 * bought volume by throwing away the client's intent. Specificity wins first:
 * the most words, and only among equally specific terms does the larger result
 * set break the tie. A broad term is accepted only when nothing precise clears
 * MIN_USEFUL_RESULTS, because a keyword with 3 matches is not worth an import
 * slot either.
 */
export function pickBestVariant<T extends { term: string; count: number }>(candidates: T[]): T | null {
  const usable = candidates.filter((c) => c.count > 0);
  if (usable.length === 0) return null;
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const bySpecificity = [...usable].sort((a, b) => words(b.term) - words(a.term) || b.count - a.count);
  return bySpecificity.find((c) => c.count >= MIN_USEFUL_RESULTS)
    ?? [...usable].sort((a, b) => b.count - a.count)[0];
}
