import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { createHash } from "crypto";
import { INTEREST_TO_TEMPERATURE } from "@/lib/constants";
import { getInstantlyEmail } from "@/lib/services/instantly";
import { ingestInstantlyEmail } from "@/lib/services/unibox";
import { safeSecretEqual } from "@/lib/auth/secret";
import { findActiveLeadIdByEmail } from "@/lib/services/lead-lookup";
import { logLeadEvent, type LeadEventType } from "@/lib/services/lead-events";

const CRM_BY_EVENT: Record<string, string | undefined> = {
  reply_received:    "replied",
  email_bounced:     "failed",
  lead_unsubscribed: "closed",
};

// Instantly's webhook vocabulary → the lead's activity timeline. Anything absent
// here still lands in reply_events; it just isn't worth its own timeline line.
const LEAD_EVENT_BY_INSTANTLY_EVENT: Record<string, { event: LeadEventType; detail: (step: number | null) => string } | undefined> = {
  email_sent:        { event: "email_delivered", detail: (s) => (s && s > 1 ? `Follow-up email delivered (step ${s})` : "Email delivered to the lead's inbox") },
  email_opened:      { event: "email_opened",    detail: () => "Lead opened the email" },
  email_bounced:     { event: "email_bounced",   detail: () => "Email bounced — the address rejected it" },
  reply_received:    { event: "reply_received",  detail: () => "Lead replied" },
  lead_unsubscribed: { event: "unsubscribed",    detail: () => "Lead unsubscribed — outreach stopped for their whole company" },
};

// Instantly's own AI classifies replies into these; each is a timeline line of
// its own so the interest history is traceable, not just the latest value.
const INTEREST_DETAIL_BY_EVENT: Record<string, string | undefined> = {
  lead_interested:        "Marked interested",
  lead_meeting_booked:    "Meeting booked",
  lead_meeting_completed: "Meeting completed",
  lead_closed:            "Marked closed",
  lead_out_of_office:     "Out of office",
  lead_not_interested:    "Marked not interested",
  lead_wrong_person:      "Wrong person — not the right contact",
};

const INTEREST_BY_EVENT: Record<string, number | undefined> = {
  lead_interested:          1,
  lead_meeting_booked:      2,
  lead_meeting_completed:   3,
  lead_closed:              4,
  lead_out_of_office:       0,
  lead_not_interested:      -1,
  lead_wrong_person:        -2,
};

interface InstantlyWebhookPayload {
  event_type?: string;
  timestamp?: string;
  campaign_id?: string;    // Instantly's campaign UUID (our sub-campaign's instantly_campaign_id)
  campaign_name?: string;
  lead_email?: string;
  email_id?: string;       // reply_to_uuid — use to send reply via API
  step?: number;
  variant?: number;
  reply_text?: string;
  reply_html?: string;
  reply_text_snippet?: string;
  reply_subject?: string;
}

/**
 * Strips quoted-reply lines from an email plain-text body so only
 * the new content written by the sender is kept for display.
 * Stops at the first ">" line, "On ... wrote:" attribution, or "--" separator.
 */
function stripQuotedText(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(">")) break;
    if (/^On .+wrote:\s*$/.test(trimmed)) break;
    if (trimmed === "--" || trimmed === "\u2014") break;
    kept.push(line);
  }
  return kept.join("\n").trim() || null;
}

