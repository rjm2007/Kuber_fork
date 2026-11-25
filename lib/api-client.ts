"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Lead, LeadStatus, LeadScore, LeadSource, EnrichmentStage } from "@/lib/leads";
import type { Campaign } from "@/components/app/create-campaign-modal";
import type { CampaignStepInput, IndustryKeywordGroup } from "@/lib/constants";
import type { Member, Scope } from "@/lib/auth/scopes";
import { campaignOutcomes } from "@/lib/campaign-status";
import { mapDbCampaign as mapDbCampaignFull } from "@/lib/mappers";
import { queryCache } from "@/lib/query-cache";
import { everyWhileVisible } from "@/lib/utils";
import type { ImportChoices, ImportResult } from "@/lib/import-review-types";

// ─── Token helper ─────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const { supabase } = await import("@/lib/supabase");
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}

// Every route that fails zod validation returns the same generic top-level
// message ("Invalid request") — it means "the request payload didn't match the
// schema", not that some literal "body" field is wrong. The actual reason
// (which field, what rule it broke) is computed server-side via
// `parsed.error.flatten()` and sent as `error.details`, but every caller that
// just did `setError(e.message)` was showing the generic wrapper and throwing
// the specific reason away — indistinguishable from a real bug on both sides
// of the request. Fold the field-level detail into the message itself so any
// UI that already surfaces `e.message` gets something a user (or the next
// person debugging this) can actually act on.
function describeApiError(error: { code?: string; message?: string; details?: unknown } | null | undefined, status: number): string {
  const details = error?.details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
  const fieldMessages = Object.entries(details?.fieldErrors ?? {})
    .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
    .map(([field, msgs]) => `${field} — ${msgs[0]}`);
  if (fieldMessages.length > 0) {
    return `${error?.message ?? "Invalid request"}: ${fieldMessages.join("; ")}`;
  }
  if (details?.formErrors?.length) {
    return `${error?.message ?? "Invalid request"}: ${details.formErrors.join("; ")}`;
  }
  return error?.message ?? `API error ${status}`;
}

async function apiFetch<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const tok = token ?? await getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...init.headers,
    },
  });
  let json: { success: boolean; data: unknown; error: { code?: string; message?: string; details?: unknown } | null };
  try {
    json = await res.json();
  } catch (parseErr) {
    // An aborted request (e.g. a superseded search-as-you-type call) can cut
    // the body stream off mid-read, which throws a plain SyntaxError here
    // instead of the AbortError callers already know to ignore — surfaced as
    // "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
    // with no indication it was actually a cancelled request. Callers already
    // check `signal.aborted` / err.name === "AbortError" after a caught
    // error, so report it the same way instead of leaking the raw parse
    // failure — and if the signal was never aborted, this really was the
    // server returning a broken body, which is worth saying plainly.
    if (init.signal?.aborted) {
      const abortErr = new Error("The operation was aborted.");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    if (res.status === 413) throw new Error("Too large to send. Please use a smaller file or fewer items.");
    throw new Error(`Server returned an unreadable response (${res.status}). Please try again.`);
  }
  if (!json.success) {
    // A previously-valid session can go stale mid-use (e.g. the account was
    // just deactivated) — force the user out instead of leaving them staring
    // at a broken page full of failed requests.
    if (res.status === 401) {
      queryCache.clear();
      const { supabase } = await import("@/lib/supabase");
      await supabase.auth.signOut();
      if (typeof window !== "undefined") window.location.href = "/";
    }
    const err = new Error(describeApiError(json.error, res.status)) as Error & { code?: string; details?: unknown };
    err.code = json.error?.code;
    err.details = json.error?.details;
    throw err;
  }
  // Any successful write can change what cached GETs would return: stale them
  // all and refetch the related ones that are on screen (lib/query-cache.ts).
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") queryCache.invalidateForMutation(path);
  return json.data as T;
}

// ─── DB → frontend type mapping ───────────────────────────────────────────────

const LEAD_STATUS_MAP: Record<string, LeadStatus> = {
  new:            "New",
  enriching:      "Enriching",
  enriched:       "Enriched",
  input_required: "Input Required",
  open:           "Open",
  closed:         "Closed",
};

const SOURCE_MAP: Record<string, LeadSource> = {
  apollo: "Apollo",
  excel:  "Excel",
  manual: "Manual",
};

export interface DbLead {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  headline: string | null;
  country: string | null;
  lead_source: string;
  created_at: string;
  is_likely_to_engage: boolean | null;
  status: string;
  import_id: string | null;
  assigned_to: string | null;
  imports: { id: string; label: string; color: string } | null;
  campaign_name?: string | null;
  campaign_list?: { id: string; name: string; crm_status: string; added_at?: string | null }[];
  // Set only by the single-lead GET route (review §3.4) — see lib/mappers.ts.
  org_shared?: { other_lead_count: number; other_owner_count: number } | null;
  organizations: {
    id: string;
    name: string;
    domain: string | null;
    domain_source: string | null;
    unsubscribed: boolean;
    has_scraped: boolean;
    enrichment_stage: string | null;
    company_description: string | null;
    sells_to: string | null;
    last_error: string | null;
  } | null;
}

export interface DbCampaign {
  id: string;
  name: string;
  status: string;
  human_in_loop: boolean;
  total_leads: number;
  /** DELIVERED — replies and bounces included. See campaignOutcomes(). */
  sent_count: number;
  replied_count: number;
  bounced_count?: number;
  created_at: string;
  daily_limit: number | null;
  window_from: string | null;
  window_to: string | null;
  schedule_timezone: string | null;
  send_days: Record<string, boolean> | null;
  ai_prompt_context: string | null;
  sender_name: string | null;
  hot_count: number;
  cold_count: number;
  /** Server's verdict on whether the caller may edit Options/Sequences (docs/notes/EDGE_CASES.md §2.10). */
  can_edit_settings?: boolean;
  // followup_day_2 / followup_day_3 are kept as nullable columns in the DB but
  // no longer written on creation — step delays now live in campaign_steps rows.
  followup_day_2: number | null;
  followup_day_3: number | null;
  created_by: string;
  /** Non-null while sending is held. See campaigns.sending_held_at. */
  sending_held_at?: string | null;
}

export function mapDbLead(l: DbLead): Lead {
  const score: LeadScore = l.is_likely_to_engage === true ? "Hot" : l.is_likely_to_engage === false ? "Cold" : "—";
  const org = l.organizations;
  const enrichmentStage = (org?.enrichment_stage as EnrichmentStage) ?? null;

  const status: LeadStatus = LEAD_STATUS_MAP[l.status] ?? "New";
  const email = l.email ?? "";
  const domain = org?.domain ?? "";

  return {
    id: l.id,
    firstName: l.first_name ?? "",
    lastName: l.last_name ?? "",
    email,
    company: org?.name ?? "",
    domain,
    domainSource: (org?.domain_source as Lead["domainSource"]) ?? null,
    jobTitle: l.title ?? l.headline ?? "",
    phone: l.phone ?? "",
    country: l.country ?? "",
    status,
    score,
    source: SOURCE_MAP[l.lead_source] ?? "Manual",
    campaign: l.campaign_name ?? (l.campaign_list?.[0]?.name ?? ""),
    campaigns: l.campaign_list ?? [],
    createdAt: l.created_at,
    orgId: org?.id ?? null,
    enrichmentStage,
    companyDescription: org?.company_description ?? null,
    sellsTo: org?.sells_to ?? null,
    lastError: org?.last_error ?? null,
    hasScraped: org?.has_scraped ?? false,
    importId: l.import_id ?? null,
    batchLabel: l.imports?.label ?? null,
    batchColor: l.imports?.color ?? null,
    assignedTo: l.assigned_to ?? null,
    orgShared: l.org_shared
      ? { otherLeadCount: l.org_shared.other_lead_count, otherOwnerCount: l.org_shared.other_owner_count }
      : null,
  };
}

// ponytail: second copy of lib/mappers.ts mapDbCampaign (and of DbCampaign
// above), kept in sync by hand — they already disagree on attachmentName /
// assignedTo. Collapse to the mappers.ts one if a third field has to be added
// in two places.
export function mapDbCampaign(c: DbCampaign): Campaign {
  const statusMap: Record<string, Campaign["status"]> = {
    draft: "Draft", processing: "Draft", active: "Live", paused: "Paused", completed: "Live", archived: "Paused",
  };
  return {
    id: c.id,
    name: c.name,
    status: statusMap[c.status] ?? "Draft",
    leads: c.total_leads,
    ...campaignOutcomes(c),
    humanInLoop: c.human_in_loop,
    createdAt: c.created_at.slice(0, 10),
    dailyLimit: c.daily_limit ?? 30,
    windowFrom: c.window_from ?? "08:00",
    windowTo: c.window_to ?? "18:00",
    timezone: c.schedule_timezone ?? "Asia/Kolkata",
    sendDays: c.send_days ?? {},
    aiPromptContext: c.ai_prompt_context ?? undefined,
    senderName: c.sender_name ?? undefined,
    hot: c.hot_count ?? 0,
    cold: c.cold_count ?? 0,
    createdBy: c.created_by,
    sendingHeldAt: c.sending_held_at ?? null,
    // Absent (an older payload) means "not allowed" — never assume edit rights
    // the server did not grant.
    canEditSettings: c.can_edit_settings === true,
  };
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function fetchLeadsCount(token: string): Promise<number> {
  const data = await apiFetch<{ total: number }>("/api/v1/leads/count", {}, token);
  return data.total;
}

/** Organizations that have a lead this user sees: the Organization list's "N of M organizations". */
export async function fetchOrgCount(token: string): Promise<number> {
  const data = await apiFetch<{ orgs: number }>("/api/v1/leads/count?orgs=1", {}, token);
  return data.orgs;
}

/** Per-stage totals straight from the database — what the Kanban column headers
 *  show, so they agree with the Dashboard instead of counting loaded rows. */
export async function fetchLeadStatusCounts(token: string): Promise<Record<string, number>> {
  const data = await apiFetch<{ total: number; by_status: Record<string, number> }>("/api/v1/leads/count", {}, token);
  return data.by_status ?? {};
}

/** The Leads page filters hold DISPLAY labels ("Input Required", "Apollo").
 *  The database stores the enum values. Reverse the two maps once here so the
 *  page never has to know the difference. */
export const DB_LEAD_STATUS = Object.fromEntries(
  Object.entries(LEAD_STATUS_MAP).map(([db, label]) => [label, db]),
) as Record<string, string>;
export const DB_LEAD_SOURCE = Object.fromEntries(
  Object.entries(SOURCE_MAP).map(([db, label]) => [label, db]),
) as Record<string, string>;

export type LeadListFilters = {
  assigned_to?: string;
  statuses?: string[];
  sources?: string[];
  import_ids?: string[];
  created_after?: string;
  created_before?: string;
};

/** `count: "none"` skips the server's exact count; total is then null. */
export async function fetchLeads(token: string, params?: { limit?: number; page?: number; organization_id?: string; q?: string; count?: "none" } & LeadListFilters): Promise<{ leads: Lead[]; total: number | null }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.page) qs.set("page", String(params.page));
  if (params?.organization_id) qs.set("organization_id", params.organization_id);
  if (params?.q) qs.set("q", params.q);
  if (params?.assigned_to) qs.set("assigned_to", params.assigned_to);
  if (params?.statuses?.length) qs.set("statuses", params.statuses.join(","));
  if (params?.sources?.length) qs.set("sources", params.sources.join(","));
  if (params?.import_ids?.length) qs.set("import_ids", params.import_ids.join(","));
  if (params?.created_after) qs.set("created_after", params.created_after);
  if (params?.created_before) qs.set("created_before", params.created_before);
  if (params?.count) qs.set("count", params.count);
  const data = await apiFetch<{ leads: DbLead[]; total: number | null }>(`/api/v1/leads?${qs}`, {}, token);
  return { leads: data.leads.map(mapDbLead), total: data.total };
}

