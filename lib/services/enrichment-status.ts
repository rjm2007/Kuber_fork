/**
 * Enrichment failures that retrying can never fix.
 *
 * There is no website, no contactable person, the domain does not resolve, or
 * the page loaded and had nothing on it. None of that changes because we ask
 * again — and each of these has already been through the fallback that tries to
 * infer a domain from the leads' own email addresses, so the cheap options are
 * exhausted before an org can land here.
 *
 * Lives here rather than in either route because BOTH retry paths have to agree
 * on it, and they did not. The automatic cron (auto-retry-failed-orgs) already
 * excluded NO_DOMAIN and NO_EMAILED_LEADS; "Retry all" did not, and all 427
 * NO_DOMAIN organisations sat at attempts=1, so every press requeued the lot to
 * fail again immediately. Churn that achieved nothing, and it made the Input
 * Required count look actionable when most of it was not.
 *
 * An org whose DATA later improves is still picked up: auto-retry-failed-orgs
 * requeues a failed org once it has a usable lead, which is the only signal
 * that actually changes the answer.
 */
export const TERMINAL_ENRICHMENT_STATUSES = [
  "NO_DOMAIN",
  "NO_EMAILED_LEADS",
  "SCRAPE_DOMAIN_UNREACHABLE",
  "SCRAPE_EMPTY",
] as const;

/** PostgREST `not.in` list form, e.g. `("NO_DOMAIN","NO_EMAILED_LEADS")`. */
export const TERMINAL_STATUS_LIST = `(${TERMINAL_ENRICHMENT_STATUSES.map((s) => `"${s}"`).join(",")})`;
