import { toInstantlyTimezone } from "@/lib/instantly-timezones";
import { requireServiceSecret } from "@/lib/services/service-keys";

const BASE = "https://api.instantly.ai/api/v2";

// Async because the key now resolves through Settings > Keys (DB first,
// .env.local as the fallback tier) instead of being read straight off
// process.env at module scope.
async function h() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await requireServiceSecret("instantly", "Instantly")}`,
  };
}

/** Auth-only variant for the endpoints that must not send Content-Type
 *  (GETs and multipart uploads). */
async function authOnly() {
  return { Authorization: `Bearer ${await requireServiceSecret("instantly", "Instantly")}` };
}

async function iJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const d = data as { message?: string; error?: string };
    throw new Error(`Instantly ${res.status}: ${d.message ?? d.error ?? "request failed"}`);
  }
  return data as T;
}

// ─── Day conversion ───────────────────────────────────────────────────────────
// Our DB/UI stores named keys: { monday: true, ... }
// Instantly requires numeric string keys: { "1": true, ... }, "0" = Sunday
const DAY_NAME_TO_NUM: Record<string, string> = {
  sunday: "0", monday: "1", tuesday: "2", wednesday: "3",
  thursday: "4", friday: "5", saturday: "6",
};

export function toInstantlyDays(
  sendDays: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(sendDays ?? {})) {
    const num = DAY_NAME_TO_NUM[k.toLowerCase()] ?? (/^[0-6]$/.test(k) ? k : null);
    if (num !== null) out[num] = !!v;
  }
  // Default Mon-Fri if nothing resolved
  if (Object.keys(out).length === 0) {
    return { "1": true, "2": true, "3": true, "4": true, "5": true, "0": false, "6": false };
  }
  return out;
}

// ─── Variable builder ─────────────────────────────────────────────────────────
// Turns approved drafts (by step) into Instantly custom_variables.
// step 1 → customSubject / customBody
// step N>1 → customSubjectN / customBodyN
// HTML mode: \n → <br> (see §10 for the test you must run before production)
export function buildCustomVariables(
  drafts: Array<{ step_number: number; subject: string | null; body: string | null }>,
  senderName?: string | null,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const d of drafts) {
    const sfx = d.step_number === 1 ? "" : String(d.step_number);
    if (d.subject != null) vars[`customSubject${sfx}`] = d.subject;
    if (d.body != null)    vars[`customBody${sfx}`]    = d.body.replace(/\n/g, "<br>");
  }
  if (senderName) vars.senderName = senderName;
  return vars;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstantlyStep {
  subject: string;        // empty string on follow-ups = threaded
  body: string;
  delay: number;          // wait before NEXT step (not the current one)
  delayUnit?: "minutes" | "hours" | "days";
}

export interface InstantlyLeadInput {
  email: string;
  firstName: string;
  lastName: string;
  customVariables: Record<string, string>;
}

export interface BulkAddResult {
  status: string;
  total_sent: number;
  leads_uploaded: number;
  duplicated_leads?: number;
  duplicate_email_count?: number;
  invalid_email_count?: number;
  skipped_count?: number;
  created_leads?: Array<{ index: number; id: string; email: string }>;
}

// ─── Campaign CRUD ────────────────────────────────────────────────────────────

export async function createInstantlyCampaign(opts: {
  name: string;
  dailyLimit: number;
  windowFrom: string;   // "09:00"
  windowTo: string;     // "18:00"
  timezone: string;     // IANA only
  sendDays: Record<string, boolean>;
  steps: InstantlyStep[];
  emailList: string[];  // sending-account emails — MUST be non-empty or campaign never sends
}): Promise<string> {
  if (opts.emailList.length === 0) {
    throw new Error("createInstantlyCampaign: emailList is empty — campaign will never send");
  }
  const res = await fetch(`${BASE}/campaigns`, {
    method: "POST",
    headers: await h(),
    body: JSON.stringify({
      name: opts.name,
      campaign_schedule: {
        schedules: [{
          name: "Default",
          timing: { from: opts.windowFrom, to: opts.windowTo },
          days: toInstantlyDays(opts.sendDays),
          timezone: toInstantlyTimezone(opts.timezone),
        }],
      },
      daily_limit: opts.dailyLimit,
      email_list: opts.emailList,
      stop_on_reply: true,
      stop_on_auto_reply: false,
      sequences: [{
        steps: opts.steps.map((s) => ({
          type: "email" as const,
          delay: s.delay,
          ...(s.delayUnit ? { delay_unit: s.delayUnit } : {}),
          variants: [{ subject: s.subject, body: s.body }],
        })),
      }],
    }),
  });
  const data = await iJson<{ id: string }>(res);
  return data.id;
}

export interface InstantlySchedule {
  name?: string;
  timing?: { from?: string; to?: string };
  days?: Record<string, boolean>;
  timezone?: string;
}

export interface ScheduleFieldPatch {
  windowFrom?: string;
  windowTo?: string;
  timezone?: string;
  sendDays?: Record<string, boolean>;
}

/**
 * Overlay ONLY the named fields onto an existing schedule, leaving every other
 * field exactly as Instantly currently holds it. Pure, so the "don't blank the
 * fields nobody asked about" rule is testable without a network round-trip —
 * see instantly-schedule.test.ts.
 */
export function mergeInstantlySchedule(
  base: InstantlySchedule,
  patch: ScheduleFieldPatch,
): InstantlySchedule {
  return {
    ...base,
    name: base.name ?? "Default",
    timing: {
      ...(base.timing ?? {}),
      ...(patch.windowFrom !== undefined ? { from: patch.windowFrom } : {}),
      ...(patch.windowTo   !== undefined ? { to:   patch.windowTo   } : {}),
    },
    ...(patch.sendDays !== undefined ? { days: toInstantlyDays(patch.sendDays) } : {}),
    ...(patch.timezone !== undefined ? { timezone: toInstantlyTimezone(patch.timezone) } : {}),
  };
}

/** Read a campaign back from Instantly. Needed by patchInstantlyCampaignConfig
 *  below — see the comment there for why a plain PATCH is not enough. */
export async function getInstantlyCampaign(
  instantlyCampaignId: string,
): Promise<{
  campaign_schedule?: { schedules?: InstantlySchedule[] };
  /** Instantly's own copy of the sequence. Read by the drift check — Instantly
   *  holds this independently of our campaign_steps, and the two silently
   *  disagreed for weeks (see lib/services/sequence-drift.ts). */
  sequences?: { steps?: { delay?: number }[] }[];
}> {
  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}`, { headers: await authOnly() });
  return iJson(res);
}

