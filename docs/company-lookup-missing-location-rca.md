# Why Company Lookup showed no location or staff count

| | |
|---|---|
| **Issue** | During a live client demo, a Company Lookup search for "Royal Trading" returned 100 companies with correct names, logos and websites, but a dash in the Location and Staff column of every row. Separately: "I ran two or three lookups and only one returned anything." |
| **Reported** | 18 August 2026 |
| **Status** | Root-caused and fixed |
| **Verdict** | Apollo never sent those fields. Not a rendering bug, not a filter of ours. A mock fixture that supplied them, plus a self-check asserting they survived, hid it until the first client-facing search. |

---

## 1. Location and staff count

### What happened

`POST /api/v1/mixed_companies/search` — Apollo's Organization Search, the endpoint behind step 1 of the
wizard — does not return `estimated_num_employees`, `city`, `state`, `country` or `industry`. It returns
`id, name, website_url, blog_url, angellist_url, linkedin_url, twitter_url, facebook_url, primary_phone,
languages, alexa_ranking, phone, linkedin_uid, founded_year, publicly_traded_symbol/exchange, logo_url,
crunchbase_url, primary_domain, sanitized_phone, owned_by_organization_id` and the intent fields.

The set that came back blank and the set the endpoint omits are the same set, field for field. The set that
rendered correctly — name, logo, website — is the set it returns. `normalizeOrg()` was reading keys that
were never in the payload, and the UI was correctly rendering the resulting `null` as `—`.

Nothing on our side withheld anything. No validator, no filter, no tenant scoping. `CompanySearchSchema`
imposes no field restrictions and `buildAdvanced()` returns `undefined` when the Advanced panel is
untouched, so no hidden narrowing was in play either.

### Why it survived to a client demo

Three things stacked, and each one alone would have been caught:

1. **The code suspected it and shipped anyway.** The type carried a comment saying Apollo's published field
   list "does not pin these down" and that null "means not returned, which the UI shows as —". The fallback
   key guessing (`organization_city`, `employee_count`, `num_employees`) was invented to cover a response
   nobody had looked at.
2. **The PRD gated exactly this decision, and the gate held nothing.** §6 and §19 both marked the results
   table as *Requires verification*, pending one live Organization Search with balance readings either side.
   Cost: one credit. That request was never made; the table was finalised on the assumption instead.
3. **The mock was more generous than Apollo, and the test agreed with the mock.**
   `mockSearchOrganizations` filled city, state, country, employees and industry on every fixture row, and
   `check-company-lookup.ts` asserted `estimated_num_employees != null`. Green test, complete-looking dev
   UI, field that does not exist upstream.

Point 3 is the transferable lesson: **a fixture cannot settle a question about a third-party response,
because the fixture is written by whoever holds the assumption.** Only the live response or the vendor
schema can. Running fixtures through the real parser — which this mock deliberately did — catches a renamed
key but not an absent field.

### Blast radius: smaller than it looked

The stored data was never wrong. Company Lookup creates the organization with `apollo_org_id`, the imported
leads then go through the paid reveal, and `enrich-leads.ts` backfills `city`, `country`, `employees` and
`industry` onto that same organization row from `people/bulk_match`'s nested organization object. That is
how every organization in the database already has a city. The damage was confined to the selection table
during the demo — cosmetic, but in the worst possible place.

### Options considered

| | Approach | Cost | Outcome |
|---|---|---|---|
| A | Drop the two columns; show Founded instead | 0 credits | **Chosen** |
| B | `organizations/enrich` on the one selected company | 1 credit per lookup | Available later if the client wants staff count before committing |
| C | Enrich all 100 rows in the page | 100 credits per page | Ruled out |

There is no free way to obtain these values. The free People Search returns `has_city` and
`has_employee_count` as **booleans**, not values, so the obvious zero-cost shortcut does not exist.

### Fixed

- Results table columns are now Company / Founded / Website. Founded year is returned by the endpoint and
  helps separate same-name companies, which is the entire job of this screen.
- The expanded detail panel no longer shows Industry or Full location — both were also always empty. It
  carries a one-line note instead: Apollo does not return location, staff or industry when searching by
  name, and they fill in on their own after import.
- The mock fixtures now carry **exactly** the field set of Apollo's documented Organization Search response —
  all 24 keys, in the doc's order, nothing added and nothing omitted (including `primary_phone`, `languages`,
  `alexa_ranking`, `linkedin_uid`, the publicly-traded pair and the intent fields, which the fixture
  previously lacked). Dev and production now show the same thing, and the raw payload written to
  `apollo_raw_records` in mock mode is representative of the real one.
- The self-check compares `Object.keys(row)` against a transcription of the documented field list, so a
  fixture that drifts from the vendor response fails immediately — in either direction. The old assertion
  only ever asked the fixture what the fixture contained, which is why it passed throughout.

