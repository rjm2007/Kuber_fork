/**
 * Replay the client's zero-result import (20b0fb53 "Polybags America and Asia 1")
 * with the keyword rescue + one-lead-per-company applied. FREE - search only.
 */
import { createClient } from "@supabase/supabase-js";
import { searchPeople } from "@/lib/services/apollo";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { orgKey, pickBestContact } from "@/lib/services/lead-ranking";
import { keywordVariants, pickBestVariant } from "@/lib/services/keyword-fallback";

const KUBER = "00000000-0000-0000-0000-00000000000b";
const TARGET = 500;
const KEYWORDS = ["Plastic Bag Manufacturer","Poly Bag Manufacturer","PE Bag Manufacturer","Garbage Bag Manufacturer","Trash Bag Manufacturer","Refuse Bag Manufacturer","Shopping Bag Manufacturer","Carrier Bag Manufacturer","T-Shirt Bag Manufacturer","Plastic Raincoat","Heavy Duty Bag Manufacturer"];

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const before = await checkApolloCredits(db as never, "any", { force: true } as never);
  const { data: blocked } = await db.rpc("blocked_org_names", { p_company: KUBER });
  const blockedKeys = new Set<string>();
  for (const n of (blocked ?? []) as string[]) { const k = orgKey(n); if (k) blockedKeys.add(k); }

  const taken = new Set<string>(); const t0 = Date.now();
  let skippedCovered = 0, skippedSame = 0, rescues = 0;

  for (const [i, kw] of KEYWORDS.entries()) {
    if (taken.size >= TARGET) break;
    let active = kw;
    let total = (await searchPeople({ keyword: kw, page: 1, perPage: 1 })).total_entries ?? 0;
    if (total === 0) {
      const tried: Array<{ term: string; count: number }> = [];
      for (const v of keywordVariants(kw)) {
        try { tried.push({ term: v, count: (await searchPeople({ keyword: v, page: 1, perPage: 1 })).total_entries ?? 0 }); } catch {}
      }
      const best = pickBestVariant(tried);
      if (!best) { console.log(`  ${kw.padEnd(30)} DEAD`); continue; }
      active = best.term; total = best.count; rescues++;
      console.log(`  ${kw.padEnd(30)} 0 -> "${best.term}" (${best.count.toLocaleString()})`);
    } else {
      console.log(`  ${kw.padEnd(30)} ${total.toLocaleString()} (no rescue needed)`);
    }

    const fairShare = Math.ceil((TARGET - taken.size) / (KEYWORDS.length - i));
    const startedWith = taken.size;
    let page = 0;
    while (taken.size - startedWith < fairShare && page < 50 && page * 100 < total) {
      page++;
      const res = await searchPeople({ keyword: active, page, perPage: 100 });
      const people = (res.people ?? []).filter((p) => p.has_email);
      if (people.length === 0) break;
      const byOrg = new Map<string, typeof people>();
      for (const p of people) {
        const k = orgKey(p.organization?.name);
        if (!k) continue;
        if (blockedKeys.has(k)) { skippedCovered++; continue; }
        if (taken.has(k)) { skippedSame++; continue; }
        const b = byOrg.get(k); if (b) b.push(p); else byOrg.set(k, [p]);
      }
      for (const [k, c] of byOrg) {
        if (taken.size - startedWith >= fairShare || taken.size >= TARGET) break;
        if (pickBestContact(c)) { skippedSame += c.length - 1; taken.add(k); }
      }
    }
  }

  console.log("\n── REPLAY RESULT ──────────────────────────────────");
  console.log(`What the client actually got:  0 leads`);
  console.log(`What they would get now:       ${taken.size} leads across ${taken.size} companies`);
  console.log(`Keywords rescued:              ${rescues} of ${KEYWORDS.length}`);
  console.log(`Skipped (already covered):     ${skippedCovered}`);
  console.log(`Skipped (same company):        ${skippedSame}`);
  console.log(`Time:                          ${((Date.now()-t0)/1000).toFixed(1)}s of 240s`);
  const after = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`Apollo ${before.remaining} -> ${after.remaining} ${before.remaining===after.remaining?"— ZERO SPENT":"— !! SPENT"}`);
}
main();
