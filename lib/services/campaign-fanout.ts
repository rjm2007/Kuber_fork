import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { COUNTRY_TO_TIMEZONE } from "@/lib/constants";
import {
  createInstantlyCampaign,
  addLeadsToInstantly,
  activateInstantlyCampaign,
  patchInstantlySequences,
  buildCustomVariables,
  type InstantlyStep,
  type InstantlyLeadInput,
} from "@/lib/services/instantly";
import { toInstantlyTimezone } from "@/lib/instantly-timezones";
import { getSendingAccounts } from "@/lib/services/service-keys";
import { getFollowupFallbackTemplate, renderFollowupFallback } from "@/lib/services/settings";

// Instantly's own limit on POST /api/v2/leads/add is maxItems: 1000 per call —
// 100 was our own extra-cautious choice, not anything the API requires. 500
// keeps meaningful headroom under that cap (a bad/oversized batch can't ever
// approach the hard limit) while cutting round-trips and mandatory 2s
// between-batch waits by 5x versus the old size: a 1000-lead campaign in one
// country bucket is now 2 calls + 1 wait instead of 10 calls + 9 waits.
const BATCH = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Country → timezone resolution ───────────────────────────────────────────
// Uses the COUNTRY_TO_TIMEZONE map already in lib/constants.ts.
// Falls back to the modal lead's own time_zone (Apollo-provided), then the master fallback.

function resolveCountryCode(countryName: string | null): string {
  // Simple ISO-2 map for bucketing (just the key, not the full timezone map)
  const MAP: Record<string, string> = {
    "india": "IN", "bangladesh": "BD", "pakistan": "PK", "sri lanka": "LK",
    "nepal": "NP", "united states": "US", "usa": "US",
    // ISO-2 for the UK is GB (planning.md Phase 6.6)
    "united kingdom": "GB", "uk": "GB", "great britain": "GB", "england": "GB",
    "germany": "DE", "france": "FR", "poland": "PL",
    "italy": "IT", "spain": "ES", "netherlands": "NL", "belgium": "BE",
    "sweden": "SE", "switzerland": "CH", "austria": "AT", "portugal": "PT",
    "united arab emirates": "AE", "uae": "AE", "qatar": "QA", "oman": "OM",
    "kuwait": "KW", "bahrain": "BH", "israel": "IL",
    "turkey": "TR", "saudi arabia": "SA", "vietnam": "VN",
    "thailand": "TH", "indonesia": "ID", "malaysia": "MY",
    "singapore": "SG", "philippines": "PH", "japan": "JP", "south korea": "KR",
    "china": "CN", "brazil": "BR", "mexico": "MX", "argentina": "AR",
    "egypt": "EG", "nigeria": "NG", "kenya": "KE",
    "south africa": "ZA", "australia": "AU", "new zealand": "NZ", "canada": "CA",
  };
  const key = (countryName ?? "").trim().toLowerCase();
  return MAP[key] ?? "XX";
}