/**
 * Patch campaign settings, touching ONLY the fields the caller passed.
 *
 * Top-level scalars (name, daily_limit) patch independently — Instantly merges
 * them field-wise, so an omitted one is left alone.
 *
 * campaign_schedule does NOT work that way: it is a nested object that Instantly
 * REPLACES wholesale, so sending a partially-populated one silently wipes the
 * fields left out of it. The previous version of this function rebuilt the whole
 * schedule from `opts` and let missing fields serialise as undefined, which meant
 * "change the window" also blanked days and timezone. So when any schedule field
 * is passed, the current schedule is read back first and only the named fields
 * are overlaid onto it. Callers that pass no schedule field never fetch and never
 * send campaign_schedule at all.
 *
 * Timezone in particular is per-country and lives on the sub-campaign (see
 * campaign-fanout.ts). It is only ever sent when a caller explicitly asks for a
 * timezone change — never as a side effect of editing the window, days or limit.
 */
export async function patchInstantlyCampaignConfig(
  instantlyCampaignId: string,
  opts: {
    name?: string;
    dailyLimit?: number;
    windowFrom?: string;
    windowTo?: string;
    timezone?: string;
    sendDays?: Record<string, boolean>;
  },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.dailyLimit !== undefined) body.daily_limit = opts.dailyLimit;

  const touchesSchedule =
    opts.windowFrom !== undefined || opts.windowTo !== undefined
    || opts.timezone !== undefined || opts.sendDays !== undefined;

  if (touchesSchedule) {
    const current = await getInstantlyCampaign(instantlyCampaignId);
    const schedules = current.campaign_schedule?.schedules ?? [];
    // Extra schedules (Instantly allows several) are preserved untouched.
    body.campaign_schedule = {
      schedules: [mergeInstantlySchedule(schedules[0] ?? {}, opts), ...schedules.slice(1)],
    };
  }

  // Nothing to change — don't spend an API call proving it.
  if (Object.keys(body).length === 0) return;

  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}`, {
    method: "PATCH",
    headers: await h(),
    body: JSON.stringify(body),
  });
  await iJson<unknown>(res);
}

export async function patchInstantlySequences(
  instantlyCampaignId: string,
  steps: InstantlyStep[],
): Promise<void> {
  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}`, {
    method: "PATCH",
    headers: await h(),
    body: JSON.stringify({
      sequences: [{
        steps: steps.map((s) => ({
          type: "email" as const,
          delay: s.delay,
          ...(s.delayUnit ? { delay_unit: s.delayUnit } : {}),
          variants: [{ subject: s.subject, body: s.body }],
        })),
      }],
    }),
  });
  await iJson<unknown>(res);
}