/** "What changed last" marker for the caller's leads (Leads page poll). */
export async function fetchLeadsStamp(token: string): Promise<string | null> {
  const data = await apiFetch<{ stamp?: string }>("/api/v1/leads?stamp=1", {}, token);
  return data.stamp ?? null;
}

export async function fetchLeadsByOrg(token: string, orgId: string): Promise<Lead[]> {
  const { leads } = await fetchLeads(token, { organization_id: orgId, limit: 200 });
  return leads;
}

export async function fetchLead(token: string, id: string): Promise<Lead> {
  const data = await apiFetch<DbLead>(`/api/v1/leads/${id}`, {}, token);
  return mapDbLead(data);
}

export type ServiceIssue = { service: string; kind: "credits" | "auth"; message: string; severity: "warning" | "critical" };

export async function fetchServiceHealth(token: string): Promise<ServiceIssue[]> {
  const data = await apiFetch<{ issues: ServiceIssue[] }>(`/api/v1/service-health`, {}, token);
  return data.issues;
}

export async function fetchApolloCredits(token: string): Promise<{ remaining: number | null; limit: number | null }> {
  return apiFetch<{ remaining: number | null; limit: number | null }>("/api/v1/apollo-credits", {}, token);
}

export type LeadActivityEvent = {
  event: string;
  detail: string | null;
  actor_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  created_at: string;
};

// Credits > keys (keys:read to see, keys:write to change) — multi-provider API key management.
export type ProviderCategory = "llm" | "service";
export type ProviderKeyStatus = "healthy" | "cooling_off" | "dead";
export type ProviderKey = {
  id: string; provider: string; label: string; secret_last4: string;
  priority: number; is_active: boolean; status: ProviderKeyStatus;
  cooling_off_until: string | null; last_used_at: string | null;
  last_checked_at: string | null; last_error: string | null;
  last_error_at: string | null; created_at: string;
};
export type ProviderConfig = {
  id: string; category: ProviderCategory; label: string;
  description: string | null;
  modelInputMode: "dropdown" | "freeform" | "none";
  modelOptions: string[]; defaultModel: string | null; selectedModel: string | null;
  /** True when this provider has no DB key but a .env.local value is present,
   *  so it is still working — "not configured" would be wrong. */
  envFallback: boolean;
  keys: ProviderKey[];
};
// Which LLM provider complete() tries first ("primary") and second
// ("fallback") — null means "use the default order" (see registry.ts).
export type LlmTierRoles = { primary: string | null; fallback: string | null };
export type ProviderKeysData = {
  providers: ProviderConfig[];
  tierRoles: LlmTierRoles;
  tierOrder: string[];
};

export async function fetchProviderKeys(token: string): Promise<ProviderKeysData> {
  return apiFetch("/api/v1/settings/keys", {}, token);
}

export type ProviderUsage = {
  id: string;
  label: string;
  status: "ok" | "low" | "out" | "unknown";
  // null when the provider gave no number (credits:read shows exact numbers,
  // plan §7 C).
  remaining: number | null;
  message: string;
};

export async function fetchUsage(token: string): Promise<{ providers: ProviderUsage[] }> {
  return apiFetch("/api/v1/settings/usage", {}, token);
}

export async function createProviderKey(token: string, body: { provider: string; label: string; secret: string }): Promise<ProviderKey> {
  return apiFetch("/api/v1/settings/keys", { method: "POST", body: JSON.stringify(body) }, token);
}

export async function patchProviderKey(token: string, id: string, body: Partial<{
  label: string; priority: number; is_active: boolean; status: ProviderKeyStatus;
}>): Promise<ProviderKey> {
  return apiFetch(`/api/v1/settings/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }, token);
}

export async function deleteProviderKey(token: string, id: string): Promise<{ id: string }> {
  return apiFetch(`/api/v1/settings/keys/${id}`, { method: "DELETE" }, token);
}

export async function reorderProviderKeys(token: string, provider: string, orderedIds: string[]): Promise<void> {
  await apiFetch("/api/v1/settings/keys/reorder", { method: "PUT", body: JSON.stringify({ provider, orderedIds }) }, token);
}

export async function checkProviderKey(token: string, id: string): Promise<{ id: string; ok: boolean; remaining: number | null; message: string }> {
  return apiFetch(`/api/v1/settings/keys/${id}/check`, { method: "POST" }, token);
}

// ─── Settings > Keys > Usage ───────────────────────────────────────────────
// Three dedicated views (Apollo / Instantly / AI) rather than one generic
// list — Apollo and Instantly each have their own live analytics worth a full
// page, and AI reduces to LLM key validity + generation volume.

export type KeyCheck = { ok: boolean; remaining: number | null; message: string };

export type ApolloEndpointUsage = {
  resource: string;
  action: string;
  day: { limit: number; consumed: number; left_over: number };
  hour: { limit: number; consumed: number; left_over: number };
  minute: { limit: number; consumed: number; left_over: number };
};

export type ApolloCreditWindow = { limit: number; consumed: number; left_over: number };

export type ApolloCreditUsageStats = {
  lead_credit: ApolloCreditWindow;
  direct_dial_credit: ApolloCreditWindow;
  export_credit: ApolloCreditWindow;
  conversation_credit: ApolloCreditWindow;
  ai_credit: ApolloCreditWindow;
  power_up_credit: ApolloCreditWindow;
  inbound_website_visitor_credit: ApolloCreditWindow;
  dialer: ApolloCreditWindow;
  web_search_record_credit: ApolloCreditWindow;
  contact_website_visitor_credit: ApolloCreditWindow;
};

export type ApolloCreditCycle = { start_date: string; end_date: string };

export type ApolloUsageHistoryEntry = {
  id: string;
  created_at: string;
  event: string;
  label: string;
  credits_consumed: number;
  matched: number | null;
  archived: number | null;
  verified: number | null;
  unverified: number | null;
  requested: number | null;
  import_id: string | null;
  campaign_id: string | null;
  message: string | null;
  feature: "scored_search" | "company_search" | "email_reveal";
  detail: string | null;
};

export type ApolloFeatureSpend = { credits: number; calls: number };
export type ApolloUsageByFeature = Record<"scored_search" | "company_search" | "email_reveal", ApolloFeatureSpend>;

export type ApolloUsageData = {
  key: KeyCheck;
  allowanceMonthly: number | null;
  consumed: { today: number; week: number; month: number; allTime: number };
  byFeature: { month: ApolloUsageByFeature; allTime: ApolloUsageByFeature };
  remainingThisMonth: number | null;
  daily: { date: string; credits: number }[];
  rateLimits: ApolloEndpointUsage[] | null;
  rateLimitsError: string | null;
  creditUsage: ApolloCreditUsageStats | null;
  creditCycle: ApolloCreditCycle | null;
  creditUsageError: string | null;
  history: ApolloUsageHistoryEntry[];
  ledgerWindowDays: number;
};

export async function fetchApolloUsage(token: string, refresh = false): Promise<ApolloUsageData> {
  const qs = refresh ? "?refresh=1" : "";
  return apiFetch(`/api/v1/settings/keys/usage/apollo${qs}`, {}, token);
}

export async function setApolloCreditAllowance(token: string, allowanceMonthly: number | null): Promise<void> {
  await apiFetch(
    "/api/v1/settings/keys/usage/apollo",
    { method: "PATCH", body: JSON.stringify({ allowanceMonthly }) },
    token,
  );
}

export type InstantlyUsageAccount = {
  email: string;
  status: number;
  daily_limit: number | null;
  first_name: string | null;
  last_name: string | null;
  reason: string | null;
};

export type InstantlyUsageData = {
  key: KeyCheck;
  accounts: {
    data: InstantlyUsageAccount[] | null;
    error: string | null;
    totalDailyCapacity: number;
    activeCount: number;
    totalCount: number;
  };
  overview: {
    data: {
      emails_sent_count?: number;
      open_count_unique?: number;
      reply_count_unique?: number;
      bounced_count?: number;
      leads_count?: number;
    } | null;
    error: string | null;
  };
  daily: {
    data: { date: string; sent?: number; unique_opened?: number; unique_replies?: number }[] | null;
    error: string | null;
  };
};

export async function fetchInstantlyUsage(token: string, refresh = false): Promise<InstantlyUsageData> {
  const qs = refresh ? "?refresh=1" : "";
  return apiFetch(`/api/v1/settings/keys/usage/instantly${qs}`, {}, token);
}

export type AiUsageData = {
  providers: { id: string; label: string; ok: boolean; remaining: number | null; message: string }[];
  tierRoles: { primary: string | null; fallback: string | null };
  volume: {
    windowDays: number;
    totalDrafts: number;
    totalReplies: number;
    totalGenerations: number;
    daily: { date: string; drafts: number; replies: number }[];
  };
};

export async function fetchAiUsage(token: string, refresh = false): Promise<AiUsageData> {
  const qs = refresh ? "?refresh=1" : "";
  return apiFetch(`/api/v1/settings/keys/usage/ai${qs}`, {}, token);
}

export type FirecrawlUsageHistoryEntry = {
  id: string;
  created_at: string;
  event: string;
  label: string;
  domain: string | null;
  chars: number | null;
  message: string | null;
};

export type FirecrawlUsageData = {
  key: KeyCheck & {
    limit?: number | null;
    billingPeriodStart?: string | null;
    billingPeriodEnd?: string | null;
  };
  credits: {
    remaining: number | null;
    planCredits: number | null;
    usedThisCycle: number | null;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
  };
  activity: {
    today: number;
    week: number;
    month: number;
    allTime: number;
    success: number;
    failed: number;
    empty: number;
    cacheHit: number;
  };
  daily: { date: string; scrapes: number; successes: number; failures: number }[];
  history: FirecrawlUsageHistoryEntry[];
  ledgerWindowDays: number;
};

export async function fetchFirecrawlUsage(token: string, refresh = false): Promise<FirecrawlUsageData> {
  const qs = refresh ? "?refresh=1" : "";
  return apiFetch(`/api/v1/settings/keys/usage/firecrawl${qs}`, {}, token);
}

export type JevUsageData = {
  key: KeyCheck;
  companies: { today: number; week: number; month: number; allTime: number };
  tokens: { today: number; week: number; month: number; allTime: number };
  usd: { today: number; week: number; month: number; allTime: number };
  daily: { date: string; companies: number; usd: number }[];
  decisions: Record<string, number>;
  avgTokens: number;
  history: { id: string; created_at: string; name: string; status: string; score: number | null; tokens: number; extra: number }[];
  ledgerWindowDays: number;
};
export async function fetchJevUsage(token: string, refresh = false): Promise<JevUsageData> {
  return apiFetch(`/api/v1/settings/keys/usage/jev${refresh ? "?refresh=1" : ""}`, {}, token);
}

export type TavilyUsageData = {
  key: KeyCheck & { limit?: number | null };
  credits: { remaining: number | null; planCredits: number | null; used: number | null };
  calls: { today: number; week: number; month: number; allTime: number };
  split: { linkedinReads: number; webSearches: number };
  daily: { date: string; linkedin: number; searches: number }[];
  history: { id: string; created_at: string; name: string; linkedinRead: boolean; webSearch: boolean; status: string }[];
  ledgerWindowDays: number;
};
export async function fetchTavilyUsage(token: string, refresh = false): Promise<TavilyUsageData> {
  return apiFetch(`/api/v1/settings/keys/usage/tavily${refresh ? "?refresh=1" : ""}`, {}, token);
}

export type CampaignCreditsData = {
  leads: number; companies: number;
  apollo: { credits: number; exact: boolean };
  firecrawl: { credits: number; exact: boolean };
  jev: { companies: number; tokens: number; usd: number; exact: boolean };
  tavily: { linkedinReads: number; webSearches: number; calls: number; exact: boolean };
  ai: { calls: number; usd: number; tokens: number; failed: number; exact: boolean };
  instantly: { emailsSent: number; openings: number; followUps: number; exact: boolean };
};
export async function fetchCampaignCredits(token: string, campaignId: string): Promise<CampaignCreditsData> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/credits`, {}, token);
}

