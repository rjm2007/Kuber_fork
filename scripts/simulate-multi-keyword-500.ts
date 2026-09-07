/**
 * "500 leads across 6-7 keywords — do I get 500 NEW companies?"
 *
 * Mirrors the route exactly: fair-share budget per keyword, covered-company
 * filter, one best contact per company, 240s clock. FREE - people-search only.
 */
import { createClient } from "@supabase/supabase-js";
import { searchPeople } from "@/lib/services/apollo";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { orgKey, pickBestContact } from "@/lib/services/lead-ranking";

const KUBER = "00000000-0000-0000-0000-00000000000b";
const TARGET = 500;
const BUDGET_MS = 240_000;
const KEYWORDS = ["blown film", "flexible packaging", "stretch film", "injection molding", "masterbatch", "plastic recycling", "thermoforming"];

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const before = await checkApolloCredits(db as never, "any", { force: true } as never);
  const { data: blocked } = await db.rpc("blocked_org_names", { p_company: KUBER });
  const blockedKeys = new Set<string>();
  for (const n of (blocked ?? []) as string[]) { const k = orgKey(n); if (k) blockedKeys.add(k); }

  console.log(`${KEYWORDS.length} keywords | target ${TARGET} | already-covered companies ${blockedKeys.size.toLocaleString()}`);
  console.log(`Apollo balance BEFORE: ${before.remaining}\n`);

  const taken = new Set<string>();
  const t0 = Date.now();
  let pages = 0, skippedCovered = 0, skippedSame = 0;

  for (const [i, kw] of KEYWORDS.entries()) {
    if (taken.size >= TARGET || Date.now() - t0 > BUDGET_MS) break;
    const fairShare = Math.ceil((TARGET - taken.size) / (KEYWORDS.length - i)); // route's fair-share rule
    const startedWith = taken.size;
    let page = 0;
    while (taken.size - startedWith < fairShare && page < 50 && Date.now() - t0 < BUDGET_MS) {
      page++; pages++;
      const res = await searchPeople({ keyword: kw, page, perPage: 100 });
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
    console.log(`  ${kw.padEnd(20)} share ${String(fairShare).padStart(3)}  got ${String(taken.size - startedWith).padStart(3)}  running total ${taken.size}  (${page}pg)`);
  }

  const secs = (Date.now() - t0) / 1000;
  console.log("\n── RESULT ────────────────────────────────────────");
  console.log(`LEADS DELIVERED           ${taken.size} of ${TARGET}`);
  console.log(`DISTINCT COMPANIES        ${taken.size}   <- same number = every lead a different company`);
  console.log(`Already-covered skipped   ${skippedCovered}`);
  console.log(`Same-company skipped      ${skippedSame}`);
  console.log(`Pages read / time         ${pages} pages, ${secs.toFixed(1)}s of ${BUDGET_MS/1000}s`);
  const overlap = [...taken].filter((k) => blockedKeys.has(k)).length;
  console.log(`\nAny company we already had? ${overlap}  (must be 0)`);
  const after = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`Apollo balance AFTER: ${after.remaining} ${before.remaining===after.remaining?"— ZERO SPENT":"— !! SPENT"}`);
}
main();
