/**
 * Rewrite the seed migration's JSON payload from DEFAULT_INDUSTRY_KEYWORD_GROUPS.
 *
 * The seed and the constant drifted on 2026-09-07 - the migration shipped the
 * pre-restoration taxonomy while the constant carried the restored one - and
 * because the app reads the seeded DB value, the client silently lost the
 * "Blown Film" group and the measured "barrier film" term. Generating the seed
 * from the constant makes that class of drift impossible; the guard in
 * lib/keyword-catalog.test.mts fails if anyone edits one without the other.
 */
import { DEFAULT_INDUSTRY_KEYWORD_GROUPS } from "@/lib/constants";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "supabase/migrations/2026_09_07_industry_keyword_groups_setting.sql";
const json = JSON.stringify(DEFAULT_INDUSTRY_KEYWORD_GROUPS);
if (json.includes("$json$")) throw new Error("taxonomy contains the SQL dollar-quote tag");

const sql = readFileSync(FILE, "utf8");
const updated = sql.replace(/\$json\$[\s\S]*?\$json\$/, `$json$${json}$json$`);
if (updated === sql) throw new Error("no $json$ payload found to replace");
writeFileSync(FILE, updated);
console.log(`seed rewritten from constant: ${DEFAULT_INDUSTRY_KEYWORD_GROUPS.length} groups, ${DEFAULT_INDUSTRY_KEYWORD_GROUPS.reduce((a, g) => a + g.keywords.length, 0)} keywords`);
