/**
 * Repair sub-campaign timezones that were flattened to the master campaign's
 * timezone by the Options-save bug (see docs/campaign-timezone-rca.md).
 *
 * The correct per-country timezone was never lost — it still sits in
 * instantly_campaigns.timezone, written once at fan-out and never updated
 * afterwards. This script replays that stored value back into Instantly.
 *
 * It changes the schedule TIMEZONE ONLY. The sending window, send days,
 * schedule name, daily limit, sequences, leads and campaign membership are
 * read and written back byte-for-byte unchanged.
 *
 *   node scripts/repair-campaign-timezones.mjs            # dry run (default)
 *   node scripts/repair-campaign-timezones.mjs --apply    # actually write
 *   node scripts/repair-campaign-timezones.mjs --company=<uuid>
 *
 * Requires (from .env.local):
 *   INSTANTLY_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * NOTE: INSTANTLY_API_KEY must be the same workspace the app is using. The app
 * resolves its key DB-first (Settings > Keys) and falls back to .env.local, so
 * if a different key is configured in Settings this script would read a
 * different workspace and find nothing. Sub-campaigns it cannot see are
 * reported as "not in workspace" rather than silently skipped.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

try {
  const lines = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim();
  }
} catch { /* no env file — rely on shell env */ }

const BASE = "https://api.instantly.ai/api/v2";
const apiKey = process.env.INSTANTLY_API_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!apiKey || !supabaseUrl || !serviceKey) {
  console.error("Missing env: INSTANTLY_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
const companyArg = process.argv.find((a) => a.startsWith("--company="));
const companyId = companyArg ? companyArg.split("=")[1] : null;

const auth = { Authorization: `Bearer ${apiKey}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// ── 1. Load sub-campaigns with a stored timezone and a live Instantly id ──────
let query = db
  .from("instantly_campaigns")
  .select("id, campaign_id, country, country_code, sender_email, timezone, instantly_campaign_id, company_id")
  .not("instantly_campaign_id", "is", null)
  .order("country");
if (companyId) query = query.eq("company_id", companyId);

const { data: subs, error } = await query;
if (error) {
  console.error("Failed to read instantly_campaigns:", error.message);
  process.exit(1);
}

console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${subs.length} sub-campaign(s) with an Instantly id`);
if (companyId) console.log(`Company filter: ${companyId}`);
console.log("");

// ── 2. Compare stored timezone against what Instantly currently holds ─────────
const rows = [];
const missing = [];
const failed = [];

for (const sub of subs) {
  let campaign;
  try {
    const res = await fetch(`${BASE}/campaigns/${sub.instantly_campaign_id}`, { headers: auth });
    if (res.status === 404) { missing.push(sub); continue; }
    if (!res.ok) {
      failed.push({ sub, reason: `read ${res.status}` });
      continue;
    }
    campaign = await res.json();
  } catch (e) {
    failed.push({ sub, reason: `read failed: ${e.message}` });
    continue;
  }

  const schedules = campaign.campaign_schedule?.schedules ?? [];
  const live = schedules[0]?.timezone ?? null;

  rows.push({
    sub,
    name: campaign.name ?? "(unnamed)",
    live,
    stored: sub.timezone,
    drift: live !== sub.timezone,
    campaign,
  });
}

// ── 3. Report ────────────────────────────────────────────────────────────────
const drifted = rows.filter((r) => r.drift);
const ok = rows.filter((r) => !r.drift);

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
console.log(pad("SUB-CAMPAIGN", 46), pad("IN INSTANTLY NOW", 22), pad("IN OUR DB", 22), "ACTION");
console.log("-".repeat(46), "-".repeat(22), "-".repeat(22), "------");
for (const r of drifted) {
  console.log(pad(r.name, 46), pad(r.live, 22), pad(r.stored, 22), "→ RESTORE");
}
for (const r of ok) {
  console.log(pad(r.name, 46), pad(r.live, 22), pad(r.stored, 22), "  ok");
}

console.log("");
console.log(`  needs repair : ${drifted.length}`);
console.log(`  already ok   : ${ok.length}`);
if (missing.length) console.log(`  not in workspace (404): ${missing.length}`);
if (failed.length) console.log(`  unreadable   : ${failed.length}`);

const byTz = {};
for (const r of drifted) {
  const k = `${r.live} → ${r.stored}`;
  byTz[k] = (byTz[k] ?? 0) + 1;
}
if (drifted.length) {
  console.log("\n  changes by timezone:");
  for (const [k, v] of Object.entries(byTz).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(4)}  ${k}`);
  }
}

if (!APPLY) {
  console.log("\nDry run only — nothing was written. Re-run with --apply to restore.\n");
  process.exit(0);
}

if (drifted.length === 0) {
  console.log("\nNothing to repair.\n");
  process.exit(0);
}

// ── 4. Apply: rewrite the schedule with ONLY the timezone replaced ────────────
// campaign_schedule is replaced wholesale by Instantly's PATCH, so the existing
// object is echoed back with a single field swapped. timing, days, schedule name
// and any additional schedules are carried across untouched.
console.log("\nApplying...\n");
let repaired = 0;
for (const r of drifted) {
  const schedules = r.campaign.campaign_schedule?.schedules ?? [];
  const base = schedules[0] ?? {};
  const merged = { ...base, timezone: r.stored };
  const payload = { campaign_schedule: { schedules: [merged, ...schedules.slice(1)] } };

  try {
    const res = await fetch(`${BASE}/campaigns/${r.sub.instantly_campaign_id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log(`  FAIL  ${r.name} — ${res.status} ${detail.slice(0, 120)}`);
      continue;
    }
    console.log(`  ok    ${r.name}  ${r.live} → ${r.stored}`);
    repaired++;
  } catch (e) {
    console.log(`  FAIL  ${r.name} — ${e.message}`);
  }
  await sleep(120); // stay well clear of Instantly's rate limits
}

console.log(`\nRepaired ${repaired}/${drifted.length}.\n`);
