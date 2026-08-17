import type { SupabaseClient } from "@supabase/supabase-js";
import { createScopedClient } from "@/lib/supabase/scoped";
import sanitizeHtml from "sanitize-html";
import { INTEREST_TO_TEMPERATURE } from "@/lib/constants";
import { emailPreview, stripQuotedText, ueTypeToDirection } from "@/lib/email-display";
import { pickDraftsForInboundMessage } from "@/lib/reply-draft-pick";
import {
  ourAddresses,
  parseAddressList,
  unansweredInbound,
  type ParticipantMessage,
} from "@/lib/thread-participants";
import {
  campaignMatches,
  matchesInterestFilter,
  matchesReadState,
  matchesTab,
  type UniboxReadState,
  type UniboxTab,
} from "@/lib/unibox-filters";
import { findActiveLeadIdByEmail } from "@/lib/services/lead-lookup";
import {
  type InstantlyEmail,
  listEmails,
  listThreadEmails,
  markInstantlyThreadAsRead,
  replyToInstantlyEmail,
  updateLeadInterestStatus,
} from "@/lib/services/instantly";
import { rememberReplyAddresses } from "@/lib/services/reply-mailing-list";

const SYNC_STATE_KEY = "unibox_sync_state";
const HYDRATE_COOLDOWN_MS = 10 * 60 * 1000;
const hydrateCooldown = new Map<string, number>();

// Re-exported so existing importers (the threads route) keep working.
export type { UniboxTab, UniboxReadState } from "@/lib/unibox-filters";

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
  /** False for threads we sent into that the lead has never answered. */
  has_reply: boolean;
  /** Someone on this thread asked something we have not answered THEM. */
  needs_reply: boolean;
  /** Their addresses — a thread can be answered for one person and not another. */
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

type Db = SupabaseClient;

function normEmail(v: string | null | undefined): string | null {
  return v?.trim().toLowerCase() ?? null;
}

function boolish(v: boolean | number | undefined): boolean {
  return v === true || v === 1;
}

export async function resolveCampaignLead(
  db: Db,
  masterCampaignId: string | null,
  leadEmail: string | null,
): Promise<string | null> {
  if (!masterCampaignId || !leadEmail) return null;
  const leadId = await findActiveLeadIdByEmail(db, leadEmail);
  if (!leadId) return null;
  const { data: cl } = await db
    .from("campaign_leads")
    .select("id")
    .eq("campaign_id", masterCampaignId)
    .eq("lead_id", leadId)
    .maybeSingle();
  return cl?.id ?? null;
}

async function resolveMasterCampaignId(db: Db, instantlySubUuid: string | null | undefined): Promise<string | null> {
  if (!instantlySubUuid) return null;
  const { data: sub } = await db
    .from("instantly_campaigns")
    .select("campaign_id")
    .eq("instantly_campaign_id", instantlySubUuid)
    .maybeSingle();
  return sub?.campaign_id ?? null;
}

