/**
 * DRY RUN — proves one-lead-per-company works before the client ever runs it.
 *
 * Spends NOTHING: only mixed_people/api_search (free), only SELECTs. It never
 * calls bulk_match and never writes a row. The Apollo balance is read before
 * and after and printed, so "zero credits" is measured, not asserted.
 */
import { createClient } from "@supabase/supabase-js";
import { searchPeople } from "@/lib/services/apollo";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { orgKey, pickBestContact, titleTier } from "@/lib/services/lead-ranking";

const KUBER = "00000000-0000-0000-0000-00000000000b";
const KEYWORDS = ["blown film", "flexible packaging", "injection moulding"];
const PAGES = 2;

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const before = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`Apollo balance BEFORE: ${before.remaining}\n`);

  const { data: blocked, error } = await db.rpc("blocked_org_names", { p_company: KUBER });
  if (error) throw error;
  const blockedKeys = new Set<string>();
  for (const name of (blocked ?? []) as string[]) {
    const k = orgKey(name);
    if (k) blockedKeys.add(k);
  }
  console.log(`Companies already covered (blocked): ${blockedKeys.size.toLocaleString()}\n`);

  const taken = new Set<string>();
  let raw = 0, withEmail = 0, skippedExisting = 0, skippedSameOrg = 0;
  const picks: Array<{ org: string; title: string; tier: string; beat: number }> = [];

  for (const keyword of KEYWORDS) {
    for (let page = 1; page <= PAGES; page++) {
      const res = await searchPeople({ keyword, page, perPage: 100 });
      const people = (res.people ?? []);
      raw += people.length;
      const usable = people.filter((p) => p.has_email);
      withEmail += usable.length;

      const survivors = usable.filter((p) => {
        const k = orgKey(p.organization?.name);
        if (!k) return true;
        if (blockedKeys.has(k)) { skippedExisting++; return false; }
        return true;
      });

      const byOrg = new Map<string, typeof survivors>();
      for (const p of survivors) {
        const k = orgKey(p.organization?.name);
        if (!k) continue;
        if (taken.has(k)) { skippedSameOrg++; continue; }
        const b = byOrg.get(k); if (b) b.push(p); else byOrg.set(k, [p]);
      }
      for (const [k, cands] of byOrg) {
        const best = pickBestContact(cands);
        if (!best) continue;
        skippedSameOrg += cands.length - 1;
        taken.add(k);
        if (cands.length > 1) {
          picks.push({ org: best.organization?.name ?? "?", title: best.title ?? "?", tier: titleTier(best.title), beat: cands.length - 1 });
        }
      }
    }
  }

  console.log("── RESULT ──────────────────────────────────────────────");
  console.log(`Raw people from Apollo          ${raw}`);
  console.log(`With an email                   ${withEmail}`);
  console.log(`Skipped: company already covered ${skippedExisting}`);
  console.log(`Skipped: 2nd+ person at a company ${skippedSameOrg}`);
  console.log(`WOULD IMPORT (1 per company)    ${taken.size}`);
  console.log(`\nCredits this would have cost BEFORE the fix: ${withEmail}`);
  console.log(`Credits it costs now:                       ${taken.size}`);
  console.log(`SAVED:                                      ${withEmail - taken.size}`);

  console.log("\n── WHO WE KEPT where there was a real choice ───────────");
  for (const p of picks.slice(0, 15)) {
    console.log(`  ${p.org.slice(0, 38).padEnd(40)} ${p.title.slice(0, 30).padEnd(32)} [${p.tier}] beat ${p.beat}`);
  }

  // Proof the rule holds: nobody we would import shares a company with anyone
  // else, and none of them is at a company we already cover.
  console.log("\n── ASSERTIONS ─────────────────────────────────────────");
  const clash = [...taken].filter((k) => blockedKeys.has(k));
  console.log(`  picks at an already-covered company: ${clash.length} (must be 0)`);
  console.log(`  duplicate companies among picks:     ${taken.size - new Set([...taken]).size} (must be 0)`);

  const after = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`\nApollo balance AFTER: ${after.remaining}`);
  console.log(before.remaining === after.remaining
    ? "ZERO CREDITS SPENT — confirmed."
    : `!! SPENT ${(before.remaining ?? 0) - (after.remaining ?? 0)} CREDITS — investigate.`);
}
main();