---

## 2. "Only one of two or three lookups returned anything"

### What the evidence proves

Apollo was called exactly once that day.

- One ledger row: 12:09:53, `"Royal Trading"`, 100 returned, `balance_before: 3960`, 1 credit.
- The cached credit reading at 15:38 was 3959. 3960 − 1 = 3959, exactly.
- Independently, over the five days to that point, logged credits equalled the balance delta exactly
  (36 = 36) — so the ledger has no gap and no unlogged Apollo spend exists.

The other attempts therefore never reached Apollo. They stopped on our side or in the browser.

### What could not be determined, and why

The route wrote **no log row at all** for a search returning zero results, and **no log row on any error
path**. It logged only successes that returned results. On top of that, `apollo_raw_records` — the table
whose entire purpose is keeping the raw payload for a moment like this — **did not exist in production**:
its migration (`2026_08_14_apollo_raw_records.sql`) was the only migration file in the repository never
applied, and `saveApolloRawRecords` swallowed the resulting failure into `console.error`. Every call since
14 August had failed silently.

So the answer to "what did the other two lookups do" had to be reconstructed from a credit balance, and the
raw payload that would have answered part 1 in seconds was not there.

Ranked candidates, none confirmable after the fact:

1. **They ran against fixtures.** Three `COMPANY_LOOKUP_MOCK` rows exist for the live tenant that morning
   (09:23, 09:30, 09:38, queries `123` and `hi`). Fixtures are used on any non-production origin, so a
   demo attempt made from localhost or a preview deployment returned fabricated companies.
2. **A sessionStorage cache hit.** Identical search criteria replay the previous result set with no Apollo
   call and no log row.
3. **A step-2 block.** Selecting a company already in the system returns 409 and stops the flow.

### Fixed

- Zero-result searches now write a `COMPANY_LOOKUP_NO_RESULTS` row carrying the query, filters, page and
  `total_entries`.
- Failed searches now write a `COMPANY_LOOKUP_FAILED` row carrying the query, filters, page, HTTP status and
  error message.
- Both are logged under `source: system`, never `apollo`: Settings > Keys > Usage sums
  `payload.credits_consumed` across every apollo-source row without filtering on event name, so a free or
  failed call appearing there would corrupt the spend total.
- `apollo_raw_records` migration applied. Upsert verified against the live schema.
- A snapshot failure now writes an `APOLLO_RAW_SNAPSHOT_FAILED` row instead of only reaching stdout — the
  breakage is visible in the same place we look when we need the snapshot.

---

## 3. Two assumptions checked while in here

**A zero-result search is free — confirmed.** The wizard tells the client an empty search cost nothing, and
the route writes no paid ledger row for one. Both rested on an unverified code comment. Measured against the
live account: balance 3959 before a zero-match page and 3959 after. The claim is accurate and the copy stands.
`scripts/apollo-zero-result-credit-probe.ts` reproduces it for one credit at most; it does not need running
again unless Apollo changes its billing.

**Organization Search decrements the counter we watch — confirmed.** PRD §17 flagged an open risk that the
credit might come from a pool the pre-flight check does not read, which would make the usage screen
under-report. It does not: both read `num_credits_remaining`, proven by the 3960 → 3959 movement and by the
five-day ledger reconciliation above.

**One thing worth knowing about `q_organization_name`.** It is a loose token match. "Royal Trading" returned
134 matches including *Danniyeh Royal Trading* and *Royal Rose Cosmetics Trading*. The practical risk runs
the other way: a full legal name with suffixes or punctuation ("… Pvt Ltd", "… LLC") often matches nothing.
If empty searches keep coming up, that is the first thing to check, and the empty state's "try a shorter
name" advice is correct.

---

## 4. Files touched

| File | Change |
|---|---|
| `supabase/migrations/2026_08_14_apollo_raw_records.sql` | applied to production (unchanged content) |
| `lib/services/apollo-raw.ts` | snapshot failure logged to `enrichment_logs`, not just stdout |
| `app/api/v1/leads/company-search/route.ts` | log zero-result and failed searches; corrected credit comments |
| `components/app/company-lookup-form.tsx` | results table → Company / Founded / Website; detail panel note; skeleton matched |
| `lib/services/apollo.ts` | corrected the field comments to state the fields are absent, not ambiguously named |
| `lib/services/apollo-mock.ts` | fixtures no longer supply the five fields Apollo omits |
| `scripts/check-company-lookup.ts` | assertions inverted to encode Apollo's real contract |
| `scripts/apollo-zero-result-credit-probe.ts` | new — the measurement, repeatable |
| `docs/company-lookup-prd.html` | four *Requires verification* items resolved with the measurements |