export async function POST(req: NextRequest) {
  // 1) Verify shared secret
  const secret = req.headers.get("x-webhook-secret");
  if (!safeSecretEqual(secret, process.env.INSTANTLY_WEBHOOK_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const p = await req.json().catch(() => null) as InstantlyWebhookPayload | null;
  if (!p?.event_type) return NextResponse.json({ ok: true });

  const db = createAdminClient();
  const receivedAt = p.timestamp ?? new Date().toISOString();
  // replyBody: stripped version for display in the Replies UI (no quoted chain).
  // It is also what the on-demand drafter reads back as the prospect's message.
  const replyBody = stripQuotedText(p.reply_text) ?? p.reply_text_snippet ?? null;

  // 2) Idempotency key (sha256 of timestamp+email+event+email_id)
  const eventUid = createHash("sha256")
    .update(`${receivedAt}|${p.lead_email ?? ""}|${p.event_type}|${p.email_id ?? ""}`)
    .digest("hex");

  // 3) Resolve Instantly campaign UUID → our sub + master
  //    p.campaign_id here is Instantly's UUID (instantly_campaigns.instantly_campaign_id)
  let subId: string | null = null;
  let masterId: string | null = null;
  let companyId: string | null = null;
  if (p.campaign_id) {
    const { data: sub } = await db
      .from("instantly_campaigns")
      .select("id,campaign_id,company_id")
      .eq("instantly_campaign_id", p.campaign_id)
      .maybeSingle();
    if (sub) { subId = sub.id; masterId = sub.campaign_id; companyId = sub.company_id; }
  }

  // Both tenants share one Instantly workspace, so Instantly posts every
  // company's replies to this single URL — the handler itself must be
  // cross-company. The sub-campaign is what identifies the owner, so from here
  // on use a client scoped to it: that keeps the lead lookup from matching a
  // same-email lead in the OTHER tenant, and stamps company_id on the rows
  // written below. Falls back to the unscoped client only for events we could
  // not attribute to a campaign at all, which are stored unmapped as before.
  const cdb = companyId ? createScopedClient(companyId) : db;

  // Resolved once and reused below: which lead this event is about. Steps 4/6/7
  // and the activity log all need it, and it cannot change mid-request.
  const leadId = p.lead_email ? await findActiveLeadIdByEmail(cdb, p.lead_email) : null;

  // 4) Resolve campaign_lead via master + lead
  let campaignLeadId: string | null = null;
  if (masterId && leadId) {
    const { data: cl } = await cdb
      .from("campaign_leads")
      .select("id")
      .eq("campaign_id", masterId)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (cl) {
      campaignLeadId = cl.id;
    } else if (p.event_type === "reply_received") {
      // We resolved the exact master campaign AND the lead, but they're no
      // longer linked in campaign_leads — the lead was removed from this
      // campaign (or the sub-campaign reference is stale) since the message
      // was sent. The reply_events row below still keeps the raw event, but
      // this specific "we knew the campaign, still couldn't attribute it"
      // case is worth a visible signal rather than vanishing silently into
      // an unmapped row nobody looks at (review §4.3).
      console.error(
        `[webhook] reply_received: campaign+lead resolved but no active campaign_leads link — ` +
        `master_campaign=${masterId} lead_id=${leadId} lead_email=${p.lead_email}`,
      );
      await cdb.from("audit_log").insert({
        action: "reply_unmapped_stale_campaign_link",
        entity_type: "reply_event",
        diff: { master_campaign_id: masterId, lead_id: leadId, lead_email: p.lead_email, instantly_sub_campaign: p.campaign_id ?? null },
        created_at: new Date().toISOString(),
      });
    }
  }

  // 5) Append event (idempotent — never dropped even if unmapped)
  // ON CONFLICT DO NOTHING ... RETURNING only returns genuinely-inserted rows,
  // so an empty result means Instantly re-delivered an event we already have.
  // The activity log below keys off that: without it, every webhook retry would
  // add another "Reply received" line to the lead's timeline.
  const { data: insertedEvents } = await cdb.from("reply_events").upsert(
    {
      event_uid:              eventUid,
      campaign_id:            masterId,
      instantly_campaign_id:  subId,
      campaign_lead_id:       campaignLeadId,
      event_type:             p.event_type,
      lead_email:             p.lead_email ?? null,
      email_id:               p.email_id ?? null,
      step:                   p.step ?? null,
      variant:                p.variant ?? null,
      reply_body:             replyBody,
      reply_subject:          p.reply_subject ?? null,
      received_at:            receivedAt,
      created_at:             new Date().toISOString(),
    },
    { onConflict: "event_uid", ignoreDuplicates: true },
  ).select("id");
  const isFirstDelivery = (insertedEvents?.length ?? 0) > 0;

  // 6) Update campaign_leads state (with lead_temperature for interest events)
  let interestApplied = false;
  if (campaignLeadId) {
    // Fetch current state BEFORE patching — needed for three guards below:
    // (1) only count a lead's FIRST reply toward replied_count (a lead replying twice
    //     must not push the reply rate above 100%),
    // (2) only increment hot_count/cold_count when Instantly's classification actually
    //     CHANGES for this lead — not on every duplicate/retried webhook delivery of the
    //     same event, which would otherwise double-count, and
    // (3) the cross-campaign echo check below.
    const { data: beforeState } = await cdb
      .from("campaign_leads")
      .select("crm_status, interest_status, last_reply_at, first_sent_at")
      .eq("id", campaignLeadId)
      .maybeSingle();
    const wasAlreadyReplied = beforeState?.crm_status === "replied";
    const previousInterest  = beforeState?.interest_status ?? null;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (CRM_BY_EVENT[p.event_type])                    patch.crm_status = CRM_BY_EVENT[p.event_type];
    const interest = INTEREST_BY_EVENT[p.event_type];
    if (interest !== undefined) {
      // Instantly classifies "interest" per LEAD, not per campaign thread — when
      // a lead replies in one campaign, it re-broadcasts the SAME classification
      // to every other campaign that lead is currently enrolled in too, even ones
      // they never said anything of the kind in. Confirmed live: two
      // lead_not_interested webhooks arrived 1ms apart for the same lead in two
      // different campaigns, only one of which actually got a negative reply.
      // Only the campaign whose thread is most recently active is trusted;
      // older campaign threads keep whatever status they already had. For a
      // lead in just one campaign (the common case) this is always true.
      let isFreshestThread = true;
      if (leadId) {
        const { data: siblings } = await cdb
          .from("campaign_leads")
          .select("id, last_reply_at")
          .eq("lead_id", leadId);
        if (siblings && siblings.length > 1) {
          const currentTime = beforeState?.last_reply_at ? new Date(beforeState.last_reply_at).getTime() : -Infinity;
          isFreshestThread = !siblings.some(
            (s) => s.id !== campaignLeadId && s.last_reply_at && new Date(s.last_reply_at).getTime() > currentTime,
          );
        }
      }
      if (isFreshestThread) {
        interestApplied = true;
        patch.interest_status = interest;
        // Instantly's own AI is the sole source of truth for lead_temperature (team
        // decision). We do not run our own LLM classifier on replies — our only LLM
        // pass over a reply is the human-triggered drafter, which never classifies.
        // This is the ONLY place in the codebase that sets lead_temperature.
        const temp = INTEREST_TO_TEMPERATURE[interest as number];
        if (temp) patch.lead_temperature = temp;
      }
    }
    if (p.event_type === "lead_unsubscribed") patch.lead_temperature = "unsubscribed";
    if (p.event_type === "reply_received") {
      patch.last_reply_at   = receivedAt;
      patch.last_reply_body = replyBody;
    }
    // THE moment a mail actually goes out. crm_status was already flipped to
    // 'sent' days earlier when Instantly merely accepted the lead, so this is
    // the only signal that separates "queued in the drip" from "delivered".
    // isFirstDelivery keeps a re-delivered webhook from moving the timestamp.
    if (p.event_type === "email_sent" && isFirstDelivery && !beforeState?.first_sent_at) {
      patch.first_sent_at = receivedAt;
    }
    if (Object.keys(patch).length > 1) {
      await cdb.from("campaign_leads").update(patch).eq("id", campaignLeadId);
    }

    // sent_count is the number every card / analytics tile / reply rate reads,
    // and it now means DELIVERED — so it moves here, on the webhook, not at
    // hand-off time. Guarded the same way replied_count is: only the first
    // delivery for this lead counts.
    if (p.event_type === "email_sent" && masterId && isFirstDelivery && !beforeState?.first_sent_at) {
      try {
        await cdb.rpc("increment_campaign_counter", {
          p_campaign_id: masterId,
          p_column: "sent_count",
        });
      } catch { /* non-fatal — reconcile-counters is the backstop */ }
    }

    // Increment campaign-level replied_count ONLY the first time this lead replies.
    // Without this guard, a lead who replies twice inflates replied_count past sent_count,
    // producing reply rates above 100% — confirmed bug in test campaigns.
    if (p.event_type === "reply_received" && masterId && !wasAlreadyReplied) {
      try {
        await cdb.rpc("increment_campaign_counter", {
          p_campaign_id: masterId,
          p_column: "replied_count",
        });
      } catch { /* non-fatal — stat is cosmetic */ }
    }

    // Increment hot_count / cold_count based on Instantly's own classification,
    // guarded so a lead's classification only counts once per actual CHANGE in
    // interest value — not once per duplicate delivery of the same webhook event,
    // and only when it was actually applied (not suppressed as a cross-campaign echo).
    if (interestApplied && masterId && interest !== previousInterest) {
      const temp = INTEREST_TO_TEMPERATURE[interest as number];
      try {
        if (temp === "hot") {
          await cdb.rpc("increment_campaign_counter", { p_campaign_id: masterId, p_column: "hot_count" });
        } else if (temp === "cold") {
          await cdb.rpc("increment_campaign_counter", { p_campaign_id: masterId, p_column: "cold_count" });
        }
      } catch { /* non-fatal */ }
    }
  }


  // 6b) Per-lead activity timeline — the human-readable "what happened to this
  // lead" feed in the drawer. Logged off the webhook rather than off our own
  // send call, because this is the point at which the outcome is actually known.
  if (leadId && isFirstDelivery) {
    const mapped = LEAD_EVENT_BY_INSTANTLY_EVENT[p.event_type];
    if (mapped) {
      await logLeadEvent(cdb, leadId, mapped.event, mapped.detail(p.step ?? null), {
        metadata: { campaign_id: masterId, step: p.step ?? null, variant: p.variant ?? null },
      });
    }
    // Suppressed cross-campaign echoes (see the isFreshestThread check above)
    // don't get a timeline entry for THIS campaign either — logging "Marked not
    // interested" here when it never actually applied would just reproduce the
    // exact confusion this guard exists to prevent.
    const interestDetail = interestApplied ? INTEREST_DETAIL_BY_EVENT[p.event_type] : undefined;
    if (interestDetail) {
      await logLeadEvent(cdb, leadId, "interest_changed", interestDetail, {
        metadata: { campaign_id: masterId, interest_status: INTEREST_BY_EVENT[p.event_type] ?? null },
      });
    }
  }

  // 7) Org-level hard opt-out: unsubscribe blocks the whole org
  if (p.event_type === "lead_unsubscribed" && leadId) {
    const { data: lead } = await cdb
      .from("leads")
      .select("organization_id")
      .eq("id", leadId)
      .maybeSingle();
    if (lead?.organization_id) {
      await cdb
        .from("organizations")
        .update({ unsubscribed: true })
        .eq("id", lead.organization_id);
    }
  }

  // Unibox mirror ingest (non-fatal)
  if ((p.event_type === "reply_received" || p.event_type === "email_sent") && p.email_id) {
    try {
      const email = await getInstantlyEmail(p.email_id);
      const { data: ev } = await cdb.from("reply_events").select("id").eq("event_uid", eventUid).maybeSingle();
      await ingestInstantlyEmail(cdb, email, {
        replyEventId: ev?.id,
        masterCampaignId: masterId,
        campaignLeadId: campaignLeadId ?? undefined,
      });
    } catch (e) {
      console.error("Unibox ingest failed:", (e as Error).message);
    }
  }

  // NOTE: an inbound reply deliberately does NOT start an AI draft any more.
  // Drafting is human-triggered only, via the "AI draft" button in Unibox /
  // campaign Outbox (POST /api/v1/reply-drafts/generate). Firing it from here
  // burned LLM calls on every reply — including ones nobody ever opened — and
  // pre-empted the reviewer's choice of how to answer. Do not re-add it.

  return NextResponse.json({ ok: true });
}
