/**
 * One-off repair for leads already hit by issues 4 and 6.
 *
 *  - MISSING: first_sent_at is empty but Instantly's synced copy shows the
 *    opening email left. Filled with that time (same rule as the live ingest).
 *  - SET TOO LATE: only with clear evidence - the webhook never recorded a
 *    step-1 send for this lead (so first_sent_at came from a follow-up's
 *    signal), and it is more than a minute after the real opening. That is
 *    exactly the 2026-09-10 case. A plain "earlier wins" rule was tried and
 *    rejected: it matched 959 correct leads off by milliseconds and pulled one
 *    re-sent lead back a whole month.
 *
 * Dry run by default. --apply writes; --company=<uuid> limits to one workspace.
 *   npx tsx --env-file=.env.vercel scripts/repair-first-sent.ts [--company=<id>] [--apply]
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { stepOrderFromInstantly } from "@/lib/services/followup-signals";

const APPLY = process.argv.includes("--apply");
const COMPANY = process.argv.find((a) => a.startsWith("--company="))?.split("=")[1];
const NAMES: Record<string, string> = { "00000000-0000-0000-0000-00000000000a": "Dev", "00000000-0000-0000-0000-00000000000b": "Kuber Polyplast" };
const LATE_TOLERANCE_MS = 60_000;

async function main() {
  const db = createAdminClient();
  // Earliest synced OPENING email per campaign lead.
  const opening = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    let q = db.from("unibox_emails").select("campaign_lead_id, step, timestamp_email")
      .eq("direction", "sent_campaign").not("campaign_lead_id", "is", null);
    if (COMPANY) q = q.eq("company_id", COMPANY);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      if (stepOrderFromInstantly(r.step) !== 1) continue;
      const prev = opening.get(r.campaign_lead_id);
      if (!prev || r.timestamp_email < prev) opening.set(r.campaign_lead_id, r.timestamp_email);
    }
    if (!data || data.length < 1000) break;
  }
  const ids = [...opening.keys()];
  const fixes: Array<{ id: string; company: string; kind: string; from: string | null; to: string }> = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: cls, error } = await db.from("campaign_leads").select("id, first_sent_at, company_id").in("id", chunk);
    if (error) throw error;
    const { data: evs } = await db.from("reply_events").select("campaign_lead_id, step").eq("event_type", "email_sent").in("campaign_lead_id", chunk);
    const hasStep1 = new Set((evs ?? []).filter((e) => stepOrderFromInstantly(e.step) === 1).map((e) => e.campaign_lead_id));
    for (const cl of cls ?? []) {
      const real = opening.get(cl.id)!;
      const co = NAMES[cl.company_id] ?? cl.company_id;
      if (!cl.first_sent_at) { fixes.push({ id: cl.id, company: co, kind: "missing", from: null, to: real }); continue; }
      const lateBy = new Date(cl.first_sent_at).getTime() - new Date(real).getTime();
      if (!hasStep1.has(cl.id) && lateBy > LATE_TOLERANCE_MS) fixes.push({ id: cl.id, company: co, kind: "set too late", from: cl.first_sent_at, to: real });
    }
  }
  console.log(`opening emails in the inbox copy: ${opening.size}`);
  const count = (k: string) => fixes.filter((f) => f.kind === k).length;
  console.log(`leads to repair: ${fixes.length}  (missing: ${count("missing")}, set too late: ${count("set too late")})`);
  const byCo: Record<string, number> = {};
  for (const f of fixes) byCo[f.company] = (byCo[f.company] ?? 0) + 1;
  console.log("by workspace:", byCo);
  for (const f of fixes) console.log(`  ${f.company.padEnd(15)} ${f.kind.padEnd(13)} ${f.id}  ${f.from ?? "(none)"}  ->  ${f.to}`);
  if (!APPLY) { console.log("\nDRY RUN - nothing written. Re-run with --apply to write."); return; }
  let done = 0;
  for (const f of fixes) {
    const { error } = await db.from("campaign_leads").update({ first_sent_at: f.to, updated_at: new Date().toISOString() }).eq("id", f.id);
    if (!error) done++;
  }
  console.log(`\nAPPLIED: ${done}/${fixes.length} updated.`);
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
