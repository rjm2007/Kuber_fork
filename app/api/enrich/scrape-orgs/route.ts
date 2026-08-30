import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { complete } from "@/lib/services/llm";
import { scrapePage } from "@/lib/services/firecrawl";
import { internalAppBaseUrl } from "@/lib/internal-url";
import { deriveDomainFromEmail } from "@/lib/utils/domain";
import { autoAssignEnrichedLeads } from "@/lib/services/assignment";
import { logLeadEvents } from "@/lib/services/lead-events";
import {
  checkFirecrawlCredits, checkOpenRouterCredits, checkOpenAICredits,
  checkAnthropicCredits, checkGeminiCredits, checkMistralCredits, checkGroqCredits,
  type CreditCheck,
} from "@/lib/services/provider-credits";
import { resolveModel } from "@/lib/services/provider-keys";
import { PROVIDER_META, resolveLlmTierOrder, type LlmProviderId } from "@/lib/services/providers/registry";
import { safeSecretEqual } from "@/lib/auth/secret";
import { TERMINAL_ENRICHMENT_STATUSES } from "@/lib/services/enrichment-status";
import type { SupabaseClient } from "@supabase/supabase-js";

const LLM_CREDIT_CHECKS: Record<LlmProviderId, (db: SupabaseClient, scope: string) => Promise<CreditCheck>> = {
  openrouter: checkOpenRouterCredits,
  openai: checkOpenAICredits,
  anthropic: checkAnthropicCredits,
  gemini: checkGeminiCredits,
  mistral: checkMistralCredits,
  groq: checkGroqCredits,
};

// Raised from 55s to match the other enrichment routes (apollo-search, enrich
// both run at 300s) — the LLM step alone is allowed up to 90s per attempt
// (lib/http.ts TIMEOUTS.llm) with up to 3 retries, so 55s was already too
// tight for even a single slow org, let alone a batch of 10.
export const maxDuration = 300;

// Retryable = plausibly transient (network blip, timeout, rate limit) — worth
// automatically trying again. Not retryable = the content itself is the
// problem (no domain, empty page, nothing extractable) — retrying instantly
// won't change the outcome, so these go straight to a human via Input Required.
const RETRYABLE_STATUSES = new Set([
  "SCRAPE_FAILED",
  "LLM_EXTRACTION_FAILED",
  // Was missing, and the error message said "Will retry." while the code sent
  // it straight to Input Required on the first failure. The model returning no
  // description is the single most common extraction failure (44 of 1,335
  // failed orgs), and the page is already cached, so a second read is free.
  "LLM_EXTRACTION_PARTIAL_NO_DATA",
  // Our key was missing or dead. Firecrawl was never called, so this says
  // nothing about the company — see PROVIDER_FAULT_STATUSES below.
  "SCRAPE_PROVIDER_UNAVAILABLE",
]);

/**
 * Failures that were OUR fault, not the company's.
 *
 * The org never got a real attempt — no key, no credits, provider down — so the
 * strike is not deducted and "Retry all" is free to reset it. Everything else
 * counts: a dead domain or an empty page will still be dead and empty next month.
 *
 * This distinction is why 436 organisations are currently written off with
 * "No usable Firecrawl key configured". They were never reached.
 */
const PROVIDER_FAULT_STATUSES = new Set(["SCRAPE_PROVIDER_UNAVAILABLE"]);


/**
 * Firecrawl could not reach the site at all — DNS failure, dead domain.
 *
 * Measured against the live API: an unreachable host returns success=false and
 * costs NO credit, while a host that answers (even with a 404 page) costs one.
 * Either way there is nothing to gain from asking again — the domain is wrong,
 * and it will still be wrong tomorrow. So this is a hard stop, not a retry.
 */
function isUnreachableDomain(error: string): boolean {
  return /DNS resolution failed|ENOTFOUND|could not be resolved|name not resolved/i.test(error);
}

/**
 * The scrape never happened because OUR side was not ready.
 *
 * The batch already has a credit gate that skips everything when Firecrawl
 * reports no balance, but that gate reads a cached balance and cannot catch a
 * key that is simply absent or unreadable — scrapePage returns
 * "No usable Firecrawl key configured" per org instead. That string is on 436
 * permanently-failed organisations today: every one of them spent a strike on
 * a request that was never sent.
 */
function isProviderFault(error: string): boolean {
  return /No usable Firecrawl key configured|API key not configured|401|403|payment required|402|insufficient credits/i
    .test(error);
}

/**
 * Turn a model's "I have nothing" into a real absent value.
 *
 * The prompt asks for JSON `null` when a field cannot be evidenced. Models
 * sometimes return the WORD instead — the string "null" — and `!!"null"` is
 * true, so it sailed through every check and was stored as the company's
 * description. Live data: 2 organisations describe themselves as `null` and 5
 * say they sell to `null`, and that text flows straight into the email prompt.
 *
 * Also catches the other ways a model says nothing ("N/A", "unknown", "-"),
 * and trims, so a whitespace-only answer counts as absent too.
 */