export async function setProviderModel(token: string, provider: string, model: string | null): Promise<void> {
  await apiFetch("/api/v1/settings/keys/model", { method: "PUT", body: JSON.stringify({ provider, model }) }, token);
}

export async function setLlmTierRoles(token: string, body: { primary: string | null; fallback: string | null }): Promise<LlmTierRoles> {
  return apiFetch("/api/v1/settings/keys/tier", { method: "PUT", body: JSON.stringify(body) }, token);
}

export type ProviderModelOption = { id: string; name: string | null };

/** Live model catalog for an LLM provider, fetched server-side with the
 *  provider's configured key (Settings > Keys model picker). */
export async function fetchProviderModels(token: string, provider: string): Promise<ProviderModelOption[]> {
  const data = await apiFetch<{ models: ProviderModelOption[] }>(
    `/api/v1/settings/keys/models?provider=${encodeURIComponent(provider)}`, {}, token,
  );
  return data.models;
}

export type InstantlySendingAccount = {
  email: string;
  status: number;
  status_label: string;
  can_send: boolean;
  daily_limit?: number | null;
  first_name?: string | null;
  last_name?: string | null;
};

export async function fetchSendingAccounts(token: string): Promise<{
  accounts: InstantlySendingAccount[];
  selected_email: string | null;
  selection_required: boolean;
}> {
  return apiFetch("/api/v1/settings/keys/sending-accounts", {}, token);
}

export async function setSendingAccount(token: string, email: string): Promise<{ selected_email: string }> {
  return apiFetch(
    "/api/v1/settings/keys/sending-accounts",
    { method: "PUT", body: JSON.stringify({ email }) },
    token,
  );
}

export async function fetchLeadActivity(token: string, id: string): Promise<LeadActivityEvent[]> {
  const data = await apiFetch<{ events: LeadActivityEvent[] }>(`/api/v1/leads/${id}/activity`, {}, token);
  return data.events;
}

export type CommentReactionUser = {
  id: string;
  name: string;
};

export type CommentReactionGroup = {
  emoji: string;
  count: number;
  reacted_by_me: boolean;
  users: CommentReactionUser[];
};

export type LeadComment = {
  id: string;
  body: string;
  author_id: string;
  author_name: string;
  created_at: string;
  reactions: CommentReactionGroup[];
};

export async function fetchLeadComments(token: string, id: string): Promise<LeadComment[]> {
  const data = await apiFetch<{ comments: LeadComment[] }>(`/api/v1/leads/${id}/comments`, {}, token);
  return data.comments;
}

export async function postLeadComment(token: string, id: string, body: string): Promise<LeadComment> {
  const data = await apiFetch<{ comment: LeadComment }>(
    `/api/v1/leads/${id}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    token,
  );
  return data.comment;
}

export async function toggleLeadCommentReaction(
  token: string,
  leadId: string,
  commentId: string,
  emoji: string,
): Promise<CommentReactionGroup[]> {
  const data = await apiFetch<{ reactions: CommentReactionGroup[] }>(
    `/api/v1/leads/${leadId}/comments/${commentId}/reactions`,
    { method: "POST", body: JSON.stringify({ emoji }) },
    token,
  );
  return data.reactions;
}

export type CampaignComment = LeadComment;

export async function fetchCampaignComments(token: string, id: string): Promise<CampaignComment[]> {
  const data = await apiFetch<{ comments: CampaignComment[] }>(
    `/api/v1/campaigns/${id}/comments`,
    {},
    token,
  );
  return data.comments;
}

export async function postCampaignComment(
  token: string,
  id: string,
  body: string,
): Promise<CampaignComment> {
  const data = await apiFetch<{ comment: CampaignComment }>(
    `/api/v1/campaigns/${id}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    token,
  );
  return data.comment;
}

export async function toggleCampaignCommentReaction(
  token: string,
  campaignId: string,
  commentId: string,
  emoji: string,
): Promise<CommentReactionGroup[]> {
  const data = await apiFetch<{ reactions: CommentReactionGroup[] }>(
    `/api/v1/campaigns/${campaignId}/comments/${commentId}/reactions`,
    { method: "POST", body: JSON.stringify({ emoji }) },
    token,
  );
  return data.reactions;
}

export async function patchLead(token: string, id: string, body: {
  first_name?: string; last_name?: string; email?: string; phone?: string;
  title?: string; headline?: string; linkedin_url?: string;
  city?: string; state?: string; country?: string; email_status?: string;
  // Manager-only single-lead reassignment; null returns the lead to the pool.
  assigned_to?: string | null;
}): Promise<Lead & { manual_target_offline?: boolean }> {
  const data = await apiFetch<DbLead & { manual_target_offline?: boolean }>(`/api/v1/leads/${id}`, { method: "PATCH", body: JSON.stringify(body) }, token);
  return { ...mapDbLead(data), manual_target_offline: data.manual_target_offline };
}

export async function deleteLead(token: string, id: string): Promise<{ deleted: string }> {
  return apiFetch(`/api/v1/leads/${id}`, { method: "DELETE" }, token);
}

export async function bulkDeleteLeads(token: string, ids: string[]): Promise<{ deleted: number }> {
  // The route takes max 500 ids per call, so send in chunks.
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const r = await apiFetch<{ deleted: number }>("/api/v1/leads/bulk-delete", {
      method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 500) }),
    }, token);
    deleted += r.deleted;
  }
  return { deleted };
}

export type BulkAssignStrategy = "manual" | "round_robin" | "territory";

// Mirror of the server AssignmentSummary (spec §3/§4).
export type AssignmentSummary = {
  total: number;
  newly_assigned: number;
  reassigned: number;
  skipped_already_assigned: number;
  skipped_not_ready: number;
  unmatched: number;
  eligible_employee_count: number;
  excluded_offline: number;
  excluded_deactivated: number;
  manual_target_offline: boolean;
};

export async function bulkAssignLeads(
  token: string,
  ids: string[],
  strategy: BulkAssignStrategy,
  assignedTo?: string | null,
  skipAlreadyAssigned = false,
): Promise<AssignmentSummary> {
  const body = strategy === "manual"
    ? { strategy, ids, assigned_to: assignedTo ?? null, skip_already_assigned: skipAlreadyAssigned }
    : { strategy, ids, skip_already_assigned: skipAlreadyAssigned };
  return apiFetch("/api/v1/leads/bulk-assign", { method: "POST", body: JSON.stringify(body) }, token);
}

export async function deleteCampaign(token: string, id: string): Promise<{ deleted: string }> {
  return apiFetch(`/api/v1/campaigns/${id}`, { method: "DELETE" }, token);
}

export async function pauseCampaign(token: string, id: string): Promise<{ paused: number; errors: string[] }> {
  return apiFetch(`/api/v1/campaigns/${id}/pause`, { method: "POST" }, token);
}

export async function resumeCampaign(token: string, id: string): Promise<{ resumed: number; errors: string[] }> {
  return apiFetch(`/api/v1/campaigns/${id}/resume`, { method: "POST" }, token);
}

/**
 * Hold sending — stops Instantly sending anything further on this campaign,
 * including follow-ups already queued, until someone resumes it.
 *
 * Mechanically a pause (Instantly has no per-step pause), but it also records
 * who held it and when, which is what drives the banner. Releasing goes through
 * resumeCampaign, which clears the same stamp.
 */
export async function holdCampaignSending(token: string, id: string): Promise<{ paused: number; errors: string[] }> {
  return apiFetch(`/api/v1/campaigns/${id}/hold`, { method: "POST" }, token);
}

