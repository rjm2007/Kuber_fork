/** Per-campaign lead journey buckets (Campaign Kanban + Report stage donut). */

export type CampaignKanbanBucket =
  | "pending"
  | "draft"
  | "approved"
  | "sent"
  | "replied";

export type CampaignLeadLike = {
  crm_status: string;
  email_drafts?: { status: string } | { status: string }[] | null;
};

function unwrapDraft(
  raw: CampaignLeadLike["email_drafts"],
): { status: string } | null {
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

/** Kanban / journey stages — failed and in-progress drafts count as Pending. */
export function campaignBucket(cl: CampaignLeadLike): CampaignKanbanBucket {
  // Check crm_status FIRST — a replied lead stays in "Replied"
  // regardless of what the email_drafts.status says.
  if (cl.crm_status === "replied") return "replied";
  const ds = unwrapDraft(cl.email_drafts)?.status;
  if (ds === "approved") return "approved";
  if (ds === "sent") return "sent";
  if (ds === "draft") return "draft";
  return "pending";
}

export function isFailedDraft(cl: CampaignLeadLike): boolean {
  return unwrapDraft(cl.email_drafts)?.status === "failed";
}

/**
 * Where a lead stands with the OUTSIDE world — did a mail actually reach them?
 * Deliberately separate from campaignBucket above, which tracks our internal
 * draft pipeline.
 *
 * The distinction that matters: crm_status='sent' only means Instantly ACCEPTED
 * the lead into the sequence. It then drips the real send out over days at the
 * campaign's daily limit, and confirms each one with an email_sent webhook. So
 * 'sent' is "sending", and only the webhook (surfaced as `contacted` by the
 * campaign leads API) means it actually left.
 *
 * crm_status='failed' is doubly overloaded — set both on a bounce AND on a lead
 * Instantly refused at add-time. Only the bounce event tells them apart, and
 * they mean opposite things: bounced = we sent it and the mailbox rejected it;
 * send_failed = it was never sent at all.
 */
export type DeliveryBucket =
  | "not_queued"
  | "sending"
  | "sent"
  | "replied"
  | "bounced"
  | "send_failed";

export type DeliveryLeadLike = {
  crm_status: string;
  first_sent_at?: string | null;
  /** Highest Instantly sequence step actually delivered to this lead, from the
   *  email_sent webhooks (`reply_events.step`). Step 1 is the opening email, so
   *  step N is follow-up N-1. NULL/1 = no follow-up has gone out yet. */
  last_step_sent?: number | null;
  /** When the highest confirmed step (any step, including 1) actually went
   *  out — real reply_events/webhook timestamp, falling back to first_sent_at. */
  last_step_sent_at?: string | null;
  /** Which sequence step the address rejected (1 = the opening email). */
  bounced_step?: number | null;
};

/**
 * Exactly one bucket per lead — they are outcomes of the same mail, not badges
 * that stack. A replied or bounced lead was obviously sent; it just has a more
 * specific ending, so it is NOT also counted as "sent".
 */
export function deliveryBucket(cl: DeliveryLeadLike): DeliveryBucket {
  // 'failed' means two opposite things, and first_sent_at is what separates
  // them: set = we mailed them and the address rejected it; NULL = Instantly
  // refused the lead at add-time and nothing was ever sent.
  if (cl.crm_status === "failed") return cl.first_sent_at ? "bounced" : "send_failed";
  if (cl.crm_status === "replied") return "replied";
  if (cl.first_sent_at) return "sent";
  // crm_status='sent' is only Instantly ACCEPTING the lead; it drips the real
  // send out later and confirms it with the email_sent webhook.
  if (cl.crm_status === "sent") return "sending";
  return "not_queued";
}

/**
 * Split a campaign's stored counters into the mutually exclusive figures the UI
 * shows. sent_count is DELIVERED (it only ever grows, so the webhook can
 * increment it and reconcile-counters can verify it); a lead who then replied
 * or bounced has a more specific outcome and must leave the SENT tile rather
 * than be counted in two places at once.
 */
export function campaignOutcomes(c: {
  sent_count: number;
  replied_count: number;
  bounced_count?: number;
}): { sent: number; delivered: number; replied: number; bounced: number } {
  const delivered = c.sent_count ?? 0;
  const replied = c.replied_count ?? 0;
  const bounced = c.bounced_count ?? 0;
  return {
    delivered,
    replied,
    bounced,
    // Floored: counter drift must never render a negative tile. The nightly
    // reconcile recomputes all three from campaign_leads.
    sent: Math.max(0, delivered - replied - bounced),
  };
}

export const DELIVERY_BUCKET_LABELS: Record<DeliveryBucket, string> = {
  not_queued:  "Not queued",
  sending:     "Sending",
  sent:        "Sent 🤝",
  replied:     "Replied",
  bounced:     "Bounced",
  send_failed: "Send failed",
};

/**
 * Per-lead badge text. Same buckets as above — this only makes the "sent" one
 * say WHICH mail was the last to land, because `first_sent_at` is written once
 * on the opening email and never again, so a lead three follow-ups deep read
 * identically to one that had just been contacted.
 *
 * Derived from the highest step actually delivered, so a campaign with a single
 * follow-up can never render past "Follow-up 1 sent" — there is no step 3 to
 * report. No per-campaign cap to configure.
 *
 * Replied/send_failed keep their plain labels — which step triggered them is
 * timeline detail, not the headline. Bounced is the exception: see below.
 */
export function deliveryLabel(cl: DeliveryLeadLike): string {
  const bucket = deliveryBucket(cl);
  const step = cl.last_step_sent ?? 1;
  if (bucket === "sent" && step > 1) return `Follow-up ${step - 1} sent`;
  // Two very different stories wear the same red badge: an address that was dead
  // from the start (bounced on the opening mail, never chased again) and one that
  // died between sends — reachable in August, gone by the follow-up. Only the
  // second is worth a second look at the contact, so say which happened.
  const bStep = cl.bounced_step ?? 1;
  if (bucket === "bounced" && bStep > 1) return `Bounced on follow-up ${bStep - 1}`;
  return DELIVERY_BUCKET_LABELS[bucket];
}

/**
 * Human name for one send in the sequence.
 *
 * Instantly tags a campaign send `sequence_step_variant` — "0_0_0" is the
 * opening email, "0_1_0" the first follow-up — and the Unibox was printing that
 * raw as "Step 0_1_0", which tells a salesperson nothing. Also accepts the plain
 * one-based number `reply_events.step` stores, so both sources share one label.
 */
export function sequenceStepLabel(step: string | number | null | undefined): string | null {
  if (step === null || step === undefined || step === "") return null;
  const raw = String(step);
  const parts = raw.split("_");
  // Instantly's middle segment is a ZERO-based step index; a bare number is the
  // one-based step, so it has to come down by one to mean the same thing.
  const index = parts.length >= 2 ? Number(parts[1]) : Number(raw) - 1;
  if (!Number.isFinite(index) || index < 0) return null;
  return index === 0 ? "Opening email" : `Follow-up ${index}`;
}

/** Chip order in the leads filter — worst news last so it stays noticeable. */
export const DELIVERY_BUCKET_ORDER: DeliveryBucket[] = [
  "not_queued", "sending", "sent", "replied", "bounced", "send_failed",
];

/**
 * Recomputes the campaign-card / analytics-tab summary numbers (leads, sent,
 * replied, hot, cold) from a set of campaign_leads rows. Used to give an
 * employee their OWN scoped counts — the campaigns table's total_leads /
 * sent_count / replied_count / hot_count / cold_count columns are campaign-wide
 * and were never meant to be shown to an employee as-is (spec §5: a campaign
 * is a shared container, an employee only sees/counts their own leads in it).
 */
export type CampaignStatsRow = CampaignLeadLike & {
  lead_temperature?: string | null;
  first_sent_at?: string | null;
};

export function computeCampaignStats(rows: CampaignStatsRow[]): {
  total_leads: number;
  /** Delivered and nothing more — what the SENT tile shows. Excludes replied/bounced. */
  sent_count: number;
  /** Every lead a mail actually reached, replies and bounces included. The
   *  honest denominator for reply rate; never shown as "sent" on its own. */
  delivered_count: number;
  replied_count: number;
  bounced_count: number;
  hot_count: number;
  cold_count: number;
} {
  let sent_count = 0;
  let replied_count = 0;
  let bounced_count = 0;
  let hot_count = 0;
  let cold_count = 0;
  for (const r of rows) {
    // One bucket per lead, so these tiles sum to the delivered total instead of
    // double-counting a replied lead as sent too.
    switch (deliveryBucket(r)) {
      case "sent":    sent_count++;    break;
      case "replied": replied_count++; break;
      case "bounced": bounced_count++; break;
    }
    if (r.lead_temperature === "hot") hot_count++;
    if (r.lead_temperature === "cold") cold_count++;
  }
  return {
    total_leads: rows.length,
    sent_count,
    delivered_count: sent_count + replied_count + bounced_count,
    replied_count,
    bounced_count,
    hot_count,
    cold_count,
  };
}

export const CAMPAIGN_KANBAN_COLS: {
  id: CampaignKanbanBucket;
  label: string;
  dot: string;
  header: string;
}[] = [
  { id: "pending",  label: "Pending",    dot: "bg-zinc-400",   header: "border-zinc-500/30"  },
  { id: "draft",    label: "Draft Ready",dot: "bg-blue-400",   header: "border-blue-500/30"  },
  { id: "approved", label: "Certified",  dot: "bg-cyan-400",   header: "border-cyan-500/30"  },
  { id: "sent",     label: "Sent",       dot: "bg-teal-400",   header: "border-teal-500/30"  },
  { id: "replied",  label: "Replied",    dot: "bg-violet-400", header: "border-violet-500/30" },
];

export const CAMPAIGN_BUCKET_LABELS: Record<CampaignKanbanBucket, string> = {
  pending:  "Pending",
  draft:    "Draft Ready",
  approved: "Certified",
  sent:     "Sent",
  replied:  "Replied",
};
