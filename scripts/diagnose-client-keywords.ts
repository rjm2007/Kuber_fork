/**
 * Why did the client's imports return zero? FREE - search only.
 * Their exact typed keywords vs the shorter form Apollo actually matches.
 */
import { searchPeople } from "@/lib/services/apollo";

const PAIRS: Array<[string, string[]]> = [
  ["Plastic Bag Manufacturer", ["plastic bags", "plastic bag", "poly bag"]],
  ["Poly Bag Manufacturer", ["poly bags", "polythene bags"]],
  ["Garbage Bag Manufacturer", ["garbage bags", "bin liners"]],
  ["Shopping Bag Manufacturer", ["shopping bags", "carrier bags"]],
  ["Plastic HDPE pipes", ["hdpe pipe", "hdpe pipes"]],
  ["Plastic Drainage pipes", ["drainage pipe", "drainage pipes"]],
  ["Plastic Corrugated Pipes", ["corrugated pipe"]],
  ["Plastic Irrigation pipes", ["irrigation pipe", "irrigation"]],
  ["Plastic pipes and fittings", ["pipes and fittings", "plastic pipe"]],
  ["Plastic Taps", ["taps", "faucets"]],
  ["Pipe and Extrusion", ["pipe extrusion", "extrusion"]],
];

async function total(kw: string): Promise<number> {
  try { return (await searchPeople({ keyword: kw, page: 1, perPage: 1 })).total_entries ?? 0; }
  catch { return -1; }
}

async function main() {
  console.log("CLIENT TYPED                      ->  RESULTS   |  BETTER TERM              ->  RESULTS");
  console.log("-".repeat(94));
  for (const [typed, alts] of PAIRS) {
    const t = await total(typed);
    const results: string[] = [];
    for (const a of alts) results.push(`${a} -> ${(await total(a)).toLocaleString()}`);
    console.log(`${typed.padEnd(33)} -> ${String(t).padStart(7)}   |  ${results.join("  |  ")}`);
  }
}
main();