export async function activateInstantlyCampaign(instantlyCampaignId: string): Promise<void> {
  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}/activate`, {
    method: "POST",
    // authOnly(): NO Content-Type — there is no body, and declaring JSON with
    // an empty body 400s
    headers: await authOnly(),
  });
  await iJson<unknown>(res);
}

export async function pauseInstantlyCampaign(instantlyCampaignId: string): Promise<void> {
  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}/pause`, {
    method: "POST",
    // authOnly(): NO Content-Type
    headers: await authOnly(),
  });
  await iJson<unknown>(res);
}

/** Permanently delete a campaign from Instantly. 404 = already gone (idempotent). */
export async function deleteInstantlyCampaign(instantlyCampaignId: string): Promise<void> {
  const res = await fetch(`${BASE}/campaigns/${instantlyCampaignId}`, {
    method: "DELETE",
    headers: await authOnly(),
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Instantly delete ${res.status}: ${data.message ?? "failed"}`);
  }
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function addLeadsToInstantly(
  instantlyCampaignId: string,
  leads: InstantlyLeadInput[],
): Promise<BulkAddResult> {
  const res = await fetch(`${BASE}/leads/add`, {   // CORRECT endpoint (NOT /campaign-lead)
    method: "POST",
    headers: await h(),
    body: JSON.stringify({
      campaign_id: instantlyCampaignId,
      skip_if_in_workspace: false,
      leads: leads.map((l) => ({
        email: l.email,
        first_name: l.firstName,
        last_name: l.lastName,
        custom_variables: l.customVariables,   // CORRECT field (NOT variables)
      })),
    }),
  });
  return iJson<BulkAddResult>(res);
}

/**
 * Permanently remove a lead from Instantly — stops all scheduled follow-up
 * steps for that person. 404 = already gone (idempotent), so retrying a
 * partially-failed delete is safe.
 */
export async function deleteInstantlyLead(instantlyLeadId: string): Promise<void> {
  const res = await fetch(`${BASE}/leads/${instantlyLeadId}`, {
    method: "DELETE",
    headers: await authOnly(),
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Instantly lead delete ${res.status}: ${data.message ?? "failed"}`);
  }
}

