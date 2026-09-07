/**
 * THE WORST CASE: one keyword, 500 leads, one-lead-per-company on.
 *
 * This is the shape the old 10-page ceiling could not serve. Runs the real free
 * search with the real dedupe and the real ranking, and reports how many pages
 * and seconds it takes to reach 500 — against the 240s budget. Spends nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { searchPeople } from "@/lib/services/apollo";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { orgKey, pickBestContact } from "@/lib/services/lead-ranking";

const KUBER = "00000000-0000-0000-0000-00000000000b";
const TARGET = 500;
const BUDGET_MS = 240_000;
const OLD_PAGE_CAP = 10;

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const before = await checkApolloCredits(db as never, "any", { force: true } as never);

  const { data: blocked } = await db.rpc("blocked_org_names", { p_company: KUBER });
  const blockedKeys = new Set<string>();
  for (const n of (blocked ?? []) as string[]) { const k = orgKey(n); if (k) blockedKeys.add(k); }

  const keyword = process.argv[2] ?? "flexible packaging";
  console.log(`keyword "${keyword}" | target ${TARGET} | blocked companies ${blockedKeys.size.toLocaleString()}`);
  console.log(`Apollo balance BEFORE: ${before.remaining}\n`);

  const taken = new Set<string>();
  let page = 0, raw = 0, skippedExisting = 0, skippedSame = 0, atOldCap = -1;
  const t0 = Date.now();

  while (taken.size < TARGET && Date.now() - t0 < BUDGET_MS && page < 50) {
    page++;
    const res = await searchPeople({ keyword, page, perPage: 100 });
    const people = (res.people ?? []).filter((p) => p.has_email);
    if (people.length === 0) { console.log(`  page ${page}: empty — Apollo exhausted`); break; }
    raw += people.length;

    const survivors = people.filter((p) => {
      const k = orgKey(p.organization?.name);
      if (!k) return true;
      if (blockedKeys.has(k)) { skippedExisting++; return false; }
      return true;
    });
    const byOrg = new Map<string, typeof survivors>();
    for (const p of survivors) {
      const k = orgKey(p.organization?.name);
      if (!k) continue;
      if (taken.has(k)) { skippedSame++; continue; }
      const b = byOrg.get(k); if (b) b.push(p); else byOrg.set(k, [p]);
    }
    for (const [k, c] of byOrg) {
      if (taken.size >= TARGET) break;
      if (pickBestContact(c)) { skippedSame += c.length - 1; taken.add(k); }
    }
    if (page === OLD_PAGE_CAP) atOldCap = taken.size;
    if (page % 5 === 0 || taken.size >= TARGET) {
      console.log(`  page ${String(page).padStart(2)}: ${String(taken.size).padStart(4)}/${TARGET} leads  (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }

  const secs = (Date.now() - t0) / 1000;
  console.log("\n── RESULT ──────────────────────────────────────────");
  console.log(`Pages read              ${page}`);
  console.log(`Raw people seen         ${raw}`);
  console.log(`Skipped, already covered ${skippedExisting}`);
  console.log(`Skipped, same company    ${skippedSame}`);
  console.log(`LEADS DELIVERED          ${taken.size} of ${TARGET}`);
  console.log(`Time taken               ${secs.toFixed(1)}s of ${BUDGET_MS / 1000}s budget  (${Math.round(secs / page * 1000)}ms/page)`);
  console.log(`\nUnder the OLD 10-page cap this import would have delivered: ${atOldCap < 0 ? taken.size : atOldCap}`);
  console.log(taken.size >= TARGET
    ? `VERDICT: 500 means 500. Finished with ${(BUDGET_MS / 1000 - secs).toFixed(0)}s to spare.`
    : `VERDICT: fell short — Apollo ran out or the clock did.`);

  const after = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`\nApollo balance AFTER: ${after.remaining} — ${before.remaining === after.remaining ? "ZERO SPENT" : "!! SPENT"}`);
}
main();
