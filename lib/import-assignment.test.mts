/**
 * The one rule that matters: "Leave in pool" must send an EXPLICIT strategy.
 * Returning {} here is what scattered a client's 400-lead import across the
 * whole team on 2026-09-04 — an absent assignment_strategy is read downstream
 * as "no preference" and falls back to the company default (round_robin).
 * Run: npx tsx --env-file=.env.local lib/import-assignment.test.mts
 * (the env file is needed only because lead-forms.tsx builds a Supabase
 *  browser client at module load — the function under test needs nothing.)
 */
import { strict as assert } from "assert";
import { buildImportAssignment } from "../components/app/lead-forms";

// Leave in pool: never {}, and never a spreading strategy.
const pool = buildImportAssignment("pool", "");
assert.deepEqual(pool, { assignment_strategy: "manual" });
assert.notEqual(Object.keys(pool).length, 0, "pool must not send an empty object");
assert.equal((pool as { assigned_to?: string }).assigned_to, undefined, "pool must not name a target");

// Ignoring a stale employee selection left over from switching modes.
assert.deepEqual(buildImportAssignment("pool", "some-employee-id"), { assignment_strategy: "manual" });

// The other three modes are unchanged.
assert.deepEqual(buildImportAssignment("manual", "emp-1"), { assigned_to: "emp-1" });
assert.deepEqual(buildImportAssignment("round_robin", ""), { assignment_strategy: "round_robin" });
assert.deepEqual(buildImportAssignment("territory", ""), { assignment_strategy: "territory" });

// "manual" with no one picked must not silently become a real assignment.
assert.deepEqual(buildImportAssignment("manual", ""), { assignment_strategy: "manual" });

console.log("import-assignment: leave-in-pool sends an explicit strategy — all checks passed");
