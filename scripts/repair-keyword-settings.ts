/**
 * Repair the live industry_keyword_groups rows.
 *
 * DELIBERATELY A MERGE, NOT AN OVERWRITE. The workspaces have already been
 * edited by hand since seeding (the film group was renamed, a blank keyword was
 * added), and settings carry no audit trail - an overwrite would silently
 * discard whatever else someone had changed, with no way back. So this touches
 * exactly two things:
 *   1. the "blown-film" group, restored from DEFAULT_INDUSTRY_KEYWORD_GROUPS,
 *      because the seed shipped the pre-restoration version and the client lost
 *      the group name plus "Blown Film", "Packaging Film", "Shrink Film" and
 *      "barrier film";
 *   2. blank keyword rows, which render as empty options and send an empty
 *      q_keywords to Apollo.
 * Everything else is left exactly as found. Run with --apply to write.
 */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_INDUSTRY_KEYWORD_GROUPS, type IndustryKeywordGroup } from "@/lib/constants";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data, error } = await db.from("settings").select("company_id, value").eq("key", "industry_keyword_groups");
  if (error) throw error;

  const canonical = DEFAULT_INDUSTRY_KEYWORD_GROUPS.find((g) => g.id === "blown-film");
  if (!canonical) throw new Error("no blown-film group in the constant");

  for (const row of data ?? []) {
    let groups: IndustryKeywordGroup[];
    try { groups = JSON.parse(row.value as string); } catch { console.log(`${row.company_id}: unparseable, skipped`); continue; }

    let blanks = 0, restored = false;
    const next = groups.map((g) => {
      if (g?.id === "blown-film") {
        const before = `${g.label} (${g.keywords?.length ?? 0} kws)`;
        if (JSON.stringify(g) !== JSON.stringify(canonical)) {
          restored = true;
          console.log(`  blown-film: "${before}" -> "${canonical.label} (${canonical.keywords.length} kws)"`);
          return canonical;
        }
        return g;
      }
      if (!Array.isArray(g?.keywords)) return g;
      const kept = g.keywords.filter((k) => (k?.label ?? "").trim() !== "" && (k?.query ?? "").trim() !== "");
      if (kept.length !== g.keywords.length) {
        blanks += g.keywords.length - kept.length;
        console.log(`  ${g.label}: removed ${g.keywords.length - kept.length} blank keyword(s)`);
      }
      return { ...g, keywords: kept };
    });

    console.log(`${row.company_id}: blown-film ${restored ? "RESTORED" : "already correct"}, ${blanks} blank(s) removed`);
    if (!restored && blanks === 0) continue;
    if (!APPLY) { console.log("  (dry run — pass --apply to write)"); continue; }
    const { error: upErr } = await db.from("settings")
      .update({ value: JSON.stringify(next), updated_at: new Date().toISOString() })
      .eq("company_id", row.company_id).eq("key", "industry_keyword_groups");
    console.log(upErr ? `  WRITE FAILED: ${upErr.message}` : "  written");
  }
}
main();