/** Assign a whole campaign to one employee (null returns it to the pool). */
export async function assignCampaign(
  token: string,
  id: string,
  assignedTo: string | null,
  reassignLeads: boolean,
): Promise<{ campaign_id: string; assigned_to: string | null; previous_assignee: string | null; changed: boolean; leads_reassigned: number; manual_target_offline: boolean }> {
  return apiFetch(`/api/v1/campaigns/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ assigned_to: assignedTo, reassign_leads: reassignLeads }),
  }, token);
}

export async function fetchOrg(token: string, id: string): Promise<Record<string, unknown>> {
  return apiFetch(`/api/v1/organizations/${id}`, {}, token);
}

export async function patchOrg(token: string, id: string, body: {
  name?: string; domain?: string; website?: string; description?: string;
  industry?: string; city?: string; country?: string;
  company_description?: string; sells_to?: string;
}): Promise<Record<string, unknown>> {
  return apiFetch(`/api/v1/organizations/${id}`, { method: "PATCH", body: JSON.stringify(body) }, token);
}

export async function rescrapeOrg(token: string, orgId: string): Promise<{ id: string; queued_for_rescrape: boolean }> {
  return apiFetch(`/api/v1/organizations/${orgId}/rescrape`, { method: "POST" }, token);
}

/** Requeues every org that failed enrichment but still has retry attempts left. */
export async function retryAllFailedEnrichment(token: string): Promise<{ requeued: number }> {
  return apiFetch(`/api/enrich/retry-all`, { method: "POST" }, token);
}

export async function createLead(token: string, body: {
  email: string; first_name?: string; last_name?: string;
  organization_name: string; organization_domain?: string;
  organization_industry?: string; organization_country?: string;
  title?: string; country?: string;
  batch_name?: string; color?: string; import_id?: string;
  assigned_to?: string;
}): Promise<Lead & { import_id?: string | null }> {
  const data = await apiFetch<DbLead & { import_id?: string | null }>("/api/v1/leads", { method: "POST", body: JSON.stringify(body) }, token);
  return { ...mapDbLead(data), import_id: data.import_id };
}

// How an import distributes its leads: a manual target, a spread strategy, or
// neither (pool). The server treats them independently; callers set at most one.
export type ImportAssignment = {
  assigned_to?: string;
  assignment_strategy?: "manual" | "round_robin" | "territory";
};

// A duplicate skipped on import, with who already owns it — so the importer
// isn't just told "skipped" with no idea the lead belongs to someone else
// (review §3.3). `assigned_to` is a profile id; resolve to a name client-side
// against an already-loaded employee list.
export type DuplicateOwner = { email?: string; name?: string; company?: string; assigned_to: string | null };

export async function importExcelDirect(
  token: string,
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  batch_name: string,
  color = "violet",
  assignment: ImportAssignment = {},
  choices?: ImportChoices,
): Promise<ImportResult> {
  return apiFetch("/api/v1/leads/import-excel", {
    method: "POST",
    body: JSON.stringify({ mode: "direct", rows, mapping, batch_name, color, ...assignment, ...(choices && Object.keys(choices).length ? { choices } : {}) }),
  }, token);
}

export type PreviewLead = { firstName: string; lastName: string; email: string; company: string; jobTitle: string; domain?: string };

export type ApolloPeopleAdvanced = {
  titles?: string[]; includeSimilarTitles?: boolean; seniorities?: string[];
  organizationLocations?: string[]; domains?: string[]; employeeRanges?: string[];
  revenueMin?: number; revenueMax?: number;
  technologyAll?: string[]; technologyAny?: string[]; technologyNot?: string[];
  jobTitles?: string[]; jobLocations?: string[];
  numJobsMin?: number; numJobsMax?: number;
  jobPostedAtMin?: string; jobPostedAtMax?: string;
};

export async function apolloPreview(token: string, body: {
  keywords: string[]; locations: string[];
  titles?: string[]; seniorities?: string[]; batch_name: string; color?: string;
  advanced?: ApolloPeopleAdvanced;
}): Promise<{
  preview: true;
  leads: PreviewLead[];
  /** How many people the term can reach at all. 0 means the wording found
   *  nothing — see `suggestion`. */
  total_entries?: number;
  /** A wording that does work, when the one asked for returned nothing. */
  suggestion?: { term: string; count: number } | null;
}> {
  return apiFetch("/api/v1/leads/apollo-search", {
    method: "POST",
    body: JSON.stringify({ ...body, preview: true }),
  }, token);
}

export async function apolloSearch(token: string, body: {
  keywords: string[]; locations: string[];
  titles?: string[]; seniorities?: string[]; batch_name: string; color?: string;
  assigned_to?: string; assignment_strategy?: "manual" | "round_robin" | "territory";
  advanced?: ApolloPeopleAdvanced;
}): Promise<{ inserted: number; skipped: number; orgs_created: number; assignment_skipped?: number; duplicate_owners?: DuplicateOwner[] }> {
  return apiFetch("/api/v1/leads/apollo-search", { method: "POST", body: JSON.stringify(body) }, token);
}

// ─── Drafts & campaign send ───────────────────────────────────────────────────

export async function triggerDraftGeneration(token: string, campaignId: string): Promise<{ queued: boolean; lead_count: number }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/generate-drafts`, { method: "POST" }, token);
}

/** Give every lead still waiting for an opening email the default email (no AI). Repeat until remaining is 0. */
export async function applyDefaultDrafts(token: string, campaignId: string): Promise<{ written: number; remaining: number }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/use-default-drafts`, { method: "POST" }, token);
}

/** Take leads out of this campaign. Leads already sent to are skipped by the server. */
export async function removeCampaignLeads(token: string, campaignId: string, campaignLeadIds: string[]): Promise<{ removed: number; skipped: number }> {
  // The route takes max 1000 ids per call, so send in chunks.
  const total = { removed: 0, skipped: 0 };
  for (let i = 0; i < campaignLeadIds.length; i += 1000) {
    const r = await apiFetch<{ removed: number; skipped: number }>(`/api/v1/campaigns/${campaignId}/leads/remove`, {
      method: "POST", body: JSON.stringify({ campaign_lead_ids: campaignLeadIds.slice(i, i + 1000) }),
    }, token);
    total.removed += r.removed;
    total.skipped += r.skipped;
  }
  return total;
}

/** Can the main AI model write emails right now? Asked before creating a campaign. */
export async function checkAiReadiness(token: string, campaignName: string): Promise<{ available: boolean; model: string }> {
  return apiFetch(`/api/v1/ai-readiness`, { method: "POST", body: JSON.stringify({ campaign_name: campaignName }) }, token);
}

export async function kickDraftGeneration(token: string, campaignId: string): Promise<{ kicked: boolean }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/generate-drafts/kick`, { method: "POST" }, token);
}

export async function fetchDraftProgress(token: string, campaignId: string): Promise<{
  total: number; generating: number; draft: number; approved: number; sent: number; failed: number; pending: number;
  /** False while leads are waiting and the main AI model has no credits. */
  ai_available?: boolean;
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/draft-progress`, {}, token);
}

export async function approveDraft(token: string, draftId: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "approve" }),
  }, token);
}

export async function bulkApproveDrafts(token: string, draftIds: string[]): Promise<{ approved: number; skipped: number }> {
  // The route takes max 200 ids per call (lib/validators/drafts.ts), so send in chunks.
  const total = { approved: 0, skipped: 0 };
  for (let i = 0; i < draftIds.length; i += 200) {
    const r = await apiFetch<{ approved: number; skipped: number }>("/api/v1/drafts/bulk-approve", {
      method: "POST",
      body: JSON.stringify({ draft_ids: draftIds.slice(i, i + 200) }),
    }, token);
    total.approved += r.approved;
    total.skipped += r.skipped;
  }
  return total;
}

export type RegenerationSkipped = { certified: number; sent: number; no_draft: number; customized: number; other: number };

export type RegenerationJobStatus = {
  id: string;
  campaign_id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  step_number: number;
  custom_instruction: string | null;
  total: number;
  succeeded: number;
  failed: number;
  processed: number;
  active: boolean;
  /** Whether sending is still held on the campaign - a finished run releases
   *  the hold it was started under, and the banner needs to know. */
  sending_held: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Stamped at the start and end of every batch. A live job whose heartbeat
   *  is a minute old has lost its chain (the platform drops a self-chain after
   *  five hops) and needs a kick from outside. */
  heartbeat_at: string | null;
};

/** What a bulk regeneration would touch, and what it would leave alone. */
export async function previewRegeneration(
  token: string,
  campaignId: string,
  campaignLeadIds?: string[],
  stepNumber?: number,
): Promise<{ eligible: number; by_status: { draft: number; failed: number; approved: number }; skipped: RegenerationSkipped }> {
  // POST, not GET: ~350+ selected ids no longer fit in a URL.
  return apiFetch(`/api/v1/campaigns/${campaignId}/regenerate-drafts`, {
    method: "POST",
    body: JSON.stringify({
      preview: true,
      ...(campaignLeadIds?.length ? { campaign_lead_ids: campaignLeadIds } : {}),
      ...(stepNumber && stepNumber > 1 ? { step_number: stepNumber } : {}),
    }),
  }, token);
}

/** Queue a background bulk regeneration. Omit ids to cover every eligible lead. */
export async function regenerateCampaignDrafts(
  token: string,
  campaignId: string,
  opts?: { campaignLeadIds?: string[]; customInstruction?: string; stepNumber?: number },
): Promise<{ job_id: string; total: number; skipped: RegenerationSkipped }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/regenerate-drafts`, {
    method: "POST",
    body: JSON.stringify({
      ...(opts?.campaignLeadIds?.length ? { campaign_lead_ids: opts.campaignLeadIds } : {}),
      ...(opts?.customInstruction ? { custom_instruction: opts.customInstruction } : {}),
      ...(opts?.stepNumber && opts.stepNumber > 1 ? { step_number: opts.stepNumber } : {}),
    }),
  }, token);
}

export async function fetchRegenerationJob(token: string, campaignId: string): Promise<{ job: RegenerationJobStatus | null }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/regeneration-job`, {}, token);
}

/** Re-kick a bulk regeneration whose batch chain has gone quiet. Safe to call
 *  freely: the server only acts on a job with no heartbeat for a minute. */
export async function kickRegenerationJob(token: string, campaignId: string): Promise<{ kicked: boolean }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/regeneration-job/kick`, { method: "POST" }, token);
}

export async function cancelRegenerationJob(token: string, campaignId: string): Promise<{ job_id: string; cancelled: boolean; remaining: number }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/regeneration-job/cancel`, { method: "POST" }, token);
}

export async function editDraft(token: string, draftId: string, subject: string, body: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "edit", subject, body }),
  }, token);
}

export async function regenerateDraft(token: string, draftId: string, customInstruction?: string): Promise<{
  draft: { id: string; subject: string | null; body: string | null; status: string; version?: number };
}> {
  return apiFetch(`/api/v1/drafts/${draftId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ custom_instruction: customInstruction }),
  }, token);
}

export async function reopenDraft(token: string, draftId: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "reopen" }),
  }, token);
}

export async function fetchDraftHistory(token: string, draftId: string): Promise<{
  versions: Array<{ id: string; subject: string | null; body: string | null; status: string; version: number; created_at: string }>;
}> {
  return apiFetch(`/api/v1/drafts/${draftId}/history`, {}, token);
}

export async function fetchDraftSiblings(token: string, draftId: string): Promise<{
  siblings: Array<{ id: string; step_number: number; subject: string | null; body: string | null; status: string; created_at: string }>;
}> {
  return apiFetch(`/api/v1/drafts/${draftId}/siblings`, {}, token);
}

export async function restoreDraftVersion(token: string, draftId: string): Promise<{ id: string; status: string }> {
  return apiFetch(`/api/v1/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "restore" }),
  }, token);
}

export async function sendApprovedLeads(
  token: string,
  campaignId: string,
  opts?: { campaignLeadIds?: string[] },
  /** Per-country failures from a PARTIAL send. Empty on a clean run.
   *  Optional so an older server response still type-checks. */
): Promise<{ buckets: number; sent: number; errors?: string[] }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/send`, {
    method: "POST",
    ...(opts?.campaignLeadIds?.length
      ? { body: JSON.stringify({ campaign_lead_ids: opts.campaignLeadIds }) }
      : {}),
  }, token);
}

