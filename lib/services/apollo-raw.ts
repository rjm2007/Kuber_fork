import type { SupabaseClient } from "@supabase/supabase-js";

export type ApolloRawKind = "organization" | "person";

/** Persist the latest Apollo JSON for each id. Failures are logged, never
 *  thrown — losing a snapshot must not fail a search the manager already paid
 *  for (or a free people listing).
 *
 *  But a failure that only reaches `console.error` is the same as no failure at
 *  all. The 2026_08_14 migration creating `apollo_raw_records` was never applied
 *  to production, so every call here failed silently from 14 Aug onward — and on
 *  18 Aug, when we needed a raw organization payload to explain why Company
 *  Lookup showed no location, there was nothing to look at. The snapshot exists
 *  precisely for the moment something goes wrong, so its own breakage has to be
 *  visible in the same place we look then: `enrichment_logs`. */
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
    // Logged under `system`, never `apollo`: Settings > Keys > Usage sums
    // payload.credits_consumed across every apollo-source row without filtering
    // on event name, so a row there would corrupt the spend total.
    await db.from("enrichment_logs").insert({
      source: "system",
      event: "APOLLO_RAW_SNAPSHOT_FAILED",
      payload: { kind, rows: rows.length, error: error.message, credits_consumed: 0 },
    }).then(() => {}, () => {}); // last resort — never let logging break the caller
  }
}
