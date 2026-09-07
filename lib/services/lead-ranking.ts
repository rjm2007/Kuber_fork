/**
 * Which ONE person we keep at a company.
 *
 * Kuber sells masterbatch — a raw material. That decides the ranking, and it is
 * NOT "most senior wins": at a 5,000-person converter the CEO has never thought
 * about masterbatch, while the purchase manager re-buys it every month. Buying
 * FUNCTION outranks org-chart height.
 *
 * WHY TITLE IS THE ONLY SIGNAL
 * Measured against the live account on 2026-09-07 (scripts/probe-search-fields.ts,
 * raw dump in docs/apollo-research/search-person-fields.json): Apollo's FREE
 * mixed_people/api_search returns exactly eleven fields per person, and
 * `seniority`, `email_status`, `departments` and the employer's
 * `estimated_num_employees` are NOT among them — they arrive only with the paid
 * bulk_match, i.e. after the credit is already spent. So every idea that needs
 * those (prefer a verified email, owner-first at small firms and
 * procurement-first at large ones) cannot run at selection time without paying
 * for the very people we are trying not to pay for.
 *
 * ponytail: flat order, no company-size split. The size-aware version needs
 * estimated_num_employees, which costs a credit per person to learn. If the
 * client wants it, the cheap approximation is the employee_ranges the search
 * itself filtered on — every company in one search shares that band.
 */

/** Buying function, highest first. First match wins, so order matters:
 *  "VP of Procurement" must score as procurement, not as generic leadership. */
const TIERS: Array<{ score: number; re: RegExp; label: string }> = [
  // The people whose actual job is choosing a raw-material supplier.
  { score: 100, label: "procurement", re: /\b(purchas\w*|procure\w*|procurement|sourcing|buyer|buying|materials?|category manager|supply chain|vendor development)\b/i },
  // Owner-operators. At an SME converter this person personally picks the
  // vendor and reads their own mail; at a large one they still outrank a
  // generic director because they can overrule a buyer.
  { score: 90, label: "owner", re: /\b(proprietor|owner|founder|co-?founder|partner|managing director|man\.? dir|\bmd\b)\b/i },
  // The technical gatekeeper: specifies and trials the masterbatch, and can
  // block a switch even when they do not sign the PO.
  { score: 70, label: "technical", re: /\b(production|plant|works|manufactur\w*|technical|r ?& ?d|research|quality|qa|qc|process|extrusion|polymer)\b/i },
  // Generic leadership — real authority, no stated link to raw material.
  { score: 50, label: "leadership", re: /\b(ceo|chief executive|president|general manager|\bgm\b|managing partner|director|vice president|\bvp\b|head|chief|coo|operations)\b/i },
];

/** Cannot buy your product and will not forward the mail. A sales head at a
 *  converter is selling THEIR film, not buying YOUR masterbatch. The search
 *  already excludes "Sales Department" via person_not_titles, but a title like
 *  "Director - Sales & Marketing" slips past that filter, so it is scored last
 *  here as well rather than trusted to never arrive. */
const DISQUALIFIED = /\b(sales|marketing|business development|\bbd\b|account executive|recruit\w*|talent|hr\b|human resources|intern)\b/i;

/** Nudges within a tier: a "Head of Purchasing" beats a "Purchase Assistant"
 *  without needing its own tier. */
const RANK_BONUS: Array<{ points: number; re: RegExp }> = [
  { points: 8, re: /\b(chief|head|vice president|\bvp\b|director|general manager)\b/i },
  { points: 5, re: /\b(manager|lead|superintendent|controller)\b/i },
  { points: 2, re: /\b(officer|engineer|specialist)\b/i },
  { points: -6, re: /\b(assistant|associate|junior|jr\.?|trainee|apprentice|executive assistant|coordinator|clerk)\b/i },
];

/**
 * How good a masterbatch contact this title is. Higher wins; ties are broken by
 * the caller (Apollo's own result order) so the choice stays deterministic.
 */
export function scoreTitle(title: string | null | undefined): number {
  const t = (title ?? "").trim();
  if (!t) return 0;
  // Checked before the tiers: "Sales & Procurement Manager" is a seller first.
  if (DISQUALIFIED.test(t)) return -100;

  const tier = TIERS.find((x) => x.re.test(t));
  let score = tier?.score ?? 10; // an unrecognised title is still a real person
  for (const b of RANK_BONUS) if (b.re.test(t)) { score += b.points; break; }
  return score;
}

/** Human-readable reason, for the import summary and for debugging a bad pick. */
export function titleTier(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  if (!t) return "unknown";
  if (DISQUALIFIED.test(t)) return "disqualified";
  return TIERS.find((x) => x.re.test(t))?.label ?? "other";
}

/**
 * Pick the single best contact from everyone this search found at one company.
 * Returns null only for an empty list.
 */
export function pickBestContact<T extends { title: string | null }>(people: T[]): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const p of people) {
    const s = scoreTitle(p.title);
    if (s > bestScore) { best = p; bestScore = s; }
  }
  return best;
}

/**
 * One company is one prospect, so the key has to survive Apollo writing the
 * same firm two ways. Case, punctuation and the legal suffix all vary between
 * records ("Acme Plastics Pvt. Ltd." vs "Acme Plastics Private Limited"), and
 * the free search gives us no organization id or domain to fall back on.
 */
export function orgKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[.,''`"()]/g, " ")
    // LEGAL FORM ONLY. Descriptive words stay: stripping "industries"/"group"
    // would collapse "Reliance Industries" and "Reliance Group" into one key
    // and silently blacklist a company we have never contacted - the exact
    // failure this feature exists to prevent. Over-merging costs a real
    // prospect; under-merging costs one duplicate. So under-merge.
    .replace(/\b(private|pvt|limited|ltd|llp|llc|inc|incorporated|corp|corporation|co|gmbh|bv|nv|srl|spa|pte|sdn|bhd|plc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