export async function setCampaignLeadStatus(
  token: string,
  campaignId: string,
  campaignLeadId: string,
  crmStatus: "won" | "closed" | "replied" | "new" | "enriched" | "draft" | "approved" | "sent" | "failed" | "skipped",
): Promise<{ id: string; crm_status: string }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/leads`, {
    method: "PATCH",
    body: JSON.stringify({ campaign_lead_id: campaignLeadId, crm_status: crmStatus }),
  }, token);
}

/**
 * Retry every failed draft in a campaign.
 *
 * This used to loop on the client, awaiting one regenerate call per lead — which
 * meant a long campaign's retry died the moment the tab closed. It now queues the
 * same background job the outbox's bulk Regenerate uses, so it returns at once
 * and survives a closed browser.
 */
export async function retryFailedDrafts(token: string, campaignId: string): Promise<{ retried: number; errors: string[] }> {
  const { campaign_leads } = await fetchCampaignLeads(token, campaignId);
  const failedIds = campaign_leads
    .filter((cl) => cl.email_drafts?.status === "failed" && cl.email_drafts?.id)
    .map((cl) => cl.id);
  if (failedIds.length === 0) return { retried: 0, errors: [] };

  try {
    const { total } = await regenerateCampaignDrafts(token, campaignId, { campaignLeadIds: failedIds });
    return { retried: total, errors: [] };
  } catch (e) {
    return { retried: 0, errors: [(e as Error).message] };
  }
}

export async function fetchCampaignReport(token: string, campaignId: string): Promise<{
  campaignId: string;
  totals: {
    leads: number;
    draftsGenerated: number;
    certified: number;
    /** Delivered and nothing more — excludes replied and bounced. */
    sent: number;
    /** Every lead a mail reached: sent + replied + bounced. Reply rate's base. */
    delivered: number;
    replied: number;
    bounced: number;
    failed: number;
  };
  rates: { replyRate: number; certifyRate: number };
  draftGeneration: {
    total: number;
    pending: number;
    generating: number;
    succeeded: number;
    failed: number;
    successRate: number;
  };
  stageDistribution: Array<{ stage: string; label: string; count: number }>;
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/report`, {}, token);
}

export type CampaignLlmCost = {
  totalCostUsd: number;
  /** false when every row so far has an unpriced model — 0 would misread as "free". */
  hasKnownCost: boolean;
  totalCalls: number;
  failedCalls: number;
  unknownCostCalls: number;
  totalTokens: number;
  purposes: Array<{
    purpose: string;
    label: string;
    /** e.g. "claude-sonnet-4.6" — one row per purpose+model, since a fallback
     *  tier means a single purpose can be served by more than one model. */
    model: string;
    calls: number;
    costUsd: number;
    hasUnknownCost: boolean;
    tokens: number;
  }>;
  /** llm_usage only started recording on this date — see the route's comment. */
  trackingStartedAt: string;
};

/** LLM/model spend attributed to this campaign. Apollo and Firecrawl spend are
 *  not included — neither is attributed per-campaign in the data model yet. */
export async function fetchCampaignLlmCost(token: string, campaignId: string): Promise<CampaignLlmCost> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/llm-cost`, {}, token);
}

export async function fetchSettings(token: string): Promise<Record<string, string>> {
  return apiFetch("/api/v1/settings", {}, token);
}

export async function patchSettings(token: string, body: Record<string, string>): Promise<Record<string, string>> {
  return apiFetch("/api/v1/settings", { method: "PATCH", body: JSON.stringify(body) }, token);
}

/** Adds ONE keyword to ONE Industry Segments group on the server, safe against a teammate adding at the
 *  same moment. Refusals (duplicate, group removed) throw with `code` and `details.groups` (the saved list). */
export async function addIndustryKeyword(token: string, body: { group_id: string; label: string; query: string }): Promise<{ groups: IndustryKeywordGroup[] }> {
  return apiFetch("/api/v1/settings/industry-keywords", { method: "POST", body: JSON.stringify(body) }, token);
}

// ─── Per-user settings (personal prompt / signature / sender / theme) ─────────

export type MySettings = {
  draft_prompt: string | null;
  draft_template: string | null;
  reply_prompt: string | null;
  signature: string | null;
  sender_name: string | null;
  theme: string | null;
  theme_mode: string | null;
  /** The company owner (holds every permission). */
  is_owner: boolean;
  /** The member's ticked permissions (profiles.scopes). */
  scopes: Scope[];
  defaults: {
    draft_prompt: string;
    reply_prompt: string;
    signature: string;
    sender_name: string;
  };
};

export async function fetchMySettings(token: string): Promise<MySettings> {
  return apiFetch("/api/v1/me/settings", {}, token);
}

/** null (or "") clears a field back to "inherit the company default". */
export async function patchMySettings(
  token: string,
  body: Partial<Record<"draft_prompt" | "draft_template" | "reply_prompt" | "signature" | "sender_name" | "theme" | "theme_mode", string | null>>,
): Promise<MySettings> {
  return apiFetch("/api/v1/me/settings", { method: "PATCH", body: JSON.stringify(body) }, token);
}

// ─── Team members / assignment ────────────────────────────────────────────────

export type AvailabilityStatus = "online" | "offline";

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  /** Canonical country names this lead owner receives leads for. Empty = no territory. */
  territory_countries: string[];
  is_active: boolean;
  availability_status: AvailabilityStatus;
  /** Instantly mailbox this person's leads are mailed from. null = company default. */
  sending_email: string | null;
  created_at: string;
  /** The company owner: holds every permission whatever `scopes` says. */
  is_owner: boolean;
  /** Ticked permissions (profiles.scopes), in SCOPES order. */
  scopes: Scope[];
};

/** A profile as the pure permission helpers (lib/auth/scopes.ts) see it. */
export function profileMember(p: Pick<Profile, "id" | "is_owner" | "is_active" | "scopes">): Member {
  return { id: p.id, isOwner: p.is_owner, active: p.is_active, scopes: p.scopes ?? [] };
}

export async function fetchUsers(token: string): Promise<Profile[]> {
  return apiFetch("/api/v1/settings/users", {}, token);
}

export async function createUser(token: string, body: {
  email: string; password: string; full_name: string; scopes: Scope[]; territory_countries?: string[];
}): Promise<Profile> {
  return apiFetch("/api/v1/settings/users", { method: "POST", body: JSON.stringify(body) }, token);
}

// Where a deactivated employee's leads and campaigns go. "pool" is the only one
// that works when no other employee is available to take them.
export type HandoverStrategy = "manual" | "pool" | "round_robin" | "territory";

export type HandoverSummary = {
  strategy: HandoverStrategy;
  leads_total: number;
  leads_reassigned: number;
  leads_to_pool: number;
  campaigns_total: number;
  campaigns_reassigned: number;
  campaigns_to_pool: number;
  eligible_employee_count: number;
  per_assignee: { employee_id: string; leads: number; campaigns: number }[];
};

export async function patchUser(token: string, id: string, body: Partial<{
  full_name: string; scopes: Scope[]; territory_countries: string[]; is_active: boolean; availability_status: AvailabilityStatus; password: string; handover_strategy: HandoverStrategy; reassign_to: string; sending_email: string | null;
}>): Promise<Profile & { handover?: HandoverSummary }> {
  return apiFetch(`/api/v1/settings/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }, token);
}

// Self-service availability (spec §2B) — mark yourself online/offline.
export async function fetchMyAvailability(token: string): Promise<{ availability_status: AvailabilityStatus }> {
  return apiFetch("/api/v1/me/availability", {}, token);
}

export async function setMyAvailability(token: string, availability_status: AvailabilityStatus): Promise<{ availability_status: AvailabilityStatus }> {
  return apiFetch("/api/v1/me/availability", { method: "PATCH", body: JSON.stringify({ availability_status }) }, token);
}

// Auto-assignment default for newly-enriched pool leads (settings:write).
export async function fetchAssignmentSettings(token: string): Promise<{ strategy: "manual" | "round_robin" | "territory" }> {
  return apiFetch("/api/v1/settings/assignment", {}, token);
}

export async function patchAssignmentSettings(
  token: string,
  strategy: "manual" | "round_robin" | "territory",
): Promise<{ strategy: string }> {
  return apiFetch("/api/v1/settings/assignment", { method: "PATCH", body: JSON.stringify({ strategy }) }, token);
}

/** A profile as the oversight route returns it: no permission fields (is_owner / scopes). */
type OversightProfile = Pick<Profile, "id" | "email" | "full_name" | "territory_countries" | "is_active" | "availability_status">;

/** dashboard:all. `employees` = lead owners (isLeadOwner), with their workload counts. */
export async function fetchOversight(token: string): Promise<{
  campaigns: Array<{ id: string; name: string; status: string; created_by: string; total_leads: number; sent_count: number; opened_count: number; replied_count: number; hot_count: number; created_at: string; owner: OversightProfile | null }>;
  employees: Array<OversightProfile & { assigned_lead_count: number; campaign_count: number }>;
}> {
  return apiFetch("/api/v1/dashboard/oversight", {}, token);
}

export async function fetchLogo(token: string): Promise<{ logo_path: string | null; logo_url: string | null }> {
  return apiFetch("/api/v1/settings/logo", {}, token);
}

export async function uploadLogo(token: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/v1/settings/logo", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Upload failed");
  return json.data as {
    logo_path: string;
    logo_url: string | null;
    logo_name: string;
    logo_mime: string;
    logo_size: number;
  };
}

export async function removeLogo(token: string): Promise<{ cleared: boolean }> {
  const res = await fetch("/api/v1/settings/logo", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Remove failed");
  return json.data as { cleared: boolean };
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function fetchCampaigns(token: string): Promise<Campaign[]> {
  const data = await apiFetch<{ campaigns: Parameters<typeof mapDbCampaignFull>[0][] }>("/api/v1/campaigns", {}, token);
  // lib/mappers' mapper: the same one the old server-rendered Campaigns page
  // used, so attachmentName / assignedTo (the owner filter) are kept.
  return data.campaigns.map(mapDbCampaignFull);
}

export async function fetchCampaignSteps(token: string, campaignId: string): Promise<{
  steps: Array<CampaignStepInput & { id: string }>;
  followup_instruction?: string | null;
  followups_ai_enabled?: boolean;
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/steps`, {}, token);
}

export async function saveCampaignSteps(
  token: string,
  campaignId: string,
  steps: CampaignStepInput[],
  /** Campaign-wide follow-up guidance. Omit to leave whatever is stored
   *  untouched — the Options tab has no such box and must not blank it. */
  followupInstruction?: string | null,
  /** Omit to leave the campaign's AI follow-up switch untouched. */
  followupsAiEnabled?: boolean,
): Promise<{
  updated: boolean;
  /** False when the change is held back until the follow-ups it makes due have
   *  been written — Instantly keeps the OLD schedule until then, so it cannot
   *  send boilerplate into the gap. */
  published?: boolean;
  /** How many follow-ups are being written before the change goes live. */
  preparing?: number;
  /** Per step whose default text changed: unsent default-text follow-ups rewritten. */
  refreshed?: { step: number; updated: number; alreadySent: number; kept: number; pushFailed: number }[];
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/steps`, {
    method: "PUT",
    body: JSON.stringify({
      steps,
      ...(followupInstruction !== undefined ? { followup_instruction: followupInstruction } : {}),
      ...(followupsAiEnabled !== undefined ? { followups_ai_enabled: followupsAiEnabled } : {}),
    }),
  }, token);
}

export async function patchCampaignConfig(
  token: string,
  campaignId: string,
  patch: {
    name?: string;
    daily_limit?: number;
    window_from?: string;
    window_to?: string;
    send_days?: Record<string, boolean>;
    schedule_timezone?: string;
    sender_name?: string;
    ai_prompt_context?: string;
  },
): Promise<{ updated: boolean; sync_errors: string[] }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/config`, { method: "PATCH", body: JSON.stringify(patch) }, token);
}

// Isolated from the step-1 draft's regenerate/generation pipeline entirely —
// see app/api/v1/campaigns/[id]/followup-regenerate/route.ts.
export async function regenerateFollowUpDraft(
  token: string,
  campaignId: string,
  campaignLeadId: string,
  stepNumber: number,
  currentBody: string,
  instruction: string,
): Promise<{ draft: { id: string; subject: string | null; body: string | null; status: string } }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/followup-regenerate`, {
    method: "POST",
    body: JSON.stringify({
      campaign_lead_id: campaignLeadId,
      step_number: stepNumber,
      body: currentBody,
      instruction,
    }),
  }, token);
}