// ─── Leads: post-add updates ──────────────────────────────────────────────────
// PATCH /leads/{id} — used to push updated custom_variables (e.g. a follow-up
// draft's customBodyN/customSubjectN) to a lead that was already added to a
// campaign. Without this, editing/approving a follow-up draft after the lead's
// initial send never reaches Instantly — custom_variables are otherwise only
// ever set once, at addLeadsToInstantly() time.
export async function updateInstantlyLeadVariables(
  instantlyLeadId: string,
  customVariables: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${BASE}/leads/${instantlyLeadId}`, {
    method: "PATCH",
    headers: await h(),
    body: JSON.stringify({ custom_variables: customVariables }),
  });
  await iJson<unknown>(res);
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export type InstantlyAccount = {
  email: string;
  status: number;
  daily_limit?: number | null;
  first_name?: string | null;
  last_name?: string | null;
};

export async function listInstantlyAccounts(): Promise<InstantlyAccount[]> {
  const res = await fetch(`${BASE}/accounts?limit=100`, { headers: await h() });
  const data = await iJson<{ items?: InstantlyAccount[] }>(res);
  return data.items ?? [];
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export interface InstantlyCampaignAnalyticsOverview {
  emails_sent_count?: number;
  open_count?: number;
  open_count_unique?: number;
  reply_count?: number;
  reply_count_unique?: number;
  bounced_count?: number;
  leads_count?: number;
  new_leads_contacted_count?: number;
  total_opportunities?: number;
}

/** Aggregate stats across every campaign in the workspace — the summary cards
 *  for Settings > Keys > Usage > Instantly. */
export async function getCampaignAnalyticsOverview(): Promise<InstantlyCampaignAnalyticsOverview> {
  const res = await fetch(`${BASE}/campaigns/analytics/overview`, { headers: await h() });
  return iJson<InstantlyCampaignAnalyticsOverview>(res);
}

export interface InstantlyDailyAnalytics {
  date: string;
  sent?: number;
  opened?: number;
  unique_opened?: number;
  replies?: number;
  unique_replies?: number;
  clicks?: number;
  unique_clicks?: number;
}

/** Day-by-day send/open/reply counts across every campaign — feeds the usage
 *  timeline chart. Instantly's field names vary slightly by account tier, so
 *  callers should treat missing numeric fields as 0 rather than erroring. */
export async function getCampaignAnalyticsDaily(opts: {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}): Promise<InstantlyDailyAnalytics[]> {
  const qs = new URLSearchParams({ start_date: opts.startDate, end_date: opts.endDate });
  const res = await fetch(`${BASE}/campaigns/analytics/daily?${qs.toString()}`, { headers: await h() });
  const data = await iJson<InstantlyDailyAnalytics[] | { data?: InstantlyDailyAnalytics[] }>(res);
  return Array.isArray(data) ? data : (data.data ?? []);
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export async function createInstantlyWebhook(opts: {
  url: string;
  eventType: string;       // "all_events" | "reply_received" | ...
  campaign?: string;       // optional Instantly campaign UUID filter
  secret?: string;
}): Promise<string> {
  const res = await fetch(`${BASE}/webhooks`, {
    method: "POST",
    headers: await h(),
    body: JSON.stringify({
      target_hook_url: opts.url,
      event_type: opts.eventType,
      ...(opts.campaign ? { campaign: opts.campaign } : {}),
      ...(opts.secret ? { headers: { "X-Webhook-Secret": opts.secret } } : {}),
    }),
  });
  const data = await iJson<{ id: string }>(res);
  return data.id;
}

// ─── Reading inbound emails / threads (Unibox) ────────────────────────────────
// GET /emails list is rate-limited to 20 req/min. Use sparingly.

export interface InstantlyEmail {
  id: string;
  thread_id?: string | null;
  message_id?: string | null;
  subject?: string | null;
  from_address_email?: string | null;
  to_address_email_list?: string | null;
  cc_address_email_list?: string | null;
  bcc_address_email_list?: string | null;
  body?: { text?: string | null; html?: string | null } | null;
  ue_type: number;
  is_auto_reply?: boolean | number;
  is_unread?: boolean | number;
  is_focused?: boolean | number;
  campaign_id?: string | null;
  lead?: string | null;
  lead_id?: string | null;
  eaccount?: string | null;
  step?: string | number | null;
  i_status?: number | null;
  ai_interest_value?: number | null;
  content_preview?: string | null;
  attachment_json?: unknown;
  timestamp_email?: string | null;
  timestamp_created?: string | null;
}

export interface ListEmailsParams {
  limit?: number;
  starting_after?: string;
  min_timestamp_created?: string;
  max_timestamp_created?: string;
  sort_order?: "asc" | "desc";
  campaign_id?: string;
  eaccount?: string;
  search?: string;
}

export interface ListEmailsResult {
  items: InstantlyEmail[];
  next_starting_after?: string | null;
}

// Token bucket: max 18 GET /emails list calls per minute
let listEmailsTimestamps: number[] = [];
const LIST_EMAILS_MAX_PER_MIN = 18;

async function throttleListEmails(): Promise<void> {
  const now = Date.now();
  listEmailsTimestamps = listEmailsTimestamps.filter((t) => now - t < 60_000);
  if (listEmailsTimestamps.length >= LIST_EMAILS_MAX_PER_MIN) {
    const waitMs = 60_000 - (now - listEmailsTimestamps[0]) + 100;
    await new Promise((r) => setTimeout(r, waitMs));
    listEmailsTimestamps = listEmailsTimestamps.filter((t) => Date.now() - t < 60_000);
  }
  listEmailsTimestamps.push(Date.now());
}

async function fetchEmailsList(url: string, retries = 2): Promise<ListEmailsResult> {
  await throttleListEmails();
  const res = await fetch(url, { headers: await h() });
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return fetchEmailsList(url, retries - 1);
  }
  const data = await iJson<{ items?: InstantlyEmail[]; next_starting_after?: string | null }>(res);
  return { items: data.items ?? [], next_starting_after: data.next_starting_after ?? null };
}

export async function listEmails(params: ListEmailsParams = {}): Promise<ListEmailsResult> {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.starting_after) qs.set("starting_after", params.starting_after);
  if (params.min_timestamp_created) qs.set("min_timestamp_created", params.min_timestamp_created);
  if (params.max_timestamp_created) qs.set("max_timestamp_created", params.max_timestamp_created);
  if (params.sort_order) qs.set("sort_order", params.sort_order);
  if (params.campaign_id) qs.set("campaign_id", params.campaign_id);
  if (params.eaccount) qs.set("eaccount", params.eaccount);
  if (params.search) qs.set("search", params.search);
  const url = `${BASE}/emails?${qs.toString()}`;
  return fetchEmailsList(url);
}

export async function markInstantlyThreadAsRead(threadId: string): Promise<void> {
  const res = await fetch(`${BASE}/emails/threads/${encodeURIComponent(threadId)}/mark-as-read`, {
    method: "POST",
    headers: await authOnly(),
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Instantly mark-as-read ${res.status}: ${data.message ?? "failed"}`);
  }
}

