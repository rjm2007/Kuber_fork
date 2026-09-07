/** Current counts for the client keyword guide. FREE - search only. */
import { searchPeople } from "@/lib/services/apollo";
const TERMS = ["blown film","stretch film","shrink film","plastic film","film extrusion","barrier film","packaging film","flexible packaging","agricultural film","plastic bags","poly bags","shopping bags","garbage bags","pet bottles","pet preform","caps and closures","injection molding","thermoforming","plastic pallets","rotomoulding","industrial packaging","masterbatch","polymers","engineering plastics","compounding","plastic recycling","hdpe pipe","plastic pipe","pipe extrusion","extrusion","pipe"];
async function main() {
  const rows: Array<[string, number]> = [];
  for (const t of TERMS) {
    try { rows.push([t, (await searchPeople({ keyword: t, page: 1, perPage: 1 })).total_entries ?? 0]); }
    catch { rows.push([t, -1]); }
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [t, n] of rows) console.log(`${t.padEnd(22)} ${n.toLocaleString()}`);
}
main();