export async function regenerateFollowUpStepTemplate(
  token: string,
  campaignId: string,
  stepNumber: number,
  currentBody: string,
  instruction?: string,
): Promise<{ body: string }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/followup-step-regenerate`, {
    method: "POST",
    body: JSON.stringify({
      step_number: stepNumber,
      body: currentBody,
      instruction,
    }),
  }, token);
}

// Save for a follow-up: persist + approve + sync to Instantly in one action.
// Deliberately separate from editDraft/approveDraft (the step-1 draft's
// PATCH .../drafts/[id] flow), whose "edit" action requires a non-empty
// subject — follow-ups are always empty (they thread as a reply).
export async function saveFollowUpDraft(
  token: string,
  campaignId: string,
  campaignLeadId: string,
  stepNumber: number,
  subject: string,
  body: string,
): Promise<{
  draft: { id: string; subject: string | null; body: string | null; status: string };
  instantly_sync: { attempted: boolean; synced: boolean; error?: string };
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/followup-save`, {
    method: "POST",
    body: JSON.stringify({ campaign_lead_id: campaignLeadId, step_number: stepNumber, subject, body }),
  }, token);
}

export async function createCampaign(token: string, body: {
  name: string; human_in_loop: boolean;
  daily_limit?: number; window_from?: string; window_to?: string;
  schedule_timezone?: string; send_days?: Record<string, boolean>;
  send_mode?: "now" | "scheduled"; schedule_start_at?: string;
  ai_prompt_context?: string; sender_name?: string;
  followup_steps?: { delay: number; delay_unit: "minutes" | "hours" | "days" }[];
  attachments?: { path: string; name: string; mime: string; size: number }[];
}): Promise<DbCampaign> {
  return apiFetch<DbCampaign>("/api/v1/campaigns", { method: "POST", body: JSON.stringify(body) }, token);
}

// The file goes browser -> Supabase Storage on a signed upload URL our route hands out,
// then the route checks it and signs the link. Through our API it broke above 4.5 MB
// (Vercel's request body cap).
// The SHA-256 lets the server reuse a copy it already holds (exists: true -> no upload).
async function uploadAttachmentFile<T>(token: string, route: string, file: File): Promise<T> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const { path, token: uploadToken, exists } = await apiFetch<{ path: string; token: string | null; exists: boolean }>(route, {
    method: "POST", body: JSON.stringify({ name: file.name, type: file.type, size: file.size, sha256 }),
  }, token);
  if (!exists && uploadToken) {
    const { supabase } = await import("@/lib/supabase");
    const { error } = await supabase.storage.from("campaign-attachments")
      .uploadToSignedUrl(path, uploadToken, file, { contentType: file.type });
    // Same file uploaded by someone else a moment ago: the copy is there, carry on.
    if (error && !/exists|duplicate/i.test(error.message)) throw new Error(`Upload failed: ${error.message}`);
  }
  return apiFetch<T>(route, { method: "POST", body: JSON.stringify({ finish: true, path, name: file.name }) }, token);
}

export async function uploadCampaignAttachment(token: string, file: File) {
  return uploadAttachmentFile<{
    attachment_path: string; attachment_name: string;
    attachment_mime: string; attachment_size: number; attachment_url: string | null;
  }>(token, "/api/v1/campaigns/attachment", file);
}

export async function fetchCampaignLeads(token: string, campaignId: string): Promise<{
  campaign_leads: {
    id: string; lead_id: string; crm_status: string; created_at: string;
    leads: { first_name: string | null; last_name: string | null; email: string | null; title: string | null; country: string | null } | null;
    /** `body` is absent in the list (`?view=list`); fetchCampaignLeadDetail has it. */
    email_drafts: { id: string; subject: string | null; body?: string | null; status: string; step_number?: number | null } | null;
  }[];
  total: number;
  /** Tab badges (list view only). */
  comment_count?: number;
  pending_reply_count?: number;
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/leads?view=list`, {}, token);
}

/** One campaign lead with everything the list leaves out: the draft and
 *  follow-up bodies and the sent thread. Fetched when that lead is opened. */
export async function fetchCampaignLeadDetail(token: string, campaignId: string, campaignLeadId: string): Promise<{
  campaign_leads: Awaited<ReturnType<typeof fetchCampaignLeads>>["campaign_leads"];
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/leads?campaign_lead_id=${encodeURIComponent(campaignLeadId)}`, {}, token);
}

export async function addLeadsToCampaign(token: string, campaignId: string, leadIds: string[]): Promise<{
  added: string[]; not_found: string[]; blocked_unsubscribed: string[]; skipped_existing: string[];
  also_in_other_campaigns?: Array<{ lead_id: string; campaign_id: string; campaign_name: string }>;
}> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/leads`, {
    method: "POST",
    body: JSON.stringify({ lead_ids: leadIds }),
  }, token);
}

/** Swap a bounced contact for another address at the same company. Creates (or
 *  reuses) the lead, adds it to this campaign and starts its draft. */
export async function replaceBouncedLead(token: string, campaignLeadId: string, body: {
  email: string; first_name: string; last_name?: string; title?: string;
}): Promise<{ lead_id: string; campaign_lead_id: string }> {
  return apiFetch(`/api/v1/campaign-leads/${campaignLeadId}/replace`, {
    method: "POST",
    body: JSON.stringify(body),
  }, token);
}

// ─── Imports / Batches ────────────────────────────────────────────────────────

export interface ImportBatch {
  id: string;
  label: string;
  source: string;
  lead_count: number;
  color: string;
  created_at: string;
}

export async function fetchImports(token: string): Promise<{ imports: ImportBatch[] }> {
  return apiFetch("/api/v1/imports", {}, token);
}

export async function renameImport(token: string, id: string, label: string): Promise<{ id: string; label: string }> {
  return apiFetch(`/api/v1/imports/${id}`, { method: "PATCH", body: JSON.stringify({ label }) }, token);
}

// ─── Per-admin Signature ──────────────────────────────────────────────────────

export async function fetchMySignature(token: string): Promise<{ full_name: string; title: string; contact: string; email: string }> {
  return apiFetch("/api/v1/settings/signature", {}, token);
}

export async function saveMySignature(token: string, sig: { full_name: string; title: string; contact: string }): Promise<{ saved: boolean }> {
  return apiFetch("/api/v1/settings/signature", { method: "PUT", body: JSON.stringify(sig) }, token);
}

export type CampaignFile = { path: string; name: string; mime: string; size: number };

export async function fetchCampaignAttachments(token: string, campaignId: string): Promise<{ attachments: CampaignFile[] }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/attachments`, {}, token);
}

/** Replace the campaign's files; unsent opening drafts get the new links. */
export async function saveCampaignAttachments(token: string, campaignId: string, attachments: CampaignFile[]): Promise<{ attachments: CampaignFile[]; drafts_updated: number }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/attachments`, { method: "PUT", body: JSON.stringify({ attachments }) }, token);
}

// ─── Per-lead Attachment Override ──────────────────────────────────────────────

export async function uploadCampaignLeadAttachment(
  token: string,
  campaignLeadId: string,
  file: File,
): Promise<{ attachment_name: string; attachment_size: number; attachment_mime: string; attachment_url: string | null }> {
  return uploadAttachmentFile(token, `/api/v1/campaign-leads/${campaignLeadId}/attachment`, file);
}

/** Removes one of the lead's own files (by storage path). */
export async function removeCampaignLeadAttachment(
  token: string,
  campaignLeadId: string,
  path: string,
): Promise<{ cleared: boolean }> {
  return apiFetch(`/api/v1/campaign-leads/${campaignLeadId}/attachment?path=${encodeURIComponent(path)}`, { method: "DELETE" }, token);
}

// ─── Reply drafts ────────────────────────────────────────────────────────────

export interface ReplyDraft {
  id: string;
  reply_event_id: string;
  campaign_lead_id: string | null;
  campaign_id: string | null;
  subject: string | null;
  body: string | null;
  status: "generating" | "draft" | "approved" | "sent" | "failed" | "rejected";
  reply_to_uuid: string | null;
  eaccount: string | null;
  version: number;
  sent_at: string | null;
  error: string | null;
}

export interface ThreadMessage {
  id: string;
  event_type: string;
  reply_body: string | null;
  received_at: string;
  reply_drafts: ReplyDraft[];
  /** Real headers — the sender is not always the lead once someone is CC'd. */
  instantly_email_id: string;
  from_email: string | null;
  to_emails: string | null;
  cc_emails: string | null;
}

/** An outbound reply as actually sent, headers included. */
export interface SentThreadMessage {
  id: string;
  instantly_email_id: string;
  from_email: string | null;
  to_emails: string | null;
  cc_emails: string | null;
  body_html: string | null;
  body_text: string | null;
  sent_at: string;
  sent_by_name: string | null;
  /** Which message this reply answered. */
  in_reply_to_email_id: string | null;
}

export interface CampaignReplyThread {
  thread_key: string;
  campaign_lead_id: string | null;
  lead_email: string;
  lead: { first_name: string | null; last_name: string | null; email: string | null; title: string | null } | null;
  latest_temperature: string | null;
  original_email: { subject: string | null; body: string | null } | null;
  latest_received_at: string;
  messages: ThreadMessage[];
  sent_messages: SentThreadMessage[];
  eaccount: string | null;
  /** Thread addresses that are already live leads. */
  known_lead_emails: string[];
  /** Organisation and owner a promoted participant would inherit. */
  lead_organization_name: string | null;
  lead_owner_name: string | null;
}

export async function fetchCampaignReplies(token: string, campaignId: string): Promise<{ threads: CampaignReplyThread[] }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/replies`, {}, token);
}
export async function syncCampaignReplies(token: string, campaignId: string): Promise<{ found: number; backfilled: number }> {
  return apiFetch(`/api/v1/campaigns/${campaignId}/sync-replies`, { method: "POST" }, token);
}
export async function editReplyDraft(token: string, id: string, subject: string, body: string): Promise<ReplyDraft> {
  return apiFetch(`/api/v1/reply-drafts/${id}`, { method: "PATCH", body: JSON.stringify({ action: "edit", subject, body }) }, token);
}
export async function approveReplyDraft(token: string, id: string, subject?: string, body?: string): Promise<ReplyDraft> {
  return apiFetch(`/api/v1/reply-drafts/${id}`, { method: "PATCH", body: JSON.stringify({ action: "approve", subject, body }) }, token);
}
export async function rejectReplyDraft(token: string, id: string, reason?: string): Promise<ReplyDraft> {
  return apiFetch(`/api/v1/reply-drafts/${id}`, { method: "PATCH", body: JSON.stringify({ action: "reject", rejection_reason: reason }) }, token);
}
export async function sendReplyDraft(
  token: string,
  id: string,
  opts?: { to?: string[]; cc?: string[]; bcc?: string[]; reply_to_uuid?: string },
): Promise<{ sent: boolean }> {
  return apiFetch(
    `/api/v1/reply-drafts/${id}/send`,
    { method: "POST", body: JSON.stringify(opts ?? {}) },
    token,
  );
}
export async function regenerateReplyDraft(token: string, id: string, instruction?: string): Promise<ReplyDraft> {
  return apiFetch(`/api/v1/reply-drafts/${id}/regenerate`, { method: "POST", body: JSON.stringify({ instruction }) }, token);
}
/** Starts the first AI draft for a conversation that has none — the "AI draft"
 *  button. Replies no longer get drafted automatically on arrival, so this is
 *  what creates the reply_drafts row that regenerateReplyDraft then works off. */