function emailToRow(email: InstantlyEmail, opts: {
  masterCampaignId?: string | null;
  campaignLeadId?: string | null;
  replyEventId?: string | null;
  sentBy?: string | null;
  inReplyToEmailId?: string | null;
}) {
  const bodyText = email.body?.text ?? null;
  const bodyHtml = email.body?.html ?? null;
  const leadEmail = normEmail(email.lead ?? email.from_address_email);
  const ts = email.timestamp_email ?? email.timestamp_created ?? new Date().toISOString();
  return {
    instantly_email_id: email.id,
    thread_id: email.thread_id ?? null,
    message_id: email.message_id ?? null,
    direction: ueTypeToDirection(email.ue_type),
    ue_type: email.ue_type,
    subject: email.subject ?? null,
    from_email: normEmail(email.from_address_email),
    to_emails: email.to_address_email_list ?? null,
    cc_emails: email.cc_address_email_list ?? null,
    bcc_emails: email.bcc_address_email_list ?? null,
    body_text: bodyText,
    body_html: bodyHtml,
    content_preview: email.content_preview ?? emailPreview(bodyText, bodyHtml),
    eaccount: email.eaccount ?? null,
    lead_email: leadEmail,
    instantly_lead_id: email.lead_id ?? null,
    instantly_campaign_id: email.campaign_id ?? null,
    campaign_id: opts.masterCampaignId ?? null,
    campaign_lead_id: opts.campaignLeadId ?? null,
    reply_event_id: opts.replyEventId ?? null,
    // Only meaningful for outbound replies WE just sent (review §4.2) — never
    // set on resync/webhook ingestion, and never overwritten on update below.
    sent_by: opts.sentBy ?? null,
    // Only ever known for mail we send ourselves — Instantly's sync carries no
    // such link, so a resync must never blank it (see the update below).
    in_reply_to_email_id: opts.inReplyToEmailId ?? null,
    step: email.step != null ? String(email.step) : null,
    is_unread: email.ue_type === 2 ? boolish(email.is_unread) : false,
    is_auto_reply: boolish(email.is_auto_reply),
    is_focused: email.is_focused === undefined ? true : boolish(email.is_focused),
    i_status: email.i_status ?? null,
    ai_interest_value: email.ai_interest_value ?? null,
    attachment_json: email.attachment_json ?? null,
    timestamp_email: ts,
    timestamp_created: email.timestamp_created ?? null,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Instantly tags its own AI interest read directly onto each synced email
 * (ai_interest_value) — but campaign_leads.interest_status (what the Unibox
 * "Instantly status" filter and dashboard hot/cold counts actually read) was
 * previously only ever written by the dedicated lead_interested-family webhook
 * event. If that event was missed, delayed, or failed to resolve a campaign_lead,
 * the CRM status silently stayed null even though the raw synced email already
 * proved Instantly had classified the lead — leads showed as "Interested" on a
 * per-email basis but never surfaced in the filter.
 *
 * Only fills a currently-null status (never overwrites an existing value, whether
 * set by the webhook or by a human override) so this can't clobber anything.
 */
async function backfillInterestFromEmail(
  db: Db,
  campaignLeadId: string | null,
  direction: string,
  aiInterestValue: number | null | undefined,
): Promise<void> {
  if (!campaignLeadId || direction !== "received" || aiInterestValue == null) return;

  const { data: cl } = await db
    .from("campaign_leads")
    .select("interest_status")
    .eq("id", campaignLeadId)
    .maybeSingle();
  if (!cl || cl.interest_status !== null) return;

  await db.from("campaign_leads").update({
    interest_status: aiInterestValue,
    lead_temperature: INTEREST_TO_TEMPERATURE[aiInterestValue] ?? null,
    updated_at: new Date().toISOString(),
  }).eq("id", campaignLeadId);
}

export async function ingestInstantlyEmail(
  db: Db,
  email: InstantlyEmail,
  opts?: {
    replyEventId?: string;
    masterCampaignId?: string | null;
    campaignLeadId?: string | null;
    sentBy?: string | null;
    inReplyToEmailId?: string | null;
  },
): Promise<void> {
  const masterId = opts?.masterCampaignId ?? await resolveMasterCampaignId(db, email.campaign_id);
  const leadEmail = normEmail(email.lead ?? email.from_address_email);
  const campaignLeadId = opts?.campaignLeadId ?? await resolveCampaignLead(db, masterId, leadEmail);
  const row = emailToRow(email, {
    masterCampaignId: masterId,
    campaignLeadId,
    replyEventId: opts?.replyEventId,
    sentBy: opts?.sentBy,
    inReplyToEmailId: opts?.inReplyToEmailId,
  });

  const { data: existing } = await db
    .from("unibox_emails")
    .select("id, body_text, body_html")
    .eq("instantly_email_id", email.id)
    .maybeSingle();

  if (existing) {
    // sent_by and in_reply_to_email_id are deliberately excluded here — a later
    // resync/webhook re-ingest of the same message carries neither, so listing
    // them would blank the ones we recorded at send time (review §4.2).
    await db.from("unibox_emails").update({
      thread_id: row.thread_id,
      campaign_id: row.campaign_id,
      campaign_lead_id: row.campaign_lead_id,
      reply_event_id: row.reply_event_id ?? undefined,
      is_unread: row.is_unread,
      is_auto_reply: row.is_auto_reply,
      is_focused: row.is_focused,
      i_status: row.i_status,
      synced_at: row.synced_at,
      updated_at: row.updated_at,
      ...(existing.body_text ? {} : { body_text: row.body_text, body_html: row.body_html, content_preview: row.content_preview }),
    }).eq("id", existing.id);
  } else {
    await db.from("unibox_emails").insert(row);
  }

  await backfillInterestFromEmail(db, campaignLeadId, row.direction, email.ai_interest_value ?? null);
}

export async function sendThreadReply(
  db: Db,
  opts: {
    replyToUuid: string;
    eaccount: string;
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    /** Extra To recipients beyond the answered message's sender (reply-all). */
    additionalTo?: string[];
    cc?: string[];
    bcc?: string[];
    campaignLeadId?: string | null;
    campaignId?: string | null;
    replyEventId?: string | null;
    source: "unibox" | "campaign_replies";
    replyDraftId?: string;
    // Who triggered this send — records accountability for who actually sent
    // a reply when multiple people may have access to the same thread
    // (review §4.2).
    sentBy?: string;
  },
): Promise<{ instantlyEmailId: string; threadId: string | null }> {
  const sent = await replyToInstantlyEmail({
    replyToUuid: opts.replyToUuid,
    eaccount: opts.eaccount,
    subject: opts.subject,
    bodyHtml: opts.bodyHtml,
    bodyText: opts.bodyText,
    additionalTo: opts.additionalTo,
    cc: opts.cc,
    bcc: opts.bcc,
  });

  await ingestInstantlyEmail(db, sent, {
    replyEventId: opts.replyEventId ?? undefined,
    masterCampaignId: opts.campaignId ?? undefined,
    campaignLeadId: opts.campaignLeadId ?? undefined,
    sentBy: opts.sentBy ?? null,
    // Recorded, not inferred: with several To addresses possible, the recipient
    // list no longer identifies which message this answered.
    inReplyToEmailId: opts.replyToUuid,
  });

  // Remember every address this reply reached for the sender's autocomplete
  // (failures are logged inside).
  if (opts.sentBy) {
    void rememberReplyAddresses(db, opts.sentBy, [
      ...(opts.additionalTo ?? []),
      ...(opts.cc ?? []),
      ...(opts.bcc ?? []),
    ]);
  }

  const now = new Date().toISOString();

  if (opts.replyDraftId) {
    await db.from("reply_drafts").update({
      status: "sent",
      sent_at: now,
      updated_at: now,
    }).eq("id", opts.replyDraftId);
  } else {
    let replyEventId = opts.replyEventId;
    if (!replyEventId && opts.campaignLeadId) {
      const { data: ev } = await db
        .from("reply_events")
        .select("id")
        .eq("campaign_lead_id", opts.campaignLeadId)
        .eq("event_type", "reply_received")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      replyEventId = ev?.id ?? null;
    }

    const { data: latest } = await db
      .from("reply_drafts")
      .select("version")
      .eq("campaign_lead_id", opts.campaignLeadId ?? "")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    await db.from("reply_drafts").insert({
      reply_event_id: replyEventId,
      campaign_lead_id: opts.campaignLeadId,
      campaign_id: opts.campaignId,
      subject: opts.subject,
      body: opts.bodyText ?? opts.bodyHtml.replace(/<br\s*\/?>/gi, "\n"),
      status: "sent",
      reply_to_uuid: opts.replyToUuid,
      eaccount: opts.eaccount,
      version: (latest?.version ?? 0) + 1,
      sent_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  if (opts.campaignLeadId) {
    await db.from("campaign_leads").update({ updated_at: now }).eq("id", opts.campaignLeadId);
  }

  return { instantlyEmailId: sent.id, threadId: sent.thread_id ?? null };
}

export async function setLeadInterestStatus(
  db: Db,
  opts: { leadEmail: string; interestValue: number | null; actorId?: string; campaignLeadId?: string | null },
): Promise<void> {
  await updateLeadInterestStatus({
    leadEmail: opts.leadEmail,
    interestValue: opts.interestValue,
    disableAutoInterest: true,
  });

  const temperature = opts.interestValue !== null
    ? (INTEREST_TO_TEMPERATURE[opts.interestValue] ?? null)
    : null;

  const patch: Record<string, unknown> = {
    interest_status: opts.interestValue,
    lead_temperature: temperature,
    updated_at: new Date().toISOString(),
  };

  if (opts.campaignLeadId) {
    // Scoped to the exact campaign this thread belongs to. A lead can be enrolled
    // in several campaigns at once (each with its own campaign_leads row) — setting
    // status from one thread must not bleed into the others.
    await db.from("campaign_leads").update(patch).eq("id", opts.campaignLeadId);
  } else {
    // Fallback for the rare case where this thread's campaign_lead couldn't be
    // resolved at all — only reachable when ingest never linked a campaign_lead_id.
    const { data: leads } = await db.from("leads").select("id").eq("email", opts.leadEmail);
    const leadIds = (leads ?? []).map((l) => l.id);
    if (leadIds.length === 0) return;
    await db.from("campaign_leads").update(patch).in("lead_id", leadIds);
  }

  if (opts.actorId) {
    await db.from("audit_log").insert({
      actor_id: opts.actorId,
      action: "unibox_status_change",
      entity_type: "lead",
      diff: { lead_email: opts.leadEmail, interest_value: opts.interestValue },
      created_at: new Date().toISOString(),
    });
  }
}

export async function markThreadRead(db: Db, threadId: string): Promise<void> {
  await db.from("unibox_emails").update({
    is_unread: false,
    updated_at: new Date().toISOString(),
  }).eq("thread_id", threadId);
  markInstantlyThreadAsRead(threadId).catch(() => {});
}

export async function markThreadUnread(db: Db, threadId: string): Promise<void> {
  await db.from("unibox_emails").update({
    is_unread: true,
    updated_at: new Date().toISOString(),
  }).eq("thread_id", threadId).eq("direction", "received");
}

function sanitizeBodyHtml(html: string | null): string | null {
  if (!html) return null;
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "a", "b", "strong", "i", "em", "ul", "ol", "li", "blockquote", "img", "table", "thead", "tbody", "tr", "td", "th", "div", "span"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });
}

async function loadLeadInterestMap(db: Db, leadEmails: string[]): Promise<Map<string, { interest_status: number | null; lead_temperature: string | null; campaign_lead_id: string | null }>> {
  const map = new Map<string, { interest_status: number | null; lead_temperature: string | null; campaign_lead_id: string | null }>();
  if (leadEmails.length === 0) return map;

  const { data: leads } = await db.from("leads").select("id, email").in("email", leadEmails);
  const leadIdByEmail = new Map((leads ?? []).map((l) => [l.email as string, l.id as string]));
  const leadIds = [...leadIdByEmail.values()];
  if (leadIds.length === 0) return map;

  const { data: cls } = await db
    .from("campaign_leads")
    .select("id, lead_id, interest_status, lead_temperature, updated_at")
    .in("lead_id", leadIds)
    .order("updated_at", { ascending: false });

  for (const cl of cls ?? []) {
    const email = [...leadIdByEmail.entries()].find(([, id]) => id === cl.lead_id)?.[0];
    if (!email || map.has(email)) continue;
    map.set(email, {
      interest_status: cl.interest_status as number | null,
      lead_temperature: cl.lead_temperature as string | null,
      campaign_lead_id: cl.id as string,
    });
  }
  return map;
}

/**
 * A lead can be enrolled in several campaigns at once, each with its own
 * campaign_leads row (and its own interest_status). Unlike loadLeadInterestMap
 * (which merges across campaigns by "most recently touched" and can surface the
 * wrong campaign's status for a given thread), this scopes the lookup to the
 * exact campaign_lead_id each unibox thread already carries — matching how
 * getThreadMessages resolves status for the detail view.
 */
async function loadCampaignLeadStatusMap(
  db: Db,
  campaignLeadIds: string[],
): Promise<Map<string, { interest_status: number | null; lead_temperature: string | null; campaign_lead_id: string | null }>> {
  const map = new Map<string, { interest_status: number | null; lead_temperature: string | null; campaign_lead_id: string | null }>();
  if (campaignLeadIds.length === 0) return map;

  const { data: cls } = await db
    .from("campaign_leads")
    .select("id, interest_status, lead_temperature")
    .in("id", campaignLeadIds);

  for (const cl of cls ?? []) {
    map.set(cl.id as string, {
      interest_status: cl.interest_status as number | null,
      lead_temperature: cl.lead_temperature as string | null,
      campaign_lead_id: cl.id as string,
    });
  }
  return map;
}

// Filter predicates live in lib/unibox-filters.ts — pure, importable without a
// database, and covered case by case in unibox-filters.test.ts. They decide
// which conversations a user can see, which is too important to leave in a
// module no test can load.

/**
 * The employee visibility boundary (spec §7): a message is in scope ONLY when
 * its campaign_lead's lead is assigned to the employee — campaign access alone
 * is not enough, so a co-worker's threads in a shared campaign stay hidden.
 * Managers pass no scope (see everything).
 *
 * This is the employee's user id, NOT the list of campaign_lead ids they own.
 * It used to be the list, expanded into a `campaign_lead_id.in.(...)` filter —
 * but that filter travels in the request URL, so it grew by ~37 bytes per
 * assigned lead. At ~400 leads it blew past the gateway's URL limit and every
 * Unibox request came back "Bad Request", which the caller silently read as
 * zero rows: the employee saw an empty inbox under every filter. One employee
 * with 971 assigned leads hit exactly that. Filtering through the join keeps
 * the request a constant size no matter how many leads someone owns.
 */
export type UniboxScope = { assigned_to: string };

/**
 * Embed that turns the scope into a join filter instead of a URL id-list. The
 * `!inner` joins also drop messages with no campaign_lead, which the old
 * id-list excluded too.
 *
 * Applied as `.select(scopeSelect(cols, scope))` followed by the two
 * `.eq("campaign_leads.leads.…")` filters — inlined at each call site rather
 * than wrapped in a helper, because a generic query-builder wrapper makes
 * tsc give up with "type instantiation is excessively deep".
 */
const SCOPE_EMBED = "campaign_leads!inner(leads!inner(assigned_to, is_deleted))";

const scopeSelect = (cols: string, scope: UniboxScope | undefined) =>
  scope ? `${cols}, ${SCOPE_EMBED}` : cols;

/**
 * A unibox_emails row as read here. Untyped on purpose: this client carries no
 * schema generic (rows were already `any` before), and building the select
 * string conditionally defeats supabase-js's select-string inference.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UniboxEmailRow = Record<string, any>;

/** Strip characters that would break out of a PostgREST `.or(...ilike...)` filter. */
function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()"\\]/g, " ").trim();
}

export async function getThreads(db: Db, filters: {
  tab?: UniboxTab;
  campaign_id?: string;
  campaign_ids?: string[];
  eaccount?: string;
  q?: string;
  unread_only?: boolean;
  read_state?: UniboxReadState;
  interest_status?: number | "lead";
  cursor?: string;
  limit?: number;
  scope?: UniboxScope;
  /**
   * Include threads the lead has never answered (a pure outbound campaign
   * send). The Unibox wants these — it is a mailbox, not a reply queue. The
   * campaign Outbox does NOT: it renders inbound messages only, so an
   * unanswered thread would show up there as an empty row.
   */
  include_unreplied?: boolean;
}): Promise<{
  threads: UniboxThreadSummary[];
  next_cursor: string | null;
  counts: { unread_total: number; total: number };
}> {
  const limit = filters.limit ?? 30;

  let query = db
    .from("unibox_emails")
    .select(scopeSelect("*", filters.scope))
    .not("thread_id", "is", null);

  if (filters.scope) {
    query = query
      .eq("campaign_leads.leads.assigned_to", filters.scope.assigned_to)
      .eq("campaign_leads.leads.is_deleted", false);
  }

  if (filters.campaign_ids && filters.campaign_ids.length > 0) {
    query = query.in("campaign_id", filters.campaign_ids);
  } else if (filters.campaign_id) {
    query = query.eq("campaign_id", filters.campaign_id);
  }
  if (filters.eaccount) query = query.eq("eaccount", filters.eaccount);

  let nameMatchEmails = new Set<string>();
  const search = filters.q?.trim() ? sanitizeSearch(filters.q) : "";
  if (search) {
    query = query.or(`lead_email.ilike.%${search}%,subject.ilike.%${search}%,from_email.ilike.%${search}%`);
    const { data: nameHits } = await db
      .from("leads")
      .select("email")
      .or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    nameMatchEmails = new Set((nameHits ?? []).map((l) => (l.email as string).toLowerCase()));
  }

  const { data: rows, error } = await query.order("timestamp_email", { ascending: false }).limit(2000);
  // Never swallow this. Reading a failed request as "no rows" is what turned a
  // rejected over-long URL into a silently empty inbox that looked like the
  // filters were broken — an error the user can see is far cheaper to diagnose.
  if (error) throw new Error(`unibox getThreads query failed: ${error.message}`);
  const all = (rows ?? []) as UniboxEmailRow[];

  const threadMap = new Map<string, typeof all>();
  for (const r of all) {
    if (!r.thread_id) continue;
    if (filters.tab && !matchesTab(filters.tab, { is_focused: r.is_focused, is_auto_reply: r.is_auto_reply })) continue;
    if (!threadMap.has(r.thread_id)) threadMap.set(r.thread_id, []);
    threadMap.get(r.thread_id)!.push(r);
  }

  // Include threads whose lead email matches a name search even if email row didn't match query filter
  if (nameMatchEmails.size > 0) {
    let extraQuery = db
      .from("unibox_emails")
      .select(scopeSelect("*", filters.scope))
      .not("thread_id", "is", null)
      .in("lead_email", [...nameMatchEmails]);

    if (filters.scope) {
      extraQuery = extraQuery
        .eq("campaign_leads.leads.assigned_to", filters.scope.assigned_to)
        .eq("campaign_leads.leads.is_deleted", false);
    }

    const { data: extraRows } = await extraQuery;
    for (const r of (extraRows ?? []) as UniboxEmailRow[]) {
      if (!r.thread_id) continue;
      if (filters.tab && !matchesTab(filters.tab, { is_focused: r.is_focused, is_auto_reply: r.is_auto_reply })) continue;
      if (!campaignMatches(r.campaign_id, filters)) continue;
      if (filters.eaccount && r.eaccount !== filters.eaccount) continue;
      if (!threadMap.has(r.thread_id)) threadMap.set(r.thread_id, []);
      const existing = threadMap.get(r.thread_id)!;
      if (!existing.some((e) => e.id === r.id)) existing.push(r);
    }
  }

  const threadRows = Array.from(threadMap.values()).flat();
  const leadEmails = [...new Set([...all, ...threadRows].map((r) => r.lead_email).filter(Boolean))] as string[];
  const interestMap = await loadLeadInterestMap(db, leadEmails);
  const campaignLeadIds = [...new Set(threadRows.map((r) => r.campaign_lead_id).filter(Boolean))] as string[];
  const statusByCampaignLead = await loadCampaignLeadStatusMap(db, campaignLeadIds);

  // Batched up front (instead of one query per thread inside the loop below) —
  // with ~100+ threads that N+1 pattern was slow enough to open a wide race
  // window where an older, unfiltered request could resolve after a newer
  // filtered one and silently overwrite it (see unibox-client.tsx loadThreads).
  type LeadLookup = { first_name: string | null; last_name: string | null; title: string | null; email: string };
  const leadByEmail = new Map<string, LeadLookup>();
  if (leadEmails.length > 0) {
    const { data: leadRows } = await db.from("leads").select("first_name, last_name, title, email").in("email", leadEmails);
    for (const l of leadRows ?? []) leadByEmail.set(l.email as string, l as unknown as LeadLookup);
  }
  const campaignIdsForLookup = [...new Set(threadRows.map((r) => r.campaign_id).filter(Boolean))] as string[];
  const campaignById = new Map<string, { id: string; name: string }>();
  if (campaignIdsForLookup.length > 0) {
    const { data: campaignRows } = await db.from("campaigns").select("id, name").in("id", campaignIdsForLookup);
    for (const c of campaignRows ?? []) campaignById.set(c.id as string, { id: c.id as string, name: c.name as string });
  }

  const summaries: UniboxThreadSummary[] = [];
  const latestUnreadAtByThread = new Map<string, string>();
  for (const [threadId, msgs] of threadMap) {
    msgs.sort((a, b) => String(a.timestamp_email).localeCompare(String(b.timestamp_email)));
    const latest = msgs[msgs.length - 1];
    const hasReceived = msgs.some((m) => m.direction === "received");
    if (!hasReceived && !filters.include_unreplied) continue;

    const leadEmail = latest.lead_email;
    const interest = (latest.campaign_lead_id ? statusByCampaignLead.get(latest.campaign_lead_id) : undefined)
      ?? (leadEmail ? interestMap.get(leadEmail) : undefined);

    const lead: UniboxThreadSummary["lead"] = (leadEmail && leadByEmail.get(leadEmail)) || null;

    if (filters.q?.trim()) {
      const q = filters.q.trim().toLowerCase();
      const matches =
        (leadEmail ?? "").toLowerCase().includes(q)
        || msgs.some((m) => (m.subject ?? "").toLowerCase().includes(q))
        || msgs.some((m) => (m.from_email ?? "").toLowerCase().includes(q))
        || (lead?.first_name ?? "").toLowerCase().includes(q)
        || (lead?.last_name ?? "").toLowerCase().includes(q)
        || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.toLowerCase().includes(q);
      if (!matches) continue;
    }

    const unreadInbound = msgs.filter((m) => m.direction === "received" && m.is_unread);
    if (unreadInbound.length > 0) {
      latestUnreadAtByThread.set(threadId, String(unreadInbound[unreadInbound.length - 1].timestamp_email));
    }

    const campaign: { id: string; name: string } | null = (latest.campaign_id && campaignById.get(latest.campaign_id)) || null;

    // Per-person outstanding questions, not "is the last message inbound".
    const outstanding = unansweredInbound(
      msgs as unknown as ParticipantMessage[],
      ourAddresses(msgs as unknown as ParticipantMessage[], [latest.eaccount]),
    );

    const summary: UniboxThreadSummary = {
      thread_id: threadId,
      lead_email: leadEmail,
      lead,
      campaign,
      eaccount: latest.eaccount,
      subject: latest.subject,
      preview: latest.content_preview,
      latest_at: latest.timestamp_email,
      latest_direction: latest.direction,
      has_reply: hasReceived,
      needs_reply: outstanding.length > 0,
      awaiting_reply_from: [
        ...new Set(outstanding.map((m) => parseAddressList(m.from_email)[0]).filter(Boolean)),
      ] as string[],
      unread_count: unreadInbound.length,
      message_count: msgs.length,
      interest_status: interest?.interest_status ?? null,
      lead_temperature: interest?.lead_temperature ?? null,
      campaign_lead_id: latest.campaign_lead_id ?? interest?.campaign_lead_id ?? null,
    };

    if (filters.interest_status !== undefined && !matchesInterestFilter(filters.interest_status, summary.interest_status)) {
      continue;
    }

    summaries.push(summary);
  }

  const unread_total = summaries.reduce((n, t) => n + t.unread_count, 0);

  const effectiveReadState: UniboxReadState | undefined =
    filters.read_state ?? (filters.unread_only ? "unread" : undefined);

  const visible = effectiveReadState
    ? summaries.filter((t) => matchesReadState(effectiveReadState, t))
    : summaries;

  if (effectiveReadState === "unread") {
    visible.sort((a, b) => {
      const au = latestUnreadAtByThread.get(a.thread_id) ?? "";
      const bu = latestUnreadAtByThread.get(b.thread_id) ?? "";
      return bu.localeCompare(au);
    });
  } else if (effectiveReadState) {
    visible.sort((a, b) => b.latest_at.localeCompare(a.latest_at));
  } else {
    visible.sort((a, b) => {
      // Same per-person rule as the filter, so the default order and the
      // "Needs reply" tab can never disagree about what is outstanding.
      const aNeeds = a.needs_reply;
      const bNeeds = b.needs_reply;
      if (aNeeds && !bNeeds) return -1;
      if (!aNeeds && bNeeds) return 1;
      if (aNeeds && bNeeds) return a.latest_at.localeCompare(b.latest_at);
      return b.latest_at.localeCompare(a.latest_at);
    });
  }

  let start = 0;
  if (filters.cursor) {
    const idx = visible.findIndex((t) => t.latest_at === filters.cursor);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = visible.slice(start, start + limit);
  const next_cursor = start + limit < visible.length ? page[page.length - 1]?.latest_at ?? null : null;

  return { threads: page, next_cursor, counts: { unread_total, total: visible.length } };
}

export async function getThreadMessages(db: Db, threadId: string): Promise<{
  thread_id: string;
  messages: UniboxMessage[];
  reply_drafts: Record<string, unknown>[];
  lead: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
  reply_to_uuid: string | null;
  eaccount: string | null;
  campaign_lead_id: string | null;
  interest_status: number | null;
  lead_temperature: string | null;
  /** Addresses on this thread that are already live leads — so the UI never
   *  offers to add someone who is one, and never hides that they are. */
  known_lead_emails: string[];
  /** Organisation and owner a promoted participant would inherit. */
  lead_organization_name: string | null;
  lead_owner_name: string | null;
}> {
  const { data: rows } = await db
    .from("unibox_emails")
    .select("*")
    .eq("thread_id", threadId)
    .order("timestamp_email", { ascending: true });

  const msgs = rows ?? [];
  const latestReceived = [...msgs].reverse().find((m) => m.direction === "received");

  let reply_drafts: Record<string, unknown>[] = [];
  const campaignLeadId = msgs.find((m) => m.campaign_lead_id)?.campaign_lead_id ?? null;
  if (campaignLeadId) {
    const { data: drafts } = await db
      .from("reply_drafts")
      .select("*")
      .eq("campaign_lead_id", campaignLeadId)
      .order("created_at", { ascending: true });
    reply_drafts = (drafts ?? []) as Record<string, unknown>[];
  }

  const leadEmail = msgs.find((m) => m.lead_email)?.lead_email ?? null;
  let lead: Record<string, unknown> | null = null;
  // Where a promoted participant would land. Resolved here rather than embedded,
  // because a PostgREST embed on assigned_to depends on an FK name this table
  // has changed before.
  let lead_organization_name: string | null = null;
  let lead_owner_name: string | null = null;
  if (leadEmail) {
    const { data: l } = await db.from("leads").select("*").eq("email", leadEmail).maybeSingle();
    lead = l;
    if (l?.organization_id) {
      const { data: org } = await db.from("organizations").select("name").eq("id", l.organization_id).maybeSingle();
      lead_organization_name = (org?.name as string | null) ?? null;
    }
    if (l?.assigned_to) {
      const { data: owner } = await db.from("profiles").select("full_name, email").eq("id", l.assigned_to).maybeSingle();
      lead_owner_name = (owner?.full_name as string | null) || (owner?.email as string | null) || null;
    }
  }

  const campaignId = msgs.find((m) => m.campaign_id)?.campaign_id ?? null;
  let campaign: Record<string, unknown> | null = null;
  if (campaignId) {
    const { data: c } = await db.from("campaigns").select("id, name").eq("id", campaignId).maybeSingle();
    campaign = c;
  }

  // Resolve sender names for accountability (review §4.2) — only messages we
  // sent ourselves carry sent_by; everything else stays anonymous/null.
  const senderIds = [...new Set(msgs.map((m) => m.sent_by).filter(Boolean))] as string[];
  const senderNames = new Map<string, string>();
  if (senderIds.length > 0) {
    const { data: senders } = await db.from("profiles").select("id, full_name, email").in("id", senderIds);
    for (const s of senders ?? []) senderNames.set(s.id, s.full_name || s.email);
  }

  // Which of this thread's participants are already leads. One query over the
  // addresses actually present, rather than a per-participant lookup from the
  // client.
  const participantEmails = [...new Set(
    msgs.flatMap((m) => [
      ...parseAddressList(m.from_email),
      ...parseAddressList(m.to_emails),
      ...parseAddressList(m.cc_emails),
    ]),
  )];
  let known_lead_emails: string[] = [];
  if (participantEmails.length > 0) {
    const { data: knownLeads } = await db
      .from("leads")
      .select("email")
      .in("email", participantEmails)
      .eq("is_deleted", false);
    known_lead_emails = (knownLeads ?? []).map((l) => (l.email as string).toLowerCase());
  }

  let interest_status: number | null = null;
  let lead_temperature: string | null = null;
  if (campaignLeadId) {
    const { data: cl } = await db
      .from("campaign_leads")
      .select("interest_status, lead_temperature")
      .eq("id", campaignLeadId)
      .maybeSingle();
    interest_status = cl?.interest_status ?? null;
    lead_temperature = cl?.lead_temperature ?? null;
  }

  return {
    thread_id: threadId,
    messages: msgs.map((m) => ({
      id: m.id,
      instantly_email_id: m.instantly_email_id,
      direction: m.direction,
      subject: m.subject,
      from_email: m.from_email,
      to_emails: m.to_emails,
      cc_emails: m.cc_emails,
      body_html: sanitizeBodyHtml(m.body_html),
      body_text: m.body_text,
      step: m.step,
      timestamp_email: m.timestamp_email,
      is_unread: m.is_unread,
      attachments: m.attachment_json,
      reply_event_id: m.reply_event_id as string | null,
      sent_by: (m.sent_by as string | null) ?? null,
      sent_by_name: m.sent_by ? (senderNames.get(m.sent_by as string) ?? null) : null,
      in_reply_to_email_id: (m.in_reply_to_email_id as string | null) ?? null,
    })),
    reply_drafts,
    lead,
    campaign,
    reply_to_uuid: latestReceived?.instantly_email_id ?? null,
    eaccount: latestReceived?.eaccount ?? msgs.find((m) => m.eaccount)?.eaccount ?? null,
    campaign_lead_id: campaignLeadId,
    interest_status,
    lead_temperature,
    known_lead_emails,
    lead_organization_name,
    lead_owner_name,
  };
}

/**
 * Validate a caller-supplied reply target against the thread it claims to be on.
 *
 * NEVER trust this id from the client. reply_to_uuid is the only thing that
 * decides who actually receives the mail (Instantly has no To field — it
 * addresses the reply to the sender of this message), so an unchecked id would
 * let any authenticated user drop a reply into somebody else's conversation.
 * `db` is the caller's scoped client, so company scoping is enforced too.
 *
 * Returns null unless the id is an INBOUND message on `threadId` — replying to
 * one of our own sent messages would just address it back at ourselves.
 */
export async function resolveReplyTarget(
  db: Db,
  threadId: string,
  instantlyEmailId: string,
): Promise<{ instantlyEmailId: string; eaccount: string | null } | null> {
  const { data } = await db
    .from("unibox_emails")
    .select("instantly_email_id, eaccount, direction")
    .eq("thread_id", threadId)
    .eq("instantly_email_id", instantlyEmailId)
    .maybeSingle();
  if (!data || data.direction !== "received") return null;
  return {
    instantlyEmailId: data.instantly_email_id as string,
    eaccount: (data.eaccount as string | null) ?? null,
  };
}

/** Thread a given Instantly message belongs to. reply_drafts rows carry a
 *  reply_to_uuid but no thread id, so retargeting a draft has to find its
 *  thread this way before resolveReplyTarget can check the new target. */
export async function threadIdForInstantlyEmail(
  db: Db,
  instantlyEmailId: string,
): Promise<string | null> {
  const { data } = await db
    .from("unibox_emails")
    .select("thread_id")
    .eq("instantly_email_id", instantlyEmailId)
    .maybeSingle();
  return (data?.thread_id as string | null) ?? null;
}

export async function hydrateThreadIfStale(db: Db, threadId: string): Promise<void> {
  const last = hydrateCooldown.get(threadId) ?? 0;
  if (Date.now() - last < HYDRATE_COOLDOWN_MS) return;

  const { data: rows } = await db
    .from("unibox_emails")
    .select("id, body_html, instantly_email_id")
    .eq("thread_id", threadId);

  const missing = (rows ?? []).some((r) => !r.body_html);
  if (!missing) return;

  hydrateCooldown.set(threadId, Date.now());
  const emails = await listThreadEmails(threadId);
  for (const email of emails) {
    await ingestInstantlyEmail(db, email);
  }
}

export async function getUnreadCount(db: Db, scope?: UniboxScope): Promise<number> {
  let q = db
    .from("unibox_emails")
    .select(scopeSelect("thread_id", scope), { count: "exact", head: true })
    .eq("is_unread", true)
    .eq("direction", "received");

  if (scope) {
    q = q
      .eq("campaign_leads.leads.assigned_to", scope.assigned_to)
      .eq("campaign_leads.leads.is_deleted", false);
  }

  const { count, error } = await q;
  if (error) console.error("[unibox] unread count query failed:", error.message);
  return count ?? 0;
}

type SyncState = { last_timestamp_created: string | null; last_full_sync_at: string | null };

// The cursor lives in `system_state`, not `settings`: both companies share one
// Instantly workspace and this function does ONE pass over it, so there is
// exactly one cursor. It also has to be writable by the unscoped cron client,
// which cannot satisfy settings.company_id (NOT NULL).
async function getSyncState(db: Db): Promise<SyncState> {
  const { data } = await db.from("system_state").select("value").eq("key", SYNC_STATE_KEY).maybeSingle();
  if (!data?.value) return { last_timestamp_created: null, last_full_sync_at: null };
  try {
    return JSON.parse(data.value) as SyncState;
  } catch {
    return { last_timestamp_created: null, last_full_sync_at: null };
  }
}

async function saveSyncState(db: Db, state: SyncState): Promise<void> {
  const now = new Date().toISOString();
  await db.from("system_state").upsert({
    key: SYNC_STATE_KEY,
    value: JSON.stringify(state),
    updated_at: now,
  }, { onConflict: "key" });
}

/**
 * The company that owns an Instantly sub-campaign. Null when the id is unknown
 * to us — an Instantly campaign created outside the app, or one whose row was
 * deleted. Takes the UNSCOPED client on purpose: the sync runs cross-company
 * and this lookup is what decides which company it is.
 */
async function resolveCompanyIdForEmail(db: Db, instantlyCampaignId: string | null | undefined): Promise<string | null> {
  if (!instantlyCampaignId) return null;
  const { data } = await db
    .from("instantly_campaigns")
    .select("company_id")
    .eq("instantly_campaign_id", instantlyCampaignId)
    .maybeSingle();
  return (data?.company_id as string | undefined) ?? null;
}

export async function runUniboxSync(db: Db, maxPages = 8): Promise<{ ingested: number; pages: number; failed: number; skippedUnmapped: number }> {
  const state = await getSyncState(db);
  const cursor = state.last_timestamp_created;
  let startingAfter: string | undefined;
  let ingested = 0;
  let failed = 0;
  let skippedUnmapped = 0;
  let pages = 0;
  let maxTs = cursor;
  // Oldest message we could not ingest this run. The cursor is never advanced
  // past it, so the next run retries it (and everything after it) instead of
  // silently leaving a hole in the mirror.
  let earliestFailedTs: string | null = null;

  // Whatever happens below, persist the progress we did make. Without this the
  // cursor only ever moved on a fully clean run, so one unluckily-shaped email
  // (or one Instantly hiccup on page 3) froze the inbox at its last good
  // timestamp and every later sync re-attempted — and re-failed on — the exact
  // same message. New mail then only ever arrived via the webhook or a campaign
  // Outbox backfill.
  try {
    for (let i = 0; i < maxPages; i++) {
      const result = await listEmails({
        limit: 100,
        sort_order: "asc",
        ...(cursor ? { min_timestamp_created: cursor } : {}),
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      pages++;
      for (const email of result.items) {
        try {
          // Both tenants share one Instantly workspace, so a page of results can
          // mix companies. The sub-campaign identifies the owner; ingest through
          // a client scoped to it so each message lands in the right tenant and
          // cannot be read by the other. An email we cannot attribute to any
          // campaign belongs to no tenant and would be invisible to every
          // scoped read anyway, so it is skipped rather than stored orphaned.
          const companyId = await resolveCompanyIdForEmail(db, email.campaign_id);
          if (!companyId) { skippedUnmapped++; continue; }
          await ingestInstantlyEmail(createScopedClient(companyId), email);
          ingested++;
        } catch (e) {
          // Skip it and keep going: one unusable message must not hold back
          // every message behind it.
          failed++;
          console.error(`[unibox-sync] ingest failed for ${email.id}:`, (e as Error).message);
          if (email.timestamp_created && (!earliestFailedTs || email.timestamp_created < earliestFailedTs)) {
            earliestFailedTs = email.timestamp_created;
          }
        }
        if (email.timestamp_created && (!maxTs || email.timestamp_created > maxTs)) {
          maxTs = email.timestamp_created;
        }
      }
      if (!result.next_starting_after || result.items.length === 0) break;
      startingAfter = result.next_starting_after;
    }
  } finally {
    await saveSyncState(db, {
      last_timestamp_created: earliestFailedTs ?? maxTs,
      last_full_sync_at: new Date().toISOString(),
    });
  }

  return { ingested, pages, failed, skippedUnmapped };
}

/** Build campaign replies thread shape from unibox data (Phase 2). */
export async function getCampaignReplyThreads(db: Db, campaignId: string) {
  // No Unibox primary/others tab filter — campaign Outbox should show every
  // inbound reply for the campaign, including messages Instantly puts in Others.
  const { threads } = await getThreads(db, { campaign_id: campaignId, limit: 500 });
  const out = [];

  for (const t of threads) {
    const detail = await getThreadMessages(db, t.thread_id);

    const { data: cl } = t.campaign_lead_id
      ? await db.from("campaign_leads").select(`
          id, lead_temperature, interest_status, crm_status, draft_id,
          leads:lead_id ( first_name, last_name, email, title ),
          email_drafts:draft_id ( subject, body )
        `).eq("id", t.campaign_lead_id).maybeSingle()
      : { data: null };

    const receivedMsgs = detail.messages.filter((m) => m.direction === "received");
    const messages = [];

    for (let i = 0; i < receivedMsgs.length; i++) {
      const m = receivedMsgs[i];
      const { data: row } = await db
        .from("unibox_emails")
        .select("reply_event_id")
        .eq("id", m.id)
        .maybeSingle();
      const eventId = row?.reply_event_id as string | null;
      const isLatest = i === receivedMsgs.length - 1;
      const drafts = pickDraftsForInboundMessage(
        detail.reply_drafts as Array<{ reply_event_id?: string | null }>,
        eventId,
        isLatest,
      );

      messages.push({
        id: m.id,
        event_type: "reply_received",
        reply_body: stripQuotedText(m.body_text) ?? m.body_text,
        received_at: m.timestamp_email,
        lead_email: t.lead_email,
        campaign_lead_id: t.campaign_lead_id,
        // Real headers. Anyone CC'd onto a thread can reply into it, so the
        // sender is NOT always the lead — the Outbox used to caption every
        // inbound message with the lead's name and every outbound one as going
        // to the lead, which is false the moment a third party joins.
        instantly_email_id: m.instantly_email_id,
        from_email: m.from_email,
        to_emails: m.to_emails,
        cc_emails: m.cc_emails,
        reply_drafts: drafts,
      });
    }

    // Outbound replies read from the mirrored mail itself rather than
    // reconstructed from reply_drafts: a draft records what we composed, only
    // the sent message records who actually received it.
    const sentMessages = detail.messages
      .filter((m) => m.direction === "sent_manual")
      .map((m) => ({
        id: m.id,
        instantly_email_id: m.instantly_email_id,
        from_email: m.from_email,
        to_emails: m.to_emails,
        cc_emails: m.cc_emails,
        body_html: m.body_html,
        body_text: m.body_text,
        sent_at: m.timestamp_email,
        sent_by_name: m.sent_by_name,
        in_reply_to_email_id: m.in_reply_to_email_id,
      }));

    out.push({
      thread_key: t.thread_id,
      campaign_lead_id: t.campaign_lead_id,
      lead_email: t.lead_email,
      lead: (cl?.leads as unknown) ?? t.lead,
      original_email: cl?.email_drafts ?? null,
      latest_temperature: t.lead_temperature,
      latest_received_at: t.latest_at,
      messages,
      sent_messages: sentMessages,
      // Our mailbox on this thread, so the composer can keep it out of the CC
      // list it builds from the thread's participants.
      eaccount: detail.eaccount,
      known_lead_emails: detail.known_lead_emails,
      lead_organization_name: detail.lead_organization_name,
      lead_owner_name: detail.lead_owner_name,
    });
  }

  out.sort((a, b) => String(b.latest_received_at).localeCompare(String(a.latest_received_at)));
  return out;
}
