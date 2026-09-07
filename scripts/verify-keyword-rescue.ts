/** Would the rescue have saved the client's failed import? FREE - search only. */
import { searchPeople } from "@/lib/services/apollo";
import { keywordVariants } from "@/lib/services/keyword-fallback";

const CLIENT_KEYWORDS = [
  "Plastic Bag Manufacturer", "Poly Bag Manufacturer", "PE Bag Manufacturer",
  "Garbage Bag Manufacturer", "Trash Bag Manufacturer", "Refuse Bag Manufacturer",
  "Shopping Bag Manufacturer", "Carrier Bag Manufacturer", "T-Shirt Bag Manufacturer",
  "Plastic Raincoat", "Heavy Duty Bag Manufacturer",
  "Plastic HDPE pipes", "Plastic PE pipes", "Plastic Drainage pipes",
  "Plastic Corrugated Pipes", "Plastic Irrigation pipes", "Plastic Pressure Pipes",
  "Plastic Taps", "Plastic Bathware", "Plastic pipes and fittings", "Pipe and Extrusion",
];

const total = async (k: string) => {
  try { return (await searchPeople({ keyword: k, page: 1, perPage: 1 })).total_entries ?? 0; } catch { return -1; }
};

async function main() {
  let rescued = 0, alreadyOk = 0, stillDead = 0, gained = 0;
  for (const kw of CLIENT_KEYWORDS) {
    const t = await total(kw);
    if (t > 0) { alreadyOk++; console.log(`ok       ${kw.padEnd(30)} ${t}`); continue; }
    // Best variant, not the first: search is free, and "plastic corrugated
    // pipe" (1 result) beat "corrugated pipes" (200+) purely by being tried
    // first, which is a silly reason to lose 200 companies.
    let won: { term: string; n: number } | null = null;
    for (const v of keywordVariants(kw)) {
      const n = await total(v);
      if (n > 0 && (!won || n > won.n)) won = { term: v, n };
    }
    if (won) { rescued++; gained += won.n; console.log(`RESCUED  ${kw.padEnd(30)} 0 -> "${won.term}" = ${won.n.toLocaleString()}`); }
    else { stillDead++; console.log(`dead     ${kw.padEnd(30)} 0 (no variant worked)`); }
  }
  console.log(`\nof ${CLIENT_KEYWORDS.length} keywords: ${alreadyOk} already worked, ${rescued} RESCUED, ${stillDead} still dead`);
  console.log(`people made reachable by the rescue: ${gained.toLocaleString()}`);
}
main();