export async function generateReplyDraftForThread(
  token: string,
  target: { thread_id?: string; campaign_lead_id?: string; instruction?: string },
): Promise<ReplyDraft> {
  return apiFetch("/api/v1/reply-drafts/generate", { method: "POST", body: JSON.stringify(target) }, token);
}

// ─── Unibox ──────────────────────────────────────────────────────────────────

export type UniboxThreadSummary = {
  thread_id: string;
  lead_email: string | null;
  lead: { first_name: string | null; last_name: string | null; title: string | null; email: string | null } | null;
  campaign: { id: string; name: string } | null;
  eaccount: string | null;
  subject: string | null;
  preview: string | null;
  latest_at: string;
  latest_direction: string;
  has_reply: boolean;
  /** Someone here asked something we have not answered THEM. */
  needs_reply: boolean;
  awaiting_reply_from: string[];
  unread_count: number;
  message_count: number;
  interest_status: number | null;
  lead_temperature: string | null;
  campaign_lead_id: string | null;
};

export type UniboxMessage = {
  id: string;
  instantly_email_id: string;
  direction: string;
  subject: string | null;
  from_email: string | null;
  to_emails: string | null;
  cc_emails: string | null;
  body_html: string | null;
  body_text: string | null;
  step: string | null;
  timestamp_email: string;
  is_unread: boolean;
  attachments: unknown;
  reply_event_id: string | null;
  // Who sent this, when known (review §4.2) — only set for replies sent
  // through our own reply endpoints, not messages synced from Instantly.
  sent_by: string | null;
  sent_by_name: string | null;
  /** Which message this reply answered — only set on mail we sent. */
  in_reply_to_email_id: string | null;
};

export async function fetchUniboxThreads(
  token: string,
  params: Record<string, string | undefined> = {},
  signal?: AbortSignal,
): Promise<{ threads: UniboxThreadSummary[]; next_cursor: string | null; counts: { unread_total: number; total: number } }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const q = qs.toString();
  return apiFetch(`/api/v1/unibox/threads${q ? `?${q}` : ""}`, { signal }, token);
}

export async function fetchUniboxThread(token: string, threadId: string, hydrate = false): Promise<{
  thread_id: string;
  messages: UniboxMessage[];
  reply_drafts: ReplyDraft[];
  lead: Record<string, unknown> | null;
  campaign: { id: string; name: string } | null;
  reply_to_uuid: string | null;
  eaccount: string | null;
  campaign_lead_id: string | null;
  interest_status: number | null;
  lead_temperature: string | null;
  /** Thread addresses that are already live leads. */
  known_lead_emails: string[];
  /** Organisation and owner a promoted participant would inherit. */
  lead_organization_name: string | null;
  lead_owner_name: string | null;
}> {
  return apiFetch(`/api/v1/unibox/threads/${threadId}${hydrate ? "?hydrate=1" : ""}`, {}, token);
}

/**
 * Promote a third participant on a thread into a lead of the same organisation.
 * Manager-only, and the address must genuinely be on the thread.
 */
export async function addThreadParticipantAsLead(
  token: string,
  threadId: string,
  participant: { email: string; first_name: string; last_name?: string },
): Promise<{ lead: { id: string; email: string; first_name: string | null; last_name: string | null } }> {
  return apiFetch(
    `/api/v1/unibox/threads/${threadId}/add-lead`,
    { method: "POST", body: JSON.stringify(participant) },
    token,
  );
}

export async function sendUniboxReply(
  token: string,
  body: {
    thread_id: string;
    subject: string;
    body_html: string;
    body_text?: string;
    reply_draft_id?: string;
    /** Full To list. The answered message's sender is always addressed anyway;
     *  the rest ride in Instantly's additional_recipients (still To, not CC). */
    to?: string[];
    cc?: string[];
    bcc?: string[];
    /** Message to answer. Instantly addresses the reply to its sender, so this
     *  is what picks the recipient. Omit for the newest inbound message. */
    reply_to_uuid?: string;
  },
) {
  return apiFetch("/api/v1/unibox/reply", { method: "POST", body: JSON.stringify(body) }, token);
}

