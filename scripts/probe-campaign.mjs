/**
 * Ask the running dev server what the campaign endpoints actually return, as a
 * signed-in manager. Diagnoses "campaign shows no leads" without guessing.
 *   node scripts/probe-campaign.mjs <campaignId>
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const CAMPAIGN = process.argv[2];
const AS_USER = process.env.E2E_USER ?? "lakshit@gmail.com";

const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: AS_USER });
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data: v } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
const token = v.session.access_token;

async function probe(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

for (const path of [
  `/api/v1/campaigns/${CAMPAIGN}/leads?page=1&limit=50`,
  `/api/v1/campaigns/${CAMPAIGN}/replies`,
]) {
  const { status, json } = await probe(path);
  console.log(`\n${path}\n  HTTP ${status}  success=${json?.success}`);
  if (json?.error) console.log("  error:", JSON.stringify(json.error));
  const d = json?.data;
  if (d?.campaign_leads) {
    console.log(`  total=${d.total} returned=${d.campaign_leads.length}`);
    for (const cl of d.campaign_leads) {
      console.log(`   - ${cl.leads?.email ?? "(no lead embed)"}  crm=${cl.crm_status}  draft=${cl.email_drafts ? "yes" : "no"}`);
    }
  }
  if (d?.threads) {
    console.log(`  threads=${d.threads.length}`);
    for (const t of d.threads) {
      console.log(`   - ${t.lead_email}  msgs=${t.messages?.length}  sent=${t.sent_messages?.length}`);
    }
  }
}
