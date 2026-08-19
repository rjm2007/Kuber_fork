/**
 * Does a ZERO-RESULT organization search cost a credit?
 *
 * Run: npx tsx scripts/apollo-zero-result-credit-probe.ts
 *
 * Why this exists: `searchOrganizations` is billed per page requested, not per
 * result returned, and both the service comment and the wizard's empty state
 * told the client a search matching nothing is free. Apollo's docs say
 * "1 credit per page" with no zero-result exception, so the claim was an
 * assumption nobody had tested — and it could not be settled from our own
 * ledger, which deliberately writes no row when a search returns nothing.
 *
 * Method: read the balance, run ONE organization search whose name filter
 * cannot match anything, read the balance again. The delta is the answer.
 *
 * COST: at most 1 credit — exactly one `mixed_companies/search` page. The
 * balance reads are `users/api_profile`, which is free. Nothing is written to
 * the database. Run this once and record the result; there is no reason for a
 * second run.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const SEARCH = "https://api.apollo.io/api/v1/mixed_companies/search";
const PROFILE = "https://api.apollo.io/api/v1/users/api_profile?include_credit_usage=true";

// A name no real company carries, so the search is guaranteed to match zero.
// Fixed rather than random so a repeat run is provably the same query.
const NONSENSE_NAME = "zzqx-nonexistent-org-probe-7f3a91";

function loadKey(): string {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("APOLLO_API_KEY="));
  if (!line) throw new Error("APOLLO_API_KEY not found in .env.local");
  return line.slice("APOLLO_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const KEY = loadKey();
const headers = { "Content-Type": "application/json", accept: "application/json", "Cache-Control": "no-cache", "x-api-key": KEY };

async function balance(label: string): Promise<number> {
  const res = await fetch(PROFILE, { headers });
  if (!res.ok) throw new Error(`api_profile ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as Record<string, unknown>;
  const root = (data.data as Record<string, unknown> | undefined) ?? data;
  const remaining = root.num_credits_remaining;
  // Same field the app trusts — see extractApolloRemaining() for why the
  // lead-credit entitlement pair is not a balance and must not be used here.
  assert.equal(typeof remaining, "number", "api_profile did not return num_credits_remaining — cannot measure a delta");
  console.log(`${label}: ${remaining}`);
  return remaining as number;
}

async function main() {
  console.log("Apollo zero-result credit probe — costs at most 1 credit\n");

  const before = await balance("balance before");

  const res = await fetch(SEARCH, {
    method: "POST",
    headers,
    // Mirrors what searchOrganizations() actually sends: max page size, page 1,
    // name filter only. A narrower page would not measure the real call.
    body: JSON.stringify({ q_organization_name: NONSENSE_NAME, page: 1, per_page: 100 }),
  });
  if (!res.ok) throw new Error(`org search ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = await res.json() as { organizations?: unknown[]; accounts?: unknown[]; pagination?: Record<string, unknown> };
  const returned = body.organizations?.length ?? 0;
  console.log(`\nquery:            ${NONSENSE_NAME}`);
  console.log(`organizations:    ${returned}`);
  console.log(`accounts:         ${body.accounts?.length ?? 0}`);
  console.log(`pagination:       ${JSON.stringify(body.pagination ?? {})}\n`);

  assert.equal(returned, 0, "probe query matched companies — pick a different nonsense name and re-run");

  // Apollo's balance is not always updated by the time the search response
  // lands, so give it a moment before the second read.
  await new Promise((r) => setTimeout(r, 5000));
  const after = await balance("balance after");

  const spent = before - after;
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`credits spent on a zero-result search: ${spent}`);
  console.log(
    spent === 0
      ? "VERDICT: free. The empty state's \"this search cost nothing\" is accurate."
      : `VERDICT: NOT free. A zero-result search costs ${spent} credit(s) and the route logs no ledger row for it.`,
  );
  console.log(`──────────────────────────────────────────────`);
}

main().catch((e) => { console.error(e); process.exit(1); });