export async function countInstantlyUnread(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/emails/unread/count`, { headers: await h() });
    if (!res.ok) return 0;
    const data = await res.json() as { count?: number; unread_count?: number };
    return data.count ?? data.unread_count ?? 0;
  } catch {
    return 0;
  }
}

export async function getInstantlyEmail(emailId: string): Promise<InstantlyEmail> {
  const res = await fetch(`${BASE}/emails/${emailId}`, { headers: await h() });
  return iJson<InstantlyEmail>(res);
}

// Pull a whole conversation in chronological order (oldest first) for AI context.
export async function listThreadEmails(threadId: string): Promise<InstantlyEmail[]> {
  const url = `${BASE}/emails?search=${encodeURIComponent(`thread:${threadId}`)}&sort_order=asc&limit=20`;
  const res = await fetch(url, { headers: await h() });
  const data = await iJson<{ items?: InstantlyEmail[] }>(res);
  return data.items ?? [];
}

// List received emails (prospect replies) for a specific Instantly sub-campaign.
// The Instantly API ignores ue_type as a query filter, so we filter client-side.
// ue_type=2 = received from prospect. Excludes auto-replies.
export async function listInstantlyCampaignReplies(
  instantlyCampaignId: string,
  limit = 100,
): Promise<InstantlyEmail[]> {
  const params = new URLSearchParams({
    campaign_id: instantlyCampaignId,
    limit: String(limit),
    sort_order: "desc",
  });
  const res = await fetch(`${BASE}/emails?${params.toString()}`, { headers: await h() });
  const data = await iJson<{ items?: InstantlyEmail[] }>(res);
  return (data.items ?? []).filter((e) => e.ue_type === 2 && !e.is_auto_reply);
}

/**
 * Which sequence step Instantly has ALREADY sent to this lead, as a 0-based
 * index — or null when it has sent none, or we could not ask.
 *
 * This is the only way to get the truth about a send without waiting for a
 * webhook. Our own record of "sent" comes from Instantly telling us, and
 * measured across 820 real step-2 sends only 86.7% arrived within a minute —
 * the rest took up to 15. During that gap our screen says "not sent yet" for an
 * email the customer is already reading, so a user regenerates it, sees a green
 * tick, and the change reaches nobody.
 *
 * One call, one lead, asked only when someone actually tries to change a
 * follow-up. Asking for a whole campaign would be a hundred calls; the bulk
 * path holds sending instead, which removes the race rather than polling it.
 *
 * `status_summary.lastStep.stepID` is Instantly's "{sequence}_{stepIndex}_{variant}"
 * string, the same shape as unibox_emails.step. Only the middle segment matters:
 * step_order N corresponds to stepIndex N-1, and matching on the index keeps
 * every A/B variant of that step counted as sent.
 *
 * Returns null rather than throwing on any failure. A regeneration must not be
 * blocked because Instantly was briefly unreachable — the caller treats null as
 * "unknown" and falls back to our own record.
 */
export async function getInstantlyLeadSentStepIndex(
  instantlyLeadId: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${BASE}/leads/${instantlyLeadId}`, { headers: await authOnly() });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null) as {
      status_summary?: { lastStep?: { stepID?: string | null } | null } | null;
    } | null;
    const stepId = data?.status_summary?.lastStep?.stepID;
    if (!stepId) return null;
    const index = Number(String(stepId).split("_")[1]);
    return Number.isFinite(index) ? index : null;
  } catch {
    return null;
  }
}