function pickTimezone(
  leadTimezones: Array<string | null>,
  countryName: string | null,
  masterFallback: string,
): string {
  let tz = masterFallback;

  // 1. modal from Apollo-provided lead.time_zone values for this bucket
  const counts = new Map<string, number>();
  for (const t of leadTimezones) {
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size > 0) {
    tz = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  // 2. country default from constants
  else if (countryName && COUNTRY_TO_TIMEZONE[countryName]) {
    tz = COUNTRY_TO_TIMEZONE[countryName];
  }

  // Instantly API rejects UTC/Etc/UTC and many IANA zones not in their enum.
  if (tz === "UTC" || tz === "Etc/UTC") {
    return toInstantlyTimezone("UTC");
  }

  return toInstantlyTimezone(tz);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/** Supabase caps a response at 1000 rows server-side; a larger `.limit()` is
 *  silently clamped, so paging is the only way past it. */
const FANOUT_PAGE_SIZE = 1000;

export async function sendCampaign(
  campaignId: string,
  _actorId: string,
  opts?: {
    campaignLeadIds?: string[];
    /** Employee callers only: restricts the whole send to leads THEY own,
     *  even when the campaign is a shared container holding co-workers'
     *  leads too. A manager passes null/undefined here and sees the whole
     *  campaign, matching every other manager-scoped view in the app. */
    restrictToLeadOwnerId?: string | null;
  },
): Promise<{ buckets: number; sent: number; errors: string[] }> {
  // Bootstrap client: used only to look up which company owns this campaign.
  // Everything after that runs on `db`, scoped to that company, so the
  // instantly_campaigns / campaign_leads rows written below are stamped with it.
  const rootDb = createAdminClient();

  // 1) Fetch master campaign
  const { data: campaign, error: cErr } = await rootDb
    .from("campaigns")
    .select("id,name,human_in_loop,window_from,window_to,send_days,schedule_timezone,daily_limit,sender_name,sent_count,company_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!campaign) throw new Error("Campaign not found");

  const db = createScopedClient(campaign.company_id as string);

  const fallbackTz = campaign.schedule_timezone ?? "Asia/Kolkata";
  const sendDays = (campaign.send_days as Record<string, boolean>) ?? {};

  // Idempotency guard (§1.5): claim an exclusive send lock so a double-click or a
  // second admin cannot push the same leads to Instantly twice. Auto-expires after
  // 10 minutes so a crashed prior send doesn't wedge the campaign. Requires the
  // campaigns.send_lock_at column (2026_07_14 migration).
  const LOCK_STALE_MS = 10 * 60 * 1000;
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const { data: claimed, error: lockErr } = await db
    .from("campaigns")
    .update({ send_lock_at: new Date().toISOString() })
    .eq("id", campaignId)
    .or(`send_lock_at.is.null,send_lock_at.lt.${staleBefore}`)
    .select("id");
  if (lockErr) {
    // Column not present yet (migration not applied) — degrade to NO lock rather
    // than block every send. The lock activates automatically once the migration runs.
    console.warn("send lock unavailable (skipping):", lockErr.message);
  } else if (!claimed || claimed.length === 0) {
    throw new Error("A send is already in progress for this campaign — please wait for it to finish.");
  }

  try {

  // ── TEST MODE ──────────────────────────────────────────────────────────────
  // INSTANTLY_TEST_MODE=true => override schedule so Instantly sends ASAP
  // (24h window, all 7 days) instead of queuing until the next configured window.
  // ⚠️ TURN OFF IN PRODUCTION — otherwise emails can go out at 3am local time.
  const isTestMode = process.env.INSTANTLY_TEST_MODE === "true";
  if (isTestMode) {
    console.warn(
      "⚠️ INSTANTLY_TEST_MODE=true — campaign schedules are OVERRIDDEN to 24×7. " +
      "Emails may send at any hour. Never enable this in production.",
    );
  }
  const effWindowFrom = isTestMode ? "00:00" : (campaign.window_from ?? "09:00");
  const effWindowTo   = isTestMode ? "23:59" : (campaign.window_to ?? "18:00");
  const effSendDays: Record<string, boolean> = isTestMode
    ? { "0": true, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true }
    : sendDays;

  // 2) Fetch sequence steps
  const { data: stepRows } = await db
    .from("campaign_steps")
    .select("step_order,delay,delay_unit,subject,body")
    .eq("campaign_id", campaignId)
    .order("step_order");
  const steps: InstantlyStep[] = (stepRows ?? []).map((s) => ({
    subject: s.subject ?? "",
    body: s.body ?? "",
    delay: s.delay ?? 0,
    delayUnit: (s.delay_unit ?? "days") as InstantlyStep["delayUnit"],
  }));
  if (steps.length === 0) throw new Error("Campaign has no steps — cannot send");

  // Fetched once per send, not per lead — this seeds every follow-up step's
  // customBodyN below for any lead without a personalized draft yet.
  const followupFallbackTemplate = await getFollowupFallbackTemplate(db);

  // 3) Sending account — Settings > Email & Sending first, INSTANTLY_SENDING_ACCOUNTS
  //    as the fallback tier (same precedence as every provider key). This is the
  //    COMPANY DEFAULT: it is used for leads whose owner has no mailbox of their
  //    own, and for pool leads with no owner at all.
  const emailList = await getSendingAccounts(db);
  if (emailList.length === 0) {
    throw new Error("No Instantly sending account selected — choose one in Settings > Email & Sending");
  }
  const defaultSender = emailList[0];

  // Older deployments may still hold a comma-separated pool here. Keep handing
  // Instantly the whole list for the default bucket so its rotation is
  // preserved; a per-employee bucket is always exactly one mailbox.
  const emailListFor = (sender: string) => (sender === defaultSender ? emailList : [sender]);

  // 4) Eligible leads (certified, not yet pushed to Instantly)
  // leads:lead_id!inner is required (not just a convenience) whenever
  // restrictToLeadOwnerId is set below — an outer join can't be filtered on
  // a joined column, so an employee-scoped send would silently see every
  // lead in the campaign instead of just their own.
  // Paged, because Supabase caps a response at 1000 rows SERVER-side and does
  // not say it truncated. Reading this unpaged meant a campaign with more than
  // 1000 eligible leads silently sent to the first 1000 and reported success —
  // and the same cap on the drafts read below is worse still: a lead whose text
  // fell outside the window is pushed to Instantly with NO custom body, so
  // Instantly sends its own generic fallback while our UI shows the
  // personalised email sitting right there. Nothing logs it.
  //
  // Same trap, same fix as lib/services/followup-schedule.ts readAll(), where
  // it has already bitten twice. There is no `.limit()` large enough — the
  // ceiling belongs to the server, so paging is the only answer.
  const buildEligible = (from: number, to: number) => {
    let q = db
      .from("campaign_leads")
      .select(`
        id, lead_id,
        leads:lead_id!inner ( email, first_name, last_name, country, time_zone, assigned_to )
      `)
      .eq("campaign_id", campaignId)
      .eq("crm_status", "approved")
      .is("instantly_campaign_id", null);

    if (opts?.campaignLeadIds?.length) q = q.in("id", opts.campaignLeadIds);
    if (opts?.restrictToLeadOwnerId) q = q.eq("leads.assigned_to", opts.restrictToLeadOwnerId);

    // A stable order is required for paging: without one, Postgres may return
    // rows in a different order per page and a lead can be seen twice or missed.
    return q.order("id", { ascending: true }).range(from, to);
  };

  const cls: Array<{ id: string; lead_id: string; leads: unknown }> = [];
  for (let from = 0; ; from += FANOUT_PAGE_SIZE) {
    const { data, error } = await buildEligible(from, from + FANOUT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    cls.push(...(data as typeof cls));
    if (data.length < FANOUT_PAGE_SIZE) break;
  }

  // A co-worker's lead (or anyone else's) landing in a requested id list is
  // now caught by the same "not eligible" error an employee would already
  // get for a not-yet-certified lead — restrictToLeadOwnerId simply removes
  // it from `cls` above, so the existing count mismatch check covers it too.
  if (opts?.campaignLeadIds?.length && cls.length !== opts.campaignLeadIds.length) {
    throw new Error("Some selected leads are not eligible to send");
  }

  let totalSent = 0;
  const bucketErrors: string[] = [];
  const eligibleCount = cls.length;

  // 5) Push NEW leads (only when there are any) ───────────────────────────────
  if (cls.length > 0) {
    // Active drafts (highest version per lead+step), read in pages.
    //
    // Deliberately NOT filtered by `.in("lead_id", leadIds)` any more: with a
    // thousand ids that list runs to ~37KB of URL and can be silently dropped
    // by an intermediary. Scoping to the campaign returns a superset — it also
    // includes leads already sent — which is harmless, because the map below is
    // only ever read for leads present in `cls`.
    const allDrafts: Array<{ lead_id: string; step_number: number; subject: string | null; body: string | null; version: number | null }> = [];
    for (let from = 0; ; from += FANOUT_PAGE_SIZE) {
      const { data, error } = await db
        .from("email_drafts")
        .select("lead_id,step_number,subject,body,version")
        .eq("campaign_id", campaignId)
        .eq("status", "approved")
        .order("id", { ascending: true })
        .range(from, from + FANOUT_PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      if (!data?.length) break;
      allDrafts.push(...(data as typeof allDrafts));
      if (data.length < FANOUT_PAGE_SIZE) break;
    }

    const draftMap = new Map<string, Map<number, { subject: string | null; body: string | null }>>();
    for (const d of (allDrafts.sort((a, b) => (b.version ?? 0) - (a.version ?? 0)))) {
      if (!draftMap.has(d.lead_id)) draftMap.set(d.lead_id, new Map());
      const byStep = draftMap.get(d.lead_id)!;
      if (!byStep.has(d.step_number)) byStep.set(d.step_number, { subject: d.subject, body: d.body });
    }
    const draftsForLead = (leadId: string) =>
      [...(draftMap.get(leadId) ?? new Map()).entries()].map(([step_number, v]) => ({ step_number, ...v }));

    // Which mailbox each lead's OWNER sends from. Instantly picks the sender at
    // the campaign level, never per lead, so this has to become part of the
    // bucket key below — two employees' leads in the same country cannot share
    // one Instantly campaign and still send as themselves.
    type ClRow = (typeof cls)[number];
    const leadOf = (r: ClRow) => (Array.isArray(r.leads) ? r.leads[0] : r.leads);
    const ownerIds = [...new Set(cls.map((r) => leadOf(r)?.assigned_to).filter(Boolean))] as string[];
    const senderByOwner = new Map<string, string>();
    if (ownerIds.length > 0) {
      const { data: owners } = await db.from("profiles").select("id, sending_email").in("id", ownerIds);
      for (const o of owners ?? []) {
        if (o.sending_email) senderByOwner.set(o.id as string, (o.sending_email as string).toLowerCase());
      }
    }
    const senderFor = (r: ClRow) => senderByOwner.get(leadOf(r)?.assigned_to ?? "") ?? defaultSender;

    // Bucket leads by (country, sending mailbox)
    const buckets = new Map<string, { code: string; countryName: string | null; sender: string; rows: ClRow[] }>();
    for (const r of cls) {
      const lead = leadOf(r);
      const countryName = lead?.country ?? null;
      const code = resolveCountryCode(countryName);
      const sender = senderFor(r);
      const key = `${code}::${sender}`;
      if (!buckets.has(key)) buckets.set(key, { code, countryName, sender, rows: [] });
      buckets.get(key)!.rows.push(r);
    }

    for (const b of buckets.values()) {
      try {
        const tz = pickTimezone(
          b.rows.map((r) => {
            const l = Array.isArray(r.leads) ? r.leads[0] : r.leads;
            return l?.time_zone ?? null;
          }),
          b.countryName,
          fallbackTz,
        );
        const bucketLabel = b.countryName ?? "Other";

        // Upsert sub-campaign row (status stays 'creating' until real activation in step 6).
        // Matched on the sender too: a sub-campaign that already exists for a
        // different mailbox is left completely alone — re-pointing its
        // email_list would move the follow-ups of leads already inside it onto
        // someone else's mailbox mid-sequence.
        let { data: sub } = await db
          .from("instantly_campaigns")
          .select("id,instantly_campaign_id")
          .eq("campaign_id", campaignId)
          .eq("country_code", b.code)
          .eq("sender_email", b.sender)
          .maybeSingle();

        if (!sub) {
          const { data: created, error } = await db
            .from("instantly_campaigns")
            .insert({
              campaign_id: campaignId,
              country: bucketLabel,
              country_code: b.code,
              timezone: tz,
              status: "creating",
              daily_limit: campaign.daily_limit ?? 30,
              sender_email: b.sender,
              email_list: emailListFor(b.sender),
              created_at: new Date().toISOString(),
            })
            .select("id,instantly_campaign_id")
            .single();
          if (error) throw new Error(`instantly_campaigns insert: ${error.message}`);
          sub = created;
        }

        // Create the Instantly campaign if not yet created (TEST-MODE-aware schedule)
        let instId = sub!.instantly_campaign_id;
        if (!instId) {
          instId = await createInstantlyCampaign({
            // Two mailboxes can now own a sub-campaign for the same country, so
            // the sender's name goes in the title — otherwise they'd be two
            // identically-named campaigns in the Instantly UI. Default-sender
            // buckets keep the original name so existing campaigns and new ones
            // stay consistent.
            name: b.sender === defaultSender
              ? `${campaign.name}_${bucketLabel}`
              : `${campaign.name}_${bucketLabel}_${b.sender.split("@")[0]}`,
            dailyLimit: campaign.daily_limit ?? 30,
            windowFrom: effWindowFrom,
            windowTo: effWindowTo,
            timezone: tz,
            sendDays: effSendDays,
            steps,
            emailList: emailListFor(b.sender),
          });
          await db
            .from("instantly_campaigns")
            .update({ instantly_campaign_id: instId, updated_at: new Date().toISOString() })
            .eq("id", sub!.id);
        } else {
          // Sub-campaign already exists on Instantly — keep its sequence in sync
          // with campaign_steps. Without this, steps added/edited after the first
          // send (e.g. a new follow-up step) never reach Instantly, since it only
          // learns the sequence at creation time otherwise.
          await patchInstantlySequences(instId, steps);
        }

        // A lead is eligible on crm_status='approved', but that column does NOT
        // move when the draft underneath it is regenerated — reopening a certified
        // email leaves the lead 'approved' while its step-1 draft sits in
        // 'generating'. draftsForLead then returns nothing for step 1, and the
        // fallback below only seeds FOLLOW-UP steps, so Instantly would render the
        // step-1 template's {{customBody}} as empty: a blank opening email to a
        // real prospect. Drop those leads instead; they stay eligible and go out
        // on the next send, once the rewrite has landed and been certified.
        const notReady = b.rows.filter(
          (r) => !draftMap.get(r.lead_id)?.has(1),
        );
        if (notReady.length > 0) {
          bucketErrors.push(
            `${notReady.length} lead(s) skipped — their opening email is still being written or is not certified yet.`,
          );
        }
        const readyRows = b.rows.filter((r) => draftMap.get(r.lead_id)?.has(1));

        // Build per-lead payloads (carry leadId so we can flip their drafts to 'sent')
        const payloads = readyRows.map((r) => {
          const lead = Array.isArray(r.leads) ? r.leads[0] : r.leads;
          const firstName = (lead?.first_name ?? "").trim() || "there";
          const vars = buildCustomVariables(draftsForLead(r.lead_id), campaign.sender_name);
          // Seed the configured fallback (Settings > AI & Outreach > Follow-up
          // fallback) for any follow-up step that has no personalized draft yet.
          // The step template body is {{customBodyN}} — without a value here Instantly would
          // render a blank email. When the user later saves a personalized draft, syncApprovedDraftToInstantly
          // overwrites this variable on the lead.
          for (let si = 1; si < steps.length; si++) {
            const key = `customBody${si + 1}`;
            if (!vars[key]) {
              vars[key] = renderFollowupFallback(followupFallbackTemplate, firstName);
            }
          }
          return {
            campaignLeadId: r.id,
            leadId: r.lead_id,
            email: lead!.email!,
            firstName: lead!.first_name ?? "",
            lastName: lead!.last_name ?? "",
            customVariables: vars,
          };
        });

        // Push in batches of 100 with a 2s gap
        let bucketSent = 0;
        for (let i = 0; i < payloads.length; i += BATCH) {
          const slice = payloads.slice(i, i + BATCH);
          const result = await addLeadsToInstantly(instId, slice);
          const byEmail = new Map(
            (result.created_leads ?? []).map((c) => [c.email.toLowerCase(), c.id]),
          );
          const now = new Date().toISOString();

          // Only leads present in created_leads were actually accepted by Instantly.
          // The rest (invalid/duplicate/skipped) must NOT be reported as 'sent'.
          const sentSlice = slice.filter((p) => byEmail.has(p.email.toLowerCase()));
          const rejectedSlice = slice.filter((p) => !byEmail.has(p.email.toLowerCase()));

          // Accepted → mark sent + capture Instantly lead id + link sub-campaign.
          await Promise.all(
            sentSlice.map((p) =>
              db.from("campaign_leads").update({
                instantly_campaign_id: sub!.id,
                instantly_lead_id: byEmail.get(p.email.toLowerCase()) ?? null,
                crm_status: "sent",
                updated_at: now,
              }).eq("id", p.campaignLeadId),
            ),
          );

          // Clean per-lead activity line for the send. This is the hand-off to
          // Instantly, NOT proof of delivery — Instantly schedules the actual
          // send and confirms it later via the email_sent webhook, which logs
          // its own "Email delivered" line. Worded so the two aren't read as a
          // duplicate of each other.
          if (sentSlice.length > 0) {
            const { logLeadEvents } = await import("@/lib/services/lead-events");
            await logLeadEvents(db, sentSlice.map((p) => ({
              leadId: p.leadId, event: "draft_sent" as const, detail: "Outreach queued for sending",
              metadata: { campaign_id: campaignId },
            })));
          }

          // Rejected → mark failed and still link the sub, so they are visible as
          // needing attention and are NOT silently re-picked as "eligible" forever.
          await Promise.all(
            rejectedSlice.map((p) =>
              db.from("campaign_leads").update({
                instantly_campaign_id: sub!.id,
                crm_status: "failed",
                updated_at: now,
              }).eq("id", p.campaignLeadId),
            ),
          );

          // Mark ONLY the accepted leads' drafts as sent.
          if (sentSlice.length > 0) {
            await db.from("email_drafts")
              .update({ status: "sent", updated_at: now })
              .eq("campaign_id", campaignId)
              .in("lead_id", sentSlice.map((p) => p.leadId))
              .eq("status", "approved");
          }

          bucketSent += sentSlice.length;
          totalSent += sentSlice.length;
          if (i + BATCH < payloads.length) await sleep(2000);
        }

        // Update sub-campaign counters with the ACTUAL accepted count.
        // readyRows, not b.rows: leads held back for an unfinished draft were
        // never pushed, so counting them here would overstate the sub-campaign.
        await db.from("instantly_campaigns").update({
          lead_count: readyRows.length,
          sent_count: bucketSent,
          updated_at: new Date().toISOString(),
        }).eq("id", sub!.id);
      } catch (e) {
        const message = (e as Error).message;
        console.error(`Bucket ${b.code} failed:`, message);
        bucketErrors.push(`${b.countryName ?? b.code}: ${message}`);
        // UPDATE (not upsert): the sub row was already created above, and an upsert-insert
        // path here would violate NOT NULL (country/timezone). Records last_error (column
        // added in the 2026_07_14 migration) so the failure is traceable.
        await db.from("instantly_campaigns")
          .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
          .eq("campaign_id", campaignId)
          .eq("country_code", b.code)
          // Same country can now hold one sub per mailbox — without this, one
          // employee's failed bucket would mark a co-worker's healthy one failed.
          .eq("sender_email", b.sender);
        continue;
      }
    }

    if (eligibleCount > 0 && totalSent === 0) {
      throw new Error(
        bucketErrors[0]
          ?? "No leads were sent to Instantly. Check campaign timezone and sending window settings.",
      );
    }
  }

  // 6) ACTIVATE every sub-campaign of this master (idempotent) ─────────────────
  // THIS is what actually makes Instantly send. Runs whether or not new leads were
  // pushed, so a previously-stuck campaign also gets activated on re-send.
  const { data: subs } = await db
    .from("instantly_campaigns")
    .select("id,instantly_campaign_id")
    .eq("campaign_id", campaignId)
    .not("instantly_campaign_id", "is", null);

  const activationErrors: string[] = [];
  for (const sub of subs ?? []) {
    if (!sub.instantly_campaign_id) continue;
    try {
      await activateInstantlyCampaign(sub.instantly_campaign_id);
      await db.from("instantly_campaigns").update({
        status: "active",
        activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", sub.id);
    } catch (e) {
      const message = (e as Error).message;
      activationErrors.push(`sub ${sub.id}: ${message}`);
      await db.from("instantly_campaigns").update({
        status: "failed",
        last_error: message,
        updated_at: new Date().toISOString(),
      }).eq("id", sub.id);
      // Do NOT throw here — keep activating the remaining sub-campaigns so one
      // bad bucket can't strand the others (and the master rollup below still runs).
    }
  }

  // 7) Roll up master campaign status + counter. sent_count is RECONCILED from the
  //    actual data rather than a racy read-modify-write on a value read minutes ago.
  //    It counts DELIVERED leads (first_sent_at), not the ones we just handed to
  //    Instantly — those are only queued, and Instantly drips them out over the
  //    following days. Right after a send this is usually still 0, which is
  //    correct: nothing has actually gone out yet. The email_sent webhook
  //    increments it from here on.
  const { count: reconciledSent } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .not("first_sent_at", "is", null);

  await db.from("campaigns").update({
    status: "active",
    sent_count: reconciledSent ?? 0,
    updated_at: new Date().toISOString(),
  }).eq("id", campaignId);

  // Only fail the whole send if EVERY sub-campaign activation failed.
  if ((subs?.length ?? 0) > 0 && activationErrors.length === (subs?.length ?? 0)) {
    throw new Error(`All sub-campaign activations failed: ${activationErrors.join("; ")}`);
  }

  // `errors` is additive — every existing caller reads `buckets`/`sent` and is
  // unaffected. It was previously collected and then dropped on the floor, so a
  // send where India and the UK succeeded and Germany failed returned
  // "sent: 120" with no mention of Germany. The failure was recorded on
  // instantly_campaigns.last_error, where nobody would look.
  //
  // Only a total failure throws (above). A PARTIAL failure must not throw —
  // the leads that did send are already in Instantly, and turning that into an
  // exception would report a successful send as an error and invite someone to
  // press Send again.
  return { buckets: (subs ?? []).length, sent: totalSent, errors: bucketErrors };
  } finally {
    // Always release the send lock — on success or failure.
    await db.from("campaigns").update({ send_lock_at: null }).eq("id", campaignId);
  }
}
