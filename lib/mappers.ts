import type { Lead, LeadStatus, LeadScore, LeadSource, EnrichmentStage } from "@/lib/leads";
import type { Campaign } from "@/components/app/create-campaign-modal";
import { campaignOutcomes } from "@/lib/campaign-status";

// ─── DB → frontend status maps ───────────────────────────────────────────────

export const LEAD_STATUS_MAP: Record<string, LeadStatus> = {
  new:            "New",
  enriching:      "Enriching",
  enriched:       "Enriched",
  input_required: "Input Required",
  open:           "Open",
  closed:         "Closed",
};

export const SOURCE_MAP: Record<string, LeadSource> = {
  apollo: "Apollo",
  excel:  "Excel",
  manual: "Manual",
};

// ─── DB row shapes ────────────────────────────────────────────────────────────

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
  import_id?: string | null;
  assigned_to?: string | null;
  imports?: { id: string; label: string; color: string } | null;
  campaign_name?: string | null;
  campaign_list?: { id: string; name: string; crm_status: string }[];
  // Whether this lead's org enrichment is shared with OTHER people's leads —
  // set only by the single-lead GET route (review §3.4). Org-level enrichment
  // fans out to every lead under that org regardless of owner; this lets the
  // viewer know their lead's data can change from someone else's trigger.
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
  attachment_name: string | null;
  hot_count: number;
  cold_count: number;
  created_by: string;
  assigned_to?: string | null;
  /** Non-null while sending is held. See campaigns.sending_held_at. */
  sending_held_at?: string | null;
  /** Server's verdict on whether the caller may edit Options/Sequences (EDGE_CASES.md §2.10). */
  can_edit_settings?: boolean;
}

// ─── Mapper functions ─────────────────────────────────────────────────────────

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
    attachmentName: c.attachment_name ?? undefined,
    hot: c.hot_count ?? 0,
    cold: c.cold_count ?? 0,
    createdBy: c.created_by,
    sendingHeldAt: c.sending_held_at ?? null,
    assignedTo: c.assigned_to ?? null,
    // Absent (an older payload) means "not allowed" — never assume edit rights
    // the server did not grant.
    canEditSettings: c.can_edit_settings === true,
  };
}