// Fetch a lead's interest/status from Instantly by campaign + email.
// Uses POST /api/v2/leads/list (the GET /leads endpoint does not support filtering).
export async function getInstantlyLeadStatus(
  instantlyCampaignId: string,
  leadEmail: string,
): Promise<{ interest_value?: number | null; pl_value?: number | null } | null> {
  try {
    const res = await fetch(`${BASE}/leads/list`, {
      method: "POST",
      headers: await h(),
      body: JSON.stringify({
        campaign_id: instantlyCampaignId,
        search: leadEmail,
        limit: 5,
      }),
    });
    if (!res.ok) return null;
    // The real field is lt_interest_status, not interest_value/pl_value (those
    // don't exist in this response at all — confirmed live, they were always
    // silently reading undefined). The campaign_id filter above is also not
    // reliable on its own: for a lead enrolled in several sub-campaigns it can
    // return sibling campaigns' rows too, so `campaign` is checked client-side
    // as well rather than trusting the first email match.
    const data = await res.json().catch(() => null) as {
      items?: Array<{ email?: string; campaign?: string; lt_interest_status?: number | null }>;
    } | null;
    const match = (data?.items ?? []).find(
      (l) => l.email?.toLowerCase() === leadEmail.toLowerCase() && l.campaign === instantlyCampaignId,
    );
    if (!match) return null;
    return { interest_value: match.lt_interest_status ?? null, pl_value: null };
  } catch {
    return null;
  }
}

// ─── Sending a threaded reply ─────────────────────────────────────────────────
// reply_to_uuid = the Instantly email id of the inbound message (== webhook email_id).
// eaccount = the sending mailbox that owns the thread (from the original send / the inbound email).

export async function replyToInstantlyEmail(opts: {
  replyToUuid: string;
  eaccount: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  /**
   * Extra To recipients. There is no to_address_email_list on this endpoint —
   * the sender of `replyToUuid` is always addressed automatically, and these are
   * added ALONGSIDE them in the To line (Instantly: "extra recipient email
   * addresses to include in the reply, in addition to the default recipient").
   * This is what makes a real reply-all possible instead of one To + CC.
   */
  additionalTo?: string[];
  cc?: string[];
  bcc?: string[];
}): Promise<InstantlyEmail> {
  const res = await fetch(`${BASE}/emails/reply`, {
    method: "POST",
    headers: await h(),
    body: JSON.stringify({
      reply_to_uuid: opts.replyToUuid,
      eaccount: opts.eaccount,
      subject: opts.subject,
      body: { html: opts.bodyHtml, ...(opts.bodyText ? { text: opts.bodyText } : {}) },
      ...(opts.additionalTo?.length ? { additional_recipients: opts.additionalTo } : {}),
      // Documented as a comma-separated STRING (additional_recipients is the one
      // array field here). We sent JSON arrays and Instantly coerced them, so it
      // worked — but off-contract input is exactly what stops working without
      // warning on an API update, with no error we would ever see.
      ...(opts.cc?.length ? { cc_address_email_list: opts.cc.join(",") } : {}),
      ...(opts.bcc?.length ? { bcc_address_email_list: opts.bcc.join(",") } : {}),
    }),
  });
  return iJson<InstantlyEmail>(res);
}

// ─── Interest status (CRM sync back to Instantly) ─────────────────────────────
// Setting a value also stops the sequence for that lead. disable_auto_interest=true
// prevents Instantly's own AI from overwriting our verdict later.

export async function updateLeadInterestStatus(opts: {
  leadEmail: string;
  interestValue: number | null;
  disableAutoInterest?: boolean;
}): Promise<void> {
  const res = await fetch(`${BASE}/leads/update-interest-status`, {
    method: "POST",
    headers: await h(),
    body: JSON.stringify({
      lead_email: opts.leadEmail,
      interest_value: opts.interestValue,
      ...(opts.disableAutoInterest ? { disable_auto_interest: true } : {}),
    }),
  });
  await iJson<unknown>(res);
}
