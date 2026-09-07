/**
 * FREE probe: what does mixed_people/api_search actually return per person?
 *
 * Our ApolloSearchPerson interface declares 8 fields, but searchPeople() does
 * `return res.json()` — so every field Apollo sends is present at runtime and
 * simply undeclared. Deciding "which contact do we keep per company" needs
 * seniority / email_status / departments, and whether they arrive on the FREE
 * search (vs only on paid bulk_match) is the whole question.
 *
 * People search costs no lead credits — see the note above searchPeople().
 */
import { searchPeople } from "@/lib/services/apollo";
import { writeFileSync } from "node:fs";

async function main() {
const raw = await searchPeople({ keyword: "blown film", page: 1, perPage: 5 }) as unknown as {
  total_entries: number;
  people: Record<string, unknown>[];
};

const people = raw.people ?? [];
console.log("total_entries:", raw.total_entries, "| people on page:", people.length);
console.log("\nFIELDS PRESENT ON A SEARCH PERSON:");
console.log(Object.keys(people[0] ?? {}).sort().join("\n"));

const WANT = ["seniority", "email_status", "departments", "organization_id", "title", "id"];
console.log("\nFIELDS WE NEED FOR RANKING:");
for (const k of WANT) {
  const seen = people.filter((p) => p[k] !== undefined && p[k] !== null).length;
  console.log(`  ${k.padEnd(16)} present on ${seen}/${people.length}`);
}

console.log("\nSAMPLE (title / seniority / email_status / org):");
for (const p of people) {
  const org = p.organization as { id?: string; name?: string } | null;
  console.log(`  ${String(p.title).slice(0, 34).padEnd(36)} ${String(p.seniority).padEnd(12)} ${String(p.email_status).padEnd(10)} ${org?.name ?? "-"}`);
}

writeFileSync("docs/apollo-research/search-person-fields.json", JSON.stringify(people[0], null, 2));
console.log("\nraw person 0 -> docs/apollo-research/search-person-fields.json");
}
main();
