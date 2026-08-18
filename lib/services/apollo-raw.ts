import type { SupabaseClient } from "@supabase/supabase-js";

export type ApolloRawKind = "organization" | "person";

/** Persist the latest Apollo JSON for each id. Failures are logged, never
 *  thrown — losing a snapshot must not fail a search the manager already paid
 *  for (or a free people listing). */
export async function saveApolloRawRecords(
  db: SupabaseClient,
  kind: ApolloRawKind,
  records: { apollo_id: string; payload: unknown }[],
): Promise<void> {
  const rows = records
    .filter((r) => r.apollo_id && r.payload != null)
    .map((r) => ({
      kind,
      apollo_id: r.apollo_id,
      payload: r.payload,
      fetched_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;

  const { error } = await db.from("apollo_raw_records").upsert(rows, {
    onConflict: "company_id,kind,apollo_id",
  });
  if (error) {
    console.error("apollo_raw_records upsert failed:", error.message);
  }
}