function cleanExtracted(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return /^(null|none|n\/a|na|unknown|undefined|not available|not specified|-)\.?$/i.test(text)
    ? null
    : text;
}

/** Which failure this scrape error actually is. */
function classifyScrapeFailure(error: string): string {
  if (isProviderFault(error)) return "SCRAPE_PROVIDER_UNAVAILABLE";
  if (isUnreachableDomain(error)) return "SCRAPE_DOMAIN_UNREACHABLE";
  return "SCRAPE_FAILED";
}
const MAX_ENRICHMENT_ATTEMPTS = 3;

/**
 * How many attempts a failure of THIS kind is worth, before the org stops and
 * goes to Input Required.
 *
 * A scrape failure is usually about reaching the site — the target was slow,
 * rate-limited us, or was briefly down — and a later attempt genuinely can
 * succeed, so it keeps the full three.
 *
 * An LLM extraction failure is different. By then the page is already in hand:
 * the model read it and could not find a company description worth keeping.
 * Measured across 1,335 failed orgs, 44 of these said "LLM returned no
 * description or data" — a thin site or a holding page, which the third read
 * does not fix. Two is enough to cover a genuine blip (a timeout, an aborted
 * call) without paying the model a third time to reach the same conclusion.
 *
 * Note the counter is shared, so this is a ceiling on the org's TOTAL attempts
 * given the failure it just hit — not a separate budget per failure type.
 */