export async function fetchReplyMailingList(
  token: string,
  opts?: { q?: string; limit?: number },
): Promise<{ emails: string[] }> {
  const qs = new URLSearchParams();
  if (opts?.q) qs.set("q", opts.q);
  if (opts?.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiFetch(`/api/v1/reply-mailing-list${suffix}`, {}, token);
}

export async function setThreadStatus(token: string, threadId: string, interest_value: number | null, lead_email?: string) {
  return apiFetch(`/api/v1/unibox/threads/${threadId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ interest_value, lead_email }),
  }, token);
}

export async function markThreadRead(token: string, threadId: string) {
  return apiFetch(`/api/v1/unibox/threads/${threadId}/read`, { method: "POST" }, token);
}

export async function syncUnibox(token: string): Promise<{ ingested: number; pages: number; failed: number }> {
  return apiFetch("/api/v1/unibox/sync", { method: "POST" }, token);
}

export async function fetchUniboxUnread(token: string) {
  return apiFetch<{ unread: number }>("/api/v1/unibox/unread-count", {}, token);
}

// ── Model Lab ────────────────────────────────────────────────────────────────

export type LabBenchLead = {
  id: string; first_name: string | null; last_name: string | null;
  title: string | null; country: string | null;
  organizations: { name: string | null; industry: string | null; company_description: string | null }
    | { name: string | null; industry: string | null; company_description: string | null }[] | null;
};
export type LabPromptSet = {
  id: string; name: string; scope: "personal" | "company";
  template: string | null; prompt: string | null;
};
export type LabEmail = {
  id: string; model: string; label: string | null;
  subject: string | null; body: string | null;
  duration_ms: number | null; cost_usd: number | null; error: string | null;
};
export type LabScoreRow = {
  prompt_set_id: string | null; prompt_set_name: string; model: string;
  best: number; worst: number; runs: number; avg_ms: number | null; avg_cost: number | null;
};

export async function fetchModelLab(token: string): Promise<{
  bench: LabBenchLead[]; models: string[]; prompt_sets: LabPromptSet[]; scoreboard: LabScoreRow[];
}> {
  return apiFetch("/api/v1/model-lab", {}, token);
}

export async function saveModelLabBench(
  token: string, body: { lead_ids?: string[]; models?: string[] },
): Promise<{ updated: boolean }> {
  return apiFetch("/api/v1/model-lab", { method: "PUT", body: JSON.stringify(body) }, token);
}

export async function runModelLab(token: string, body: {
  lead_id: string; step_number: number; models: string[];
  prompt_set_id?: string | null; template?: string | null; prompt?: string | null;
}): Promise<{ run_group: string; emails: LabEmail[] }> {
  return apiFetch("/api/v1/model-lab/generate", { method: "POST", body: JSON.stringify(body) }, token);
}

/** The last run for this lead + step + prompt set, so a reload does not look
 *  like the run never happened. */
export async function fetchModelLabRun(token: string, params: {
  leadId: string; stepNumber: number; promptSetId?: string | null;
}): Promise<{ run_group: string | null; emails: LabEmail[]; votes: { best?: string; worst?: string } }> {
  const qs = new URLSearchParams({ lead_id: params.leadId, step_number: String(params.stepNumber) });
  if (params.promptSetId) qs.set("prompt_set_id", params.promptSetId);
  return apiFetch(`/api/v1/model-lab/generate?${qs}`, {}, token);
}

export async function voteModelLab(
  token: string, body: { run_group: string; email_id: string; verdict: "best" | "worst" },
): Promise<{ recorded: boolean }> {
  return apiFetch("/api/v1/model-lab/vote", { method: "POST", body: JSON.stringify(body) }, token);
}

export async function clearModelLabVote(
  token: string, runGroup: string, verdict: "best" | "worst",
): Promise<{ cleared: boolean }> {
  return apiFetch(`/api/v1/model-lab/vote?run_group=${runGroup}&verdict=${verdict}`, { method: "DELETE" }, token);
}

export async function saveLabPromptSet(
  token: string, body: { id?: string; name: string; scope: "personal" | "company"; template?: string | null; prompt?: string | null },
): Promise<{ prompt_set: LabPromptSet }> {
  return apiFetch("/api/v1/model-lab/prompt-sets", { method: "POST", body: JSON.stringify(body) }, token);
}

export async function deleteLabPromptSet(token: string, id: string): Promise<{ deleted: string }> {
  return apiFetch(`/api/v1/model-lab/prompt-sets?id=${id}`, { method: "DELETE" }, token);
}

// ─── Client cache (stale-while-revalidate) ───────────────────────────────────
//
// Screens read through `useCached(key, fetcher)`: cached data renders on the
// spot (revisits, drawers reopened, rows hovered first) and a background
// request refreshes it. Keys are the GET path so writes through apiFetch can
// invalidate what they touched. The store itself lives in lib/query-cache.ts.

export { queryCache } from "@/lib/query-cache";

/** Current access token, read fresh — use inside cached fetchers instead of
 *  closing over `session.access_token`, which a prefetch could outlive. */
export { getToken as getAccessToken };

export type CachedResult<T> = {
  data: T | undefined;
  error: unknown;
  /** Nothing cached yet and the first request is still running. */
  isLoading: boolean;
  /** A request (first load or background refresh) is running. */
  isValidating: boolean;
  /** Write the cached value (optimistic updates). */
  mutate: (next: T | ((prev: T | undefined) => T)) => void;
  /** Refetch now, ignoring the dedupe window. */
  revalidate: () => Promise<T | undefined>;
};

/**
 * Read `key` from the cache and keep it fresh. `key = null` disables the query
 * (e.g. no session yet). On mount it revalidates unless the entry is younger
 * than `dedupeMs`; `refreshMs` adds a quiet poll while the tab is visible.
 */
export function useCached<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  opts: { dedupeMs?: number; refreshMs?: number } = {},
): CachedResult<T> {
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  const subscribe = useCallback(
    (cb: () => void) => (key ? queryCache.subscribe(key, cb) : () => {}),
    [key],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? queryCache.get<T>(key) : undefined),
    () => undefined,
  );

  // 30 s: a screen revisited within that window reuses the cached value. Every
  // write through apiFetch marks the related keys stale (query-cache RELATED),
  // and a stale entry is refetched whatever its age, so this never hides a change.
  const dedupeMs = opts.dedupeMs ?? 30_000;
  useEffect(() => {
    if (!key) return;
    const run = () => fetcherRef.current();
    queryCache.setFetcher(key, run);
    void queryCache.fetch(key, run, { maxAgeMs: dedupeMs }).catch(() => {});
  }, [key, dedupeMs]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (!key || !refreshMs) return;
    // Visible tab and someone at the keyboard only; several screens with the same
    // key share one entry, so a fresh value (another screen's tick) is reused.
    return everyWhileVisible(() => {
      void queryCache.fetch(key, () => fetcherRef.current(), { maxAgeMs: refreshMs - 1000 }).catch(() => {});
    }, refreshMs);
  }, [key, refreshMs]);

  const mutate = useCallback((next: T | ((prev: T | undefined) => T)) => {
    if (key) queryCache.set<T>(key, next);
  }, [key]);
  const revalidate = useCallback(async () => {
    if (!key) return undefined;
    return queryCache.fetch<T>(key, () => fetcherRef.current());
  }, [key]);

  return {
    data: entry?.data,
    error: entry?.error ?? null,
    isLoading: !!key && entry?.data === undefined && !entry?.error,
    isValidating: entry?.validating ?? false,
    mutate,
    revalidate,
  };
}

/** Warm `key` (hover, before navigating). Skips the request when the cached
 *  value is younger than `maxAgeMs`; never throws. */
export function prefetch<T>(key: string, fetcher?: () => Promise<T>, opts: { maxAgeMs?: number } = {}): void {
  if (typeof window === "undefined") return;
  void queryCache.fetch<T>(key, fetcher, { maxAgeMs: opts.maxAgeMs ?? 15_000 }).catch(() => {});
}

// ─── Shared cached queries ───────────────────────────────────────────────────
// One key + fetcher per resource so a hover prefetch and the screen that later
// reads it hit the same entry.

export const cacheKeys = {
  campaigns:          "/api/v1/campaigns",
  dashboardAnalytics: "/api/v1/dashboard/analytics",
  imports:            "/api/v1/imports",
  leadCounts:         "/api/v1/leads/count",
  users:              "/api/v1/settings/users",
  lead:               (id: string) => `/api/v1/leads/${id}`,
  leadActivity:       (id: string) => `/api/v1/leads/${id}/activity`,
  leadComments:       (id: string) => `/api/v1/leads/${id}/comments`,
  org:                (id: string) => `/api/v1/organizations/${id}`,
  orgLeads:           (id: string) => `/api/v1/leads?organization_id=${id}&limit=200`,
  campaignLeads:      (id: string) => `/api/v1/campaigns/${id}/leads?view=list`,
  campaignComments:   (id: string) => `/api/v1/campaigns/${id}/comments`,
  campaignReport:     (id: string) => `/api/v1/campaigns/${id}/report`,
  campaignLlmCost:    (id: string) => `/api/v1/campaigns/${id}/llm-cost`,
  campaignReplies:    (id: string) => `/api/v1/campaigns/${id}/replies`,
  campaignSteps:      (id: string) => `/api/v1/campaigns/${id}/steps`,
  uniboxThreads:      (qs: string) => `/api/v1/unibox/threads${qs ? `?${qs}` : ""}`,
  uniboxThread:       (id: string) => `/api/v1/unibox/threads/${id}`,
};

export type DashboardAnalyticsData = {
  temperatureBreakdown: { hot: number; cold: number; ooo: number; unsubscribed: number; unclassified: number };
  pendingReplies: Array<{ id: string; campaignId: string; campaignName: string; leadEmail: string | null; preview: string; createdAt: string }>;
  totalLeads: number;
  leadsThisMonth: number;
  enrichedLeads: number;
  pipelineGrowth: Array<{ month: string; leads: number }>;
  stageDonutData: Array<{ name: string; value: number; color: string }>;
};

/** With dashboard:all: company-wide; without: scoped to their own leads/campaigns —
 *  the route decides from the caller's scopes, same as the old server page. */
export async function fetchDashboardAnalytics(token: string): Promise<DashboardAnalyticsData> {
  return apiFetch("/api/v1/dashboard/analytics", {}, token);
}

export const cachedFetchers = {
  campaigns:          async () => fetchCampaigns(await getToken()),
  dashboardAnalytics: async () => fetchDashboardAnalytics(await getToken()),
  imports:            async () => (await fetchImports(await getToken())).imports,
  leadStatusCounts:   async () => fetchLeadStatusCounts(await getToken()),
  users:              async () => fetchUsers(await getToken()),
  lead:               (id: string) => async () => fetchLead(await getToken(), id),
  leadActivity:       (id: string) => async () => fetchLeadActivity(await getToken(), id),
  leadComments:       (id: string) => async () => fetchLeadComments(await getToken(), id),
  org:                (id: string) => async () => fetchOrg(await getToken(), id),
  orgLeads:           (id: string) => async () => fetchLeadsByOrg(await getToken(), id),
};

// Hover intent: sweeping the mouse down a table must not fire requests for
// every row it crosses. Each call replaces the pending one, so only the row the
// pointer rests on (≥ HOVER_INTENT_MS) is fetched.
const HOVER_INTENT_MS = 300;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function onHoverIntent(run: () => void) {
  if (typeof window === "undefined") return;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoverTimer = null; run(); }, HOVER_INTENT_MS);
}

/** Hover-prefetch for a lead row (`onMouseEnter={() => prefetchLead(lead.id)}`):
 *  the lead drawer then opens with its details at once. Activity and comments
 *  load when it opens — most hovers never become an open, so warming all three
 *  tripled the requests for nothing. */
export function prefetchLead(id: string): void {
  onHoverIntent(() => {
    prefetch(cacheKeys.lead(id), cachedFetchers.lead(id));
  });
}

/** Hover-prefetch for an organization row / company link. */
export function prefetchOrg(id: string): void {
  onHoverIntent(() => {
    prefetch(cacheKeys.org(id), cachedFetchers.org(id));
    prefetch(cacheKeys.orgLeads(id), cachedFetchers.orgLeads(id));
  });
}

/** Hover-prefetch for a campaign card: the list row (header) is already in the
 *  campaigns cache; warm the leads table, which is the slow part. `also` runs
 *  after the same hover delay (the campaigns list passes its route prefetch,
 *  which used to fire on every row the mouse crossed). */
export function prefetchCampaign(id: string, also?: () => void): void {
  onHoverIntent(() => {
    also?.();
    prefetch(cacheKeys.campaigns, cachedFetchers.campaigns, { maxAgeMs: 30_000 });
    prefetch(cacheKeys.campaignLeads(id), async () => fetchCampaignLeads(await getToken(), id));
  });
}

// ─── Kuber AI assistant ──────────────────────────────────────────────────────

export type AssistantActionResult = { ok: boolean; message: string; link?: string; data?: Record<string, unknown> };

export async function executeAssistantAction(token: string, proposalToken: string): Promise<AssistantActionResult> {
  return apiFetch<AssistantActionResult>("/api/v1/assistant/actions", { method: "POST", body: JSON.stringify({ token: proposalToken }) }, token);
}

export type AssistantThreadSummary = {
  id: string; title: string; updated_at: string; message_count: number;
  preview: string | null; last_role: "user" | "assistant" | null;
};

export type AssistantOverview = {
  scope: string;
  leads: { total: number; added_last_7_days: number };
  in_campaigns: { total: number; hot: number; interested: number };
  campaigns: { total: number; by_status: Array<{ value: string; count: number }> };
  to_do: { replies_needing_answer: number; unread_emails: number; drafts_waiting_review: number; enrichment_failures_last_7_days: number };
};

export async function fetchAssistantOverview(token: string): Promise<AssistantOverview> {
  return apiFetch("/api/v1/assistant/overview", {}, token);
}

export async function fetchAssistantThreads(token: string): Promise<{ available: boolean; threads: AssistantThreadSummary[] }> {
  return apiFetch("/api/v1/assistant/threads", {}, token);
}

export async function fetchAssistantThread<M = unknown>(token: string, id: string): Promise<{ id: string; title: string; messages: M[] }> {
  return apiFetch(`/api/v1/assistant/threads/${encodeURIComponent(id)}`, {}, token);
}

export async function saveAssistantThread(token: string, id: string, messages: unknown[]): Promise<void> {
  await apiFetch(`/api/v1/assistant/threads/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ messages }) }, token);
}

export async function deleteAssistantThread(token: string, id: string): Promise<void> {
  await apiFetch(`/api/v1/assistant/threads/${encodeURIComponent(id)}`, { method: "DELETE" }, token);
}

export type AssistantModelSettings = {
  providers: Array<{
    id: string; label: string; configured: boolean;
    defaults: { fast: string; deep: string; utility: string };
    overrides: { fast?: string; deep?: string };
  }>;
};

export async function fetchAssistantModels(token: string): Promise<AssistantModelSettings> {
  return apiFetch("/api/v1/assistant/models", {}, token);
}

export async function saveAssistantModel(token: string, provider: string, patch: { fast?: string | null; deep?: string | null }): Promise<void> {
  await apiFetch("/api/v1/assistant/models", { method: "PUT", body: JSON.stringify({ provider, ...patch }) }, token);
}

type UsageAgg = { calls: number; cost_usd: number; tokens: number; failed: number; unpriced: number; last_used: string | null };
export type AssistantUsageData = {
  window_days: number;
  per_person_available: boolean;
  total: UsageAgg;
  by_purpose: Array<UsageAgg & { purpose: string }>;
  by_person: Array<UsageAgg & { user_id: string | null; name: string; email: string | null }>;
  by_model: Array<UsageAgg & { model: string }>;
  daily: Array<{ date: string; assistant: number; other: number }>;
};

export async function fetchAssistantUsage(token: string, days = 30): Promise<AssistantUsageData> {
  return apiFetch(`/api/v1/assistant/usage?days=${days}`, {}, token);
}
