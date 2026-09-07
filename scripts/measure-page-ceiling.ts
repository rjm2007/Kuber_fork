/**
 * Is a 10-page-per-keyword ceiling enough to deliver 500 leads?
 *
 * FREE: mixed_people/api_search only. Answers three things we were guessing at:
 *   1. total_entries per catalog keyword — if Apollo holds under 1,000 for a
 *      keyword, our 10-page seatbelt NEVER binds, because pageCeiling is already
 *      min(10, ceil(total/100)).
 *   2. Wall-clock per page, against the route's 300s maxDuration.
 *   3. Whether deep pages still return people (some APIs quietly stop).
 */
import { searchPeople } from "@/lib/services/apollo";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { createClient } from "@supabase/supabase-js";

const KEYWORDS = [
  "stretch film", "shrink film", "plastic film", "film extrusion", "blown film",
  "flexible packaging", "packaging film", "polyethylene film", "cast film",
  "barrier film", "agricultural film", "plastic bags", "pet bottles",
  "injection molding", "thermoforming", "masterbatch", "pipe", "extrusion",
  "plastic recycling", "compounding", "polymers", "engineering plastics",
];

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const before = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`Apollo balance BEFORE: ${before.remaining}\n`);

  console.log("keyword                 total_entries  pages@100  10pg enough?  ms/page");
  console.log("-".repeat(76));
  const rows: Array<{ kw: string; total: number; pages: number }> = [];
  let totalMs = 0, calls = 0;

  for (const kw of KEYWORDS) {
    const t0 = Date.now();
    const res = await searchPeople({ keyword: kw, page: 1, perPage: 100 });
    const ms = Date.now() - t0;
    totalMs += ms; calls++;
    const total = res.total_entries ?? 0;
    const pages = Math.ceil(total / 100);
    rows.push({ kw, total, pages });
    const binds = pages > 10 ? "NO - capped" : "yes";
    console.log(`${kw.padEnd(24)}${String(total).padStart(9)}${String(pages).padStart(11)}   ${binds.padEnd(13)}${String(ms).padStart(6)}`);
  }

  const grand = rows.reduce((a, r) => a + r.total, 0);
  const reachable10 = rows.reduce((a, r) => a + Math.min(r.total, 1000), 0);
  const capped = rows.filter((r) => r.pages > 10);

  console.log("\n── HOW DEEP DOES A DEEP PAGE STILL WORK? ──");
  for (const page of [5, 10, 15, 20]) {
    const t0 = Date.now();
    const res = await searchPeople({ keyword: "injection molding", page, perPage: 100 });
    console.log(`  page ${String(page).padStart(2)}: ${String(res.people?.length ?? 0).padStart(3)} people   ${Date.now() - t0}ms`);
  }

  const avg = Math.round(totalMs / calls);
  console.log("\n── VERDICT ────────────────────────────────────────");
  console.log(`Keywords measured                 ${rows.length}`);
  console.log(`Keywords where 10 pages BINDS     ${capped.length}  (${capped.map((c) => c.kw).join(", ") || "none"})`);
  console.log(`People reachable, 10-page cap     ${reachable10.toLocaleString()}`);
  console.log(`People reachable, no cap          ${grand.toLocaleString()}`);
  console.log(`Average ms per Apollo page        ${avg}`);
  console.log(`\nAt ~50% loss to one-lead-per-company, 10 pages yields ~${Math.round(reachable10 * 0.5).toLocaleString()} usable leads across these keywords.`);
  console.log(`300s budget / ${avg}ms per page = ~${Math.floor(300000 / avg)} Apollo pages per request (before DB work).`);

  const after = await checkApolloCredits(db as never, "any", { force: true } as never);
  console.log(`\nApollo balance AFTER: ${after.remaining} — ${before.remaining === after.remaining ? "ZERO SPENT" : "!! SPENT"}`);
}
main();