const MAX_ATTEMPTS_BY_STATUS: Record<string, number> = {
  SCRAPE_FAILED: 3,
  LLM_EXTRACTION_FAILED: 2,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type Db = SupabaseClient;

async function insertLog(db: Db, entry: {
  org_id?: string;
  lead_id?: string;
  event: string;
  source: string;
  stage?: string;
  payload?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}) {
  await db.from("enrichment_logs").insert({
    org_id: entry.org_id ?? null,
    lead_id: entry.lead_id ?? null,
    event: entry.event,
    source: entry.source,
    stage: entry.stage ?? null,
    payload: entry.payload ?? null,
    duration_ms: entry.duration_ms ?? null,
    error: entry.error ? entry.error.slice(0, 500) : null, // strip long stack traces
    created_at: new Date().toISOString(),
  });
}

/**
 * Org-level enrichment writes ONE company_description to `organizations` and
 * every lead under that org inherits it — by design, avoiding re-scraping the
 * same company per lead. But when those leads belong to DIFFERENT employees,
 * the ones who didn't trigger the enrichment get their lead's data changed
 * with no notification (review §3.4 — High). There's no live notification
 * system yet, so this at minimum leaves an auditable trail managers can see;
 * the lead drawer also surfaces "shared with N other leads" (lead-drawer.tsx)
 * so the current viewer isn't blindsided either.
 */
async function logSharedEnrichmentFanOut(db: Db, orgId: string) {
  const { data: leads } = await db
    .from("leads")
    .select("id, assigned_to")
    .eq("organization_id", orgId)
    .eq("is_deleted", false)
    .not("assigned_to", "is", null);
  const owners = [...new Set((leads ?? []).map((l) => l.assigned_to as string))];
  if (owners.length > 1) {
    await db.from("audit_log").insert({
      action: "org_enrichment_shared",
      entity_type: "organization",
      entity_id: orgId,
      diff: { affected_owners: owners, affected_lead_count: (leads ?? []).length },
      created_at: new Date().toISOString(),
    });
  }
}

async function markFailed(db: Db, orgId: string, status: string, errorMessage: string) {
  const { data: org } = await db
    .from("organizations")
    .select("enrichment_attempts")
    .eq("id", orgId)
    .single();

  // A failure that was ours does not cost the org an attempt. Without this, an
  // outage silently spends every org's retry budget on a problem they had no
  // part in — which is exactly how 436 of them ended up permanently failed.
  const providerFault = PROVIDER_FAULT_STATUSES.has(status);
  const attempts = providerFault
    ? (org?.enrichment_attempts ?? 0)
    : (org?.enrichment_attempts ?? 0) + 1;
  const outOfRetries = !providerFault
    && attempts >= (MAX_ATTEMPTS_BY_STATUS[status] ?? MAX_ENRICHMENT_ATTEMPTS);
  // Transient failure with attempts left: requeue instead of concluding — the
  // ongoing scrape-orgs self-chain (and the daily watchdog) will pick it back
  // up automatically, so this needs no human until it's actually out of tries.
  const shouldRetry = RETRYABLE_STATUSES.has(status) && !outOfRetries;

  await db.from("organizations").update({
    enrichment_stage: shouldRetry ? "queued" : "failed",
    enrichment_status: shouldRetry ? status : (outOfRetries ? "ENRICHMENT_FAILED_PERMANENT" : status),
    enrichment_attempts: attempts,
    last_error: errorMessage.slice(0, 500),
    updated_at: new Date().toISOString(),
  }).eq("id", orgId);

  // Only conclude leads to Input Required once we've actually stopped trying —
  // while retrying, the org is back in the "queued" pipeline so leads stay New.
  if (!shouldRetry) {
    const { data: nowInputRequired } = await db.from("leads")
      .update({ status: "input_required", updated_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("is_deleted", false)
      .not("status", "in", '("open","closed")')
      .select("id");
    // Clean, non-technical timeline line (the raw error stays in enrichment_logs).
    await logLeadEvents(db, (nowInputRequired ?? []).map((l) => ({
      leadId: l.id as string, event: "enrichment_failed" as const,
      detail: "No company profile — can still be contacted with the generic template",
    })));
  }

  await insertLog(db, {
    org_id: orgId,
    source: "system",
    event: shouldRetry ? "ENRICHMENT_RETRY_QUEUED" : (outOfRetries ? "ENRICHMENT_FAILED_PERMANENT" : "ENRICHMENT_FAILED"),
    error: errorMessage,
    payload: { attempts, retrying: shouldRetry },
  });
}

// Falls back to the org's leads' email domains when Apollo never resolved one.
// Free/webmail providers (gmail.com etc.) are ignored. Requires a clear
// majority among candidate domains; ties or no candidates return null.
// Reassigns a duplicate org's leads onto the org that already owns their real
// domain, then deletes the now-empty duplicate. Leads inherit "enriched" if
// the target org is already done, otherwise they wait on the target's own turn.
async function mergeDuplicateOrg(db: Db, dupOrgId: string, targetOrgId: string, domain: string) {
  const { data: targetOrg } = await db
    .from("organizations")
    .select("enrichment_stage")
    .eq("id", targetOrgId)
    .single();

  const mergedLeadStatus = targetOrg?.enrichment_stage === "done" ? "enriched" : "input_required";

  await db.from("leads")
    .update({ organization_id: targetOrgId, status: mergedLeadStatus, updated_at: new Date().toISOString() })
    .eq("organization_id", dupOrgId)
    .eq("is_deleted", false);

  await insertLog(db, {
    org_id: dupOrgId,
    source: "email_fallback",
    event: "ORG_MERGED_DUPLICATE_DOMAIN",
    payload: { merged_into: targetOrgId, domain },
  });

  await db.from("organizations").delete().eq("id", dupOrgId);
}

type DomainInferenceResult =
  | { type: "resolved"; domain: string }
  | { type: "duplicate"; targetOrgId: string; domain: string }
  | { type: "failed" };

async function inferDomainFromLeadEmails(db: Db, orgId: string): Promise<DomainInferenceResult> {
  const { data: leads } = await db
    .from("leads")
    .select("email")
    .eq("organization_id", orgId)
    .eq("is_deleted", false)
    .not("email", "is", null);

  const counts = new Map<string, number>();
  for (const lead of leads ?? []) {
    const domain = lead.email ? deriveDomainFromEmail(lead.email) : null;
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }

  if (counts.size === 0) {
    await insertLog(db, {
      org_id: orgId,
      source: "email_fallback",
      event: "DOMAIN_INFERENCE_FAILED",
      payload: { lead_count: leads?.length ?? 0, reason: "no_valid_candidates" },
    });
    return { type: "failed" };
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topDomain, topCount] = sorted[0];
  const isTie = sorted.length > 1 && sorted[1][1] === topCount;

  if (isTie) {
    await insertLog(db, {
      org_id: orgId,
      source: "email_fallback",
      event: "DOMAIN_INFERENCE_FAILED",
      payload: { lead_count: leads?.length ?? 0, candidates: sorted, candidate_conflict: true },
    });
    return { type: "failed" };
  }

  // Another org record may already own this domain (a duplicate company record,
  // e.g. two Apollo/Excel entries for the same real company). Reuse it instead
  // of failing — this is what actually resolves the common case.
  const { data: existingOrg } = await db
    .from("organizations")
    .select("id")
    .eq("domain", topDomain)
    .neq("id", orgId)
    .maybeSingle();

  if (existingOrg) {
    return { type: "duplicate", targetOrgId: existingOrg.id, domain: topDomain };
  }

  const { error } = await db.from("organizations")
    .update({ domain: topDomain, domain_source: "email_inferred", updated_at: new Date().toISOString() })
    .eq("id", orgId)
    .is("domain", null);
  if (error) {
    // Race: another org claimed this domain between our check and our write.
    await insertLog(db, {
      org_id: orgId,
      source: "email_fallback",
      event: "DOMAIN_INFERENCE_CONFLICT",
      error: error.message,
      payload: { derived_domain: topDomain, lead_count: leads?.length ?? 0 },
    });
    return { type: "failed" };
  }

  await insertLog(db, {
    org_id: orgId,
    source: "email_fallback",
    event: "DOMAIN_INFERRED_FROM_EMAIL",
    payload: { derived_domain: topDomain, candidate_count: counts.size, lead_count: leads?.length ?? 0 },
  });

  return { type: "resolved", domain: topDomain };
}

/** How many domainless companies to resolve per pass. Each one is a couple of
 *  database round trips and no external call, but this runs before the scrape
 *  work in the same invocation, so it has to leave the function's time budget
 *  intact. A backlog drains over successive passes; the job runs every 15
 *  minutes and costs nothing. */
const DOMAIN_RESOLVE_BATCH = 40;

/**
 * Give queued companies that have no website a domain derived from their own
 * leads' email addresses, so `claim_queued_orgs` can pick them up. Companies
 * whose leads only have webmail addresses (gmail, yahoo…) can't be resolved and
 * are concluded NO_DOMAIN, which moves their leads to Input Required.
 */
async function resolveDomainlessQueuedOrgs(db: Db, limit: number): Promise<void> {
  const { data: orgs } = await db
    .from("organizations")
    .select("id")
    .eq("enrichment_stage", "queued")
    .is("domain", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  for (const org of orgs ?? []) {
    const result = await inferDomainFromLeadEmails(db, org.id);
    if (result.type === "duplicate") {
      await mergeDuplicateOrg(db, org.id, result.targetOrgId, result.domain);
    } else if (result.type === "failed") {
      await markFailed(db, org.id, "NO_DOMAIN", "No website on the record and no usable company domain in its leads' emails");
    }
    // "resolved" needs nothing more — the org now has a domain and the claim
    // below (or the next pass) will pick it up like any other.
  }
}

// Reuse a cached scrape only if it's recent — company sites change, and a
// stale profile is worse than a fresh one. 7 days is well past the retry
// window we care about (the LLM-402 loop happens within minutes/hours).
const SCRAPE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function processOneOrg(
  db: Db,
  org: { id: string; company_id: string; domain: string | null; name: string; scraped_markdown: string | null; scraped_at: string | null },
): Promise<"merged" | void> {
  const orgStart = Date.now();

  // ── A: Mark SCRAPE_STARTED ─────────────────────────────────────────────────
  await db.from("organizations").update({
    enrichment_status: "SCRAPE_STARTED",
    updated_at: new Date().toISOString(),
  }).eq("id", org.id);

  await insertLog(db, {
    org_id: org.id,
    source: "system",
    event: "SCRAPE_STARTED",
    payload: { domain: org.domain, org_name: org.name },
  });

  // ── B: Validate domain, falling back to leads' email domains ────────────────
  if (!org.domain) {
    const result = await inferDomainFromLeadEmails(db, org.id);
    if (result.type === "duplicate") {
      await mergeDuplicateOrg(db, org.id, result.targetOrgId, result.domain);
      return "merged";
    }
    if (result.type === "failed") {
      await markFailed(db, org.id, "NO_DOMAIN", "No domain available after Phase 2A and no usable lead email domain");
      return;
    }
    org.domain = result.domain;
  }

  // ── B.5: Nobody to email under this org — don't spend Firecrawl/LLM credits
  // scraping a website whose only leads can never be contacted. Rare in
  // practice now that email-reveal archives+removes (and cleans up an
  // orphaned org) the moment a lead fails — this is a defensive backstop for
  // odd orderings (e.g. a manual rescrape) rather than the common path.
  const { count: usableLeadCount } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.id)
    .eq("is_deleted", false)
    .or("email.not.is.null,has_email.eq.true");
  if ((usableLeadCount ?? 0) === 0) {
    await markFailed(db, org.id, "NO_EMAILED_LEADS", "No lead under this org has (or is waiting on) a usable email");
    return;
  }

  // ── C: Firecrawl scrape ────────────────────────────────────────────────────
  // Reuse a recent cached scrape when present: the common failure that lands
  // an org back here is the LLM extraction step 402-ing (low OpenRouter
  // balance) AFTER a perfectly good scrape — re-paying Firecrawl to fetch the
  // identical page on every such retry is pure waste (this exact loop is in
  // the logs). If we already have fresh markdown, skip straight to extraction.
  const scrapeStart = Date.now();
  let markdown: string | null = null;

  const cacheFresh = !!org.scraped_markdown
    && !!org.scraped_at
    && (Date.now() - new Date(org.scraped_at).getTime()) < SCRAPE_CACHE_TTL_MS;

  if (cacheFresh) {
    markdown = org.scraped_markdown;
    await insertLog(db, {
      org_id: org.id,
      source: "firecrawl",
      event: "SCRAPE_CACHE_HIT",
      payload: { chars: markdown?.length ?? 0, domain: org.domain },
    });
    await db.from("organizations").update({
      enrichment_status: "SCRAPE_SUCCESS",
      updated_at: new Date().toISOString(),
    }).eq("id", org.id);
  }

  if (!markdown) try {
    const result = await scrapePage(`https://${org.domain}`, org.company_id);
    const scrapeDuration = Date.now() - scrapeStart;

    if (!result.success) {
      const errMsg = result.error ?? "Unknown Firecrawl error";
      await insertLog(db, {
        org_id: org.id,
        source: "firecrawl",
        event: "SCRAPE_FAILED",
        duration_ms: scrapeDuration,
        error: errMsg,
        payload: { domain: org.domain },
      });
      // A domain that does not resolve is not a transient blocker — asking
      // again just repeats the same DNS lookup. Stop now instead of spending
      // two more attempts to learn the same thing.
      await markFailed(db, org.id, classifyScrapeFailure(errMsg), errMsg);
      return;
    }

    markdown = result.data?.markdown ?? null;
    const charCount = markdown?.length ?? 0;

    if (!markdown || charCount < 500) {
      await insertLog(db, {
        org_id: org.id,
        source: "firecrawl",
        event: "SCRAPE_EMPTY",
        duration_ms: scrapeDuration,
        payload: { chars: charCount, domain: org.domain },
      });
      await markFailed(db, org.id, "SCRAPE_EMPTY", "Firecrawl returned empty or insufficient content");
      return;
    }

    await insertLog(db, {
      org_id: org.id,
      source: "firecrawl",
      event: "SCRAPE_SUCCESS",
      duration_ms: scrapeDuration,
      payload: { chars: charCount, domain: org.domain },
    });

    // Cache the raw markdown so a later LLM-only retry doesn't re-scrape.
    await db.from("organizations").update({
      enrichment_status: "SCRAPE_SUCCESS",
      scraped_markdown: markdown,
      scraped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", org.id);

  } catch (err) {
    const errMsg = (err as Error).message;
    await insertLog(db, {
      org_id: org.id,
      source: "firecrawl",
      event: "SCRAPE_FAILED",
      duration_ms: Date.now() - scrapeStart,
      error: errMsg,
      payload: { domain: org.domain },
    });
    await markFailed(db, org.id, classifyScrapeFailure(errMsg), errMsg);
    return;
  }

  // ── D: LLM extraction ──────────────────────────────────────────────────────
  const llmStart = Date.now();

  await db.from("organizations").update({
    enrichment_status: "LLM_EXTRACTION_STARTED",
    updated_at: new Date().toISOString(),
  }).eq("id", org.id);

  // Log whichever provider is actually configured as primary right now
  // (admin-configurable via Settings > Keys) rather than hardcoding
  // "openrouter" — complete() itself resolves the same way, this is purely
  // for an accurate log line.
  const [currentPrimaryTier] = await resolveLlmTierOrder(db);
  await insertLog(db, {
    org_id: org.id,
    source: "llm",
    event: "LLM_EXTRACTION_STARTED",
    payload: {
      model: await resolveModel(db, currentPrimaryTier, PROVIDER_META[currentPrimaryTier].defaultModel ?? ""),
      input_chars: markdown.length,
    },
  });

  try {
    const { json: extracted } = await complete<{ company_description: string | null; sells_to: string | null }>({
      system: `You are a company profile extractor. From the website content provided, extract facts about THIS specific company only.

Return ONLY valid JSON with no markdown, no preamble:
{ "company_description": string | null, "sells_to": string | null }

Rules:
- company_description: 2-3 sentences describing what THIS company manufactures, produces, or does, and what industry it operates in.
- sells_to: who their end customers or industries are in plain terms (e.g. "automotive OEMs", "food packaging brands", "retail chains"). Return null if unclear.
- If you cannot find real evidence for a field in the provided content, return null for that field. Never invent facts. Never describe yourself or any third party — only describe the company whose website you are reading.`,
      user: `Company name: ${org.name}\nWebsite domain: ${org.domain ?? "unknown"}\n\nWebsite content:\n${markdown.slice(0, 8000)}`,
      maxTokens: 1024, // output is a tiny JSON object; keeps cost + credit floor low
    }, org.company_id, { purpose: "enrichment" });

    const llmDuration = Date.now() - llmStart;
    // Normalise BEFORE anything reads it, so the "did we get data" test, the
    // log line and the row we write all agree on what counts as empty.
    const companyDescription = cleanExtracted(extracted?.company_description);
    const sellsTo = cleanExtracted(extracted?.sells_to);
    const hasDescription = !!companyDescription;
    const hasSellsTo = !!sellsTo;
    const extractionEvent = hasDescription && hasSellsTo
      ? "LLM_EXTRACTION_SUCCESS"
      : "LLM_EXTRACTION_PARTIAL";

    await insertLog(db, {
      org_id: org.id,
      source: "llm",
      event: extractionEvent,
      duration_ms: llmDuration,
      payload: { has_description: hasDescription, has_sells_to: hasSellsTo },
    });

    // ── E: Write results + mark complete ──────────────────────────────────────
    const totalDuration = Date.now() - orgStart;

    // Fix E: LLM returned no usable data — treat as soft failure, not success
    const hasExtractedData = hasDescription;
    if (!hasExtractedData) {
      await markFailed(db, org.id, "LLM_EXTRACTION_PARTIAL_NO_DATA",
        "LLM returned no description or data for this org. Will retry.");
      return;  // exit processOneOrg early — do not mark as done
    }

    // Only reach here if we have real data
    await db.from("organizations").update({
      company_description: companyDescription,
      sells_to: sellsTo,
      has_scraped: true,
      enrichment_stage: "done",
      enrichment_status: "ENRICHMENT_COMPLETE",
      enrichment_done_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", org.id);

    // Fix A: sync leads.status → enriched for all non-terminal leads under this org
    const { data: nowEnriched } = await db.from("leads")
      .update({ status: "enriched", updated_at: new Date().toISOString() })
      .eq("organization_id", org.id)
      .eq("is_deleted", false)
      .not("status", "in", '("open","closed")')
      .select("id");

    // Clean per-lead activity entry (drawer timeline) — one line, no raw dumps.
    await logLeadEvents(db, (nowEnriched ?? []).map((l) => ({
      leadId: l.id as string, event: "enriched" as const, detail: "Company profile ready",
    })));

    // Only enriched leads are eligible for employee assignment.
    await autoAssignEnrichedLeads(db, org.id);

    // Audit trail when this org's leads span multiple owners (review §3.4).
    await logSharedEnrichmentFanOut(db, org.id);

    await insertLog(db, {
      org_id: org.id,
      source: "system",
      event: "ENRICHMENT_COMPLETE",
      duration_ms: totalDuration,
      payload: { total_duration_ms: totalDuration },
    });

  } catch (err) {
    const errMsg = (err as Error).message;
    await insertLog(db, {
      org_id: org.id,
      source: "llm",
      event: "LLM_EXTRACTION_FAILED",
      duration_ms: Date.now() - llmStart,
      error: errMsg,
    });
    await markFailed(db, org.id, "LLM_EXTRACTION_FAILED", errMsg);
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();

  // ── Credit gate: don't spend a single attempt on a guaranteed failure.
  // Retrying while a provider is genuinely out of money just burns the 3-try
  // budget for no reason (real websites, none of it their fault) and leaves
  // healthy leads stuck needing a manual retry once credit is topped up. Skip
  // the whole batch untouched — nothing claimed, nothing marked failed — and
  // let the next watchdog tick (or self-chain re-trigger below) check again.
  //
  // The primary LLM tier alone is NOT a hard blocker when a later tier is a
  // validated fallback: lib/services/llm.ts `complete()` already fails over
  // through every configured provider in tier order on ANY error (including
  // 402), so halting the whole batch here just because the FIRST tier is low
  // would leave the queue stuck for no reason even though a later tier is
  // perfectly usable (this exact bug — hardcoded to only check
  // OpenRouter+OpenAI — is why 275+ orgs once sat in `queued` for 17h while
  // Firecrawl and OpenAI were both fine). Tier order itself is resolved
  // fresh here (admin-configurable Primary/Fallback in Settings > Keys), not
  // a static import, so this gate always reflects the current configuration.
  // Firecrawl has no fallback, so it still hard-blocks. Providers with no
  // exposed balance API only validate key liveness (see each check
  // function's own comment) — a real mid-run 429/insufficient_quota still
  // surfaces reactively via /api/v1/service-health.
  const tierOrder = await resolveLlmTierOrder(db);
  // Balances are per company now, so this gate needs one to ask about. The
  // batch spans whatever orgs are queued, so it uses the first claimed org's
  // company — the same company every scrape in this pass will bill.
  const { data: gateOrg } = await db
    .from("organizations")
    .select("company_id")
    .eq("enrichment_stage", "queued")
    .limit(1)
    .maybeSingle();
  const gateScope = (gateOrg?.company_id as string | undefined) ?? "any";

  const [firecrawlCredits, ...tierCredits] = await Promise.all([
    checkFirecrawlCredits(db, gateScope),
    ...tierOrder.map((p) => LLM_CREDIT_CHECKS[p](db, gateScope)),
  ]);
  const primaryCredits = tierCredits[0]; // tierOrder[0] — the current Primary pick, or OpenRouter by default
  const anyLlmTierUsable = tierCredits.some((c) => c.ok);
  const usableTierIndex = tierCredits.findIndex((c) => c.ok);
  const llmBlocking = !anyLlmTierUsable;

  if (!primaryCredits.ok && anyLlmTierUsable) {
    // Informational, not a skip — logged so /api/v1/service-health can still
    // tell a manager "top up <primary>" even though another tier is covering.
    const coveringProvider = PROVIDER_META[tierOrder[usableTierIndex]].label;
    await insertLog(db, {
      source: "system",
      event: "PRIMARY_LLM_LOW_CREDITS_FALLBACK_ACTIVE",
      payload: { primary: primaryCredits, tierCredits: Object.fromEntries(tierOrder.map((p, i) => [p, tierCredits[i]])) },
      error: `${primaryCredits.message} — currently falling back to ${coveringProvider} for company profiles`,
    });
  }

  if (!firecrawlCredits.ok || llmBlocking) {
    const reason = [
      !firecrawlCredits.ok && firecrawlCredits.message,
      llmBlocking && `No usable LLM provider: ${tierOrder.map((p, i) => `${PROVIDER_META[p].label}: ${tierCredits[i].message}`).join(" · ")}`,
    ].filter(Boolean).join(" · ");
    await insertLog(db, {
      source: "system",
      event: "SKIPPED_LOW_CREDITS",
      payload: { firecrawl: firecrawlCredits, tierCredits: Object.fromEntries(tierOrder.map((p, i) => [p, tierCredits[i]])) },
      error: reason,
    });
    // Deliberately do NOT self-trigger here — that would spin in a tight loop
    // re-checking credits every few hundred ms. The 15-min watchdog is the
    // only thing that re-checks while credit stays low.
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "skipped_low_credits", reason });
  }

  // ── Watchdog: reset orgs stuck in 'scraping' beyond the function's max
  // lifetime. Threshold must stay above maxDuration (300s) or this would fire
  // on batches that are still legitimately running. Each requeue counts as an
  // attempt so a pathological org can't loop forever burning Firecrawl/LLM
  // credits (planning.md Phase 3.2).
  const { data: stuckScraping } = await db.from("organizations")
    .select("id, enrichment_attempts")
    .eq("enrichment_stage", "scraping")
    .lt("enrichment_started_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  for (const stuck of stuckScraping ?? []) {
    const attempts = (stuck.enrichment_attempts ?? 0) + 1;
    const givenUp = attempts >= MAX_ENRICHMENT_ATTEMPTS;
    await db.from("organizations").update({
      enrichment_stage: givenUp ? "failed" : "queued",
      enrichment_status: givenUp ? "ENRICHMENT_FAILED_PERMANENT" : "REQUEUED_STUCK_SCRAPING",
      enrichment_attempts: attempts,
      has_scraped: false,
      ...(givenUp ? { last_error: "Scrape repeatedly stalled mid-run" } : {}),
      updated_at: new Date().toISOString(),
    }).eq("id", stuck.id);
  }

  // ── Watchdog: orgs sitting in 'queued' for over 24h were dropped by a dead
  // worker chain. Conclude them so their leads become Input Required instead
  // of showing "New" forever ("New" = pipeline in flight).
  await db.from("organizations")
    .update({
      enrichment_stage: "failed",
      enrichment_status: "ENRICHMENT_NEVER_RAN",
      last_error: "Enrichment never ran — queued for over 24h",
      enrichment_done_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("enrichment_stage", "queued")
    .lt("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // ── Step 1+2: Atomically claim a batch of queued orgs (review §3.5) ───────
  // A prior select-then-update let two concurrent invocations both pick up
  // the same org before either marked it 'scraping', causing duplicate
  // Firecrawl/LLM spend. claim_queued_orgs uses FOR UPDATE SKIP LOCKED so
  // concurrent callers always get disjoint batches.
  //
  // Raised from 5 to 15 now that Step 3 below processes the batch
  // concurrently instead of one org at a time — 15 concurrent scrape+LLM
  // calls comfortably clears in well under the 300s maxDuration, and keeps
  // the self-chain firing at a similar cadence rather than ballooning
  // per-batch wall time.
  //
  // Also clamped to Firecrawl's real remaining balance when known — claiming
  // 15 orgs while only ~6 credits remain would leave 9 of them claimed
  // ("scraping") but unable to actually be scraped this pass.
  const batchSize = firecrawlCredits.remaining != null
    ? Math.max(1, Math.min(15, firecrawlCredits.remaining))
    : 15;
  // Give domainless companies a domain BEFORE the claim, or they can never be
  // claimed at all. claim_queued_orgs requires `domain is not null`, and the
  // only code that could derive one (inferDomainFromLeadEmails, inside
  // processOneOrg) runs *after* the claim — a company with no website could
  // therefore never get one, because the step that would give it one only ran
  // on companies that already had one. 929 leads from an Excel import with no
  // website column sat on "New" for a week that way, never once attempted.
  //
  // Resolution is database-only (read the org's leads, take the most common
  // non-webmail email domain) so it costs no Firecrawl or LLM credits. Anything
  // that still can't be resolved is concluded NO_DOMAIN so its leads land on
  // Input Required instead of waiting on New forever.
  await resolveDomainlessQueuedOrgs(db, DOMAIN_RESOLVE_BATCH);

  const { data: claimedOrgs, error: claimError } = await db.rpc("claim_queued_orgs", { p_batch_size: batchSize });
  if (claimError) {
    return Response.json({ error: claimError.message }, { status: 500 });
  }

  // company_id rides along from claim_queued_orgs (it returns SETOF
  // organizations) so each org can be processed through its OWN company's
  // scoped client below — the relay itself is cross-company.
  const orgs = ((claimedOrgs ?? []) as Array<{ id: string; company_id: string; domain: string | null; name: string; scraped_markdown: string | null; scraped_at: string | null }>)
    .map((o) => ({ id: o.id, company_id: o.company_id, domain: o.domain, name: o.name, scraped_markdown: o.scraped_markdown, scraped_at: o.scraped_at }));

  if (orgs.length === 0) {
    await insertLog(db, {
      source: "system",
      event: "BATCH_COMPLETE",
      payload: { reason: "no_more_queued_orgs" },
    });
    return Response.json({ processed: 0, succeeded: 0, failed: 0, status: "no_more_queued" });
  }

  await insertLog(db, {
    source: "system",
    event: "SCRAPE_BATCH_STARTED",
    payload: { batch_size: orgs.length, org_ids: orgs.map((o) => o.id) },
  });

  // ── Step 3: Process the claimed orgs concurrently ─────────────────────────
  // Each org's scrape+LLM extraction is independent I/O against a different
  // domain — claim_queued_orgs already guarantees disjoint batches across
  // concurrent invocations (FOR UPDATE SKIP LOCKED), so there's no shared
  // state between orgs in this batch either. Running them one at a time was
  // the single biggest throughput bottleneck: 5 orgs sequentially could take
  // 5x as long as running them together, for no correctness benefit.
  const failedOrgIds: Array<{ orgId: string; companyId: string }> = [];
  const results = await Promise.allSettled(orgs.map(async (org) => {
    // A batch can legitimately mix companies, so every write this org triggers
    // (enrichment_logs, lead updates, lead_events, auto-assignment) goes through
    // a client scoped to the org's own tenant. Nothing downstream needs to know
    // about companies — the scoped client stamps and filters for them.
    const orgDb = createScopedClient(org.company_id);
    try {
      const outcome = await processOneOrg(orgDb, org);
      if (outcome === "merged") return { orgId: org.id, companyId: org.company_id, ok: true };
      // Check if it completed (vs failed inside processOneOrg)
      const { data: updated } = await orgDb
        .from("organizations")
        .select("enrichment_stage")
        .eq("id", org.id)
        .single();
      return { orgId: org.id, companyId: org.company_id, ok: updated?.enrichment_stage === "done" };
    } catch {
      await markFailed(orgDb, org.id, "SCRAPE_FAILED", "Unexpected error in processOneOrg").catch(() => {});
      return { orgId: org.id, companyId: org.company_id, ok: false };
    }
  }));

  for (const result of results) {
    processed++;
    // allSettled can only reject if the .map callback itself threw outside
    // its own try/catch, which it doesn't — but guard anyway rather than
    // assume.
    if (result.status === "fulfilled" && result.value.ok) {
      succeeded++;
    } else {
      failed++;
      if (result.status === "fulfilled") {
        failedOrgIds.push({ orgId: result.value.orgId, companyId: result.value.companyId });
      }
    }
  }

  // Enrichment succeeded → autoAssignEnrichedLeads already ran inline. But leads
  // whose enrichment FAILED become input_required and are now campaign-eligible via
  // the generic template — assign them too, so they don't silently pile up in the
  // manager's pool under a non-manual assignment strategy. (§2.6)
  for (const { orgId, companyId } of failedOrgIds) {
    await autoAssignEnrichedLeads(createScopedClient(companyId), orgId).catch(() => {});
  }

  // ── Step 4: Self-trigger if more queued orgs remain ───────────────────────
  const { count } = await db
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("enrichment_stage", "queued");

  if ((count ?? 0) > 0) {
    const baseUrl = internalAppBaseUrl(req);
    const secret = process.env.INTERNAL_SECRET!;
    after(() =>
      fetch(`${baseUrl}/api/enrich/scrape-orgs`, {
        method: "POST",
        headers: { "x-internal-secret": secret },
      }).catch(() => {})
    );
  }

  return Response.json({ processed, succeeded, failed });
}
