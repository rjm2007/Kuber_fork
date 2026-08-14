# Why an Apollo import returns far fewer leads than requested

| | |
|---|---|
| **Issue** | Client asked for 25 leads across 7–8 keywords and received 8. A separate 200-lead request returned ~28. |
| **Reported** | 13 August 2026, during a live demo |
| **Status** | Analysed — no code changed |
| **Verdict** | Mostly correct behaviour, badly reported. One genuine defect, several filters that are narrower than anyone intends. |

---

## 1. Summary

The import does **not** fetch 25 people and then throw duplicates away. It pages through Apollo repeatedly and counts only *newly inserted* leads toward the target. That part works as intended.

It falls short for four reasons, in order of impact:

1. **The tenant's Apollo pool was pre-filled.** 1,895 leads were bulk-loaded into the live workspace on 6 August. 84% of every Apollo lead the client owns arrived in that single migration, so searches now collide with it constantly.
2. **The search filters are far narrower than the keyword implies.** Every search silently intersects the keyword with 10 fixed job titles, 8 seniorities, an employee range of 10–1,000, and a verified-email requirement.
3. **The run gives up early.** Three consecutive pages with no new leads abandons that keyword, and the page ceiling is derived from Apollo's own match count.
4. **The requested number is a ceiling, not a target** — and the UI presents it as a promise.

Underneath all four sits the real usability failure: **the system knows exactly why it stopped and discards that explanation** whenever at least one lead was imported.

---

## 2. Evidence

### The two imports in question

| Batch | Leads | Countries | Time |
|---|---|---|---|
| `Injection Moulding` | **8** | United States only | 13 Aug, 11:09 |
| `Africa_Packaging_Leads_Trial_1` | **28** | Egypt, Ethiopia, Ghana, Kenya, Libya, Morocco, Nigeria, South Africa, Uganda | 13 Aug, 14:04 |

### The pool that blocks them

| Measure | Live tenant (`Kuber Polyplast`) |
|---|---|
| Total leads | 3,259 |
| Apollo-sourced leads (incl. deleted) | 2,258 |
| **Of which came from the 6 Aug migration** | **1,895 — 84%** |
| Soft-deleted Apollo leads (still block re-import) | 349 |
| Existing leads in the **United States** | **566** |
| Existing leads in South Africa / Egypt | 59 / 30 |

### Why this confirms the diagnosis rather than contradicting it

The two runs are a natural experiment, and the result is exactly what the exhaustion theory predicts:

- The **US** search ran against a region where the client already held **566 leads** → **8 new**.
- The **Africa** search ran against regions where they held **~100 leads total** → **28 new**, over 3× better, from the same broken-looking system.

The yield tracks how much of that region had already been imported. That is pool exhaustion, not a counting bug.

---

## 3. How the import actually works

`app/api/v1/leads/apollo-search/route.ts`

```
for each keyword group:
    keywordBudget = min( ceil(remainingBudget / keywordsLeft), max_leads_per_keyword )

    for page = 1 .. pageCeiling:
        stop if overall cap hit
        stop if this keyword's budget is filled
        stop if 3 consecutive pages produced nothing new

        ask Apollo for 100 people
        on page 1: pageCeiling = min(10, ceil(total_entries / 100))

        keep only people where has_email = true
        drop anyone whose apollo_id is already in leads
        drop anyone in unenrichable_leads
        trim to remaining budget
        insert; count only rows that actually landed
```

Three details matter:

**Budget is split across keywords.** 25 leads ÷ 8 keywords = **4 per keyword**. Unspent budget *does* roll forward — `remainingBudget` is recomputed per keyword — so a keyword that yields nothing passes its share on. That mechanism is sound.

**The page ceiling comes from Apollo.** If Apollo reports 250 matches, `pageCeiling` becomes 3 and the run will never look at more than 300 people for that keyword, regardless of how many are duplicates.

**Barren pages abandon a keyword.** `MAX_BARREN_PAGES = 3`. On a 95%-duplicate niche where new leads are sparse but real, three unlucky pages in a row ends the search.

Constants: `MAX_PAGES_PER_KEYWORD = 10`, `MAX_BARREN_PAGES = 3`.

---

## 4. The exact Apollo request

`lib/services/apollo.ts` → `searchPeople()` → `POST /api/v1/mixed_people/api_search`

| Field | Value sent | Effect |
|---|---|---|
| `q_keywords` | one resolved keyword, e.g. `"molding"` | The only field the user thinks they are controlling |
| `person_titles` | **10 fixed titles** (below) | Hard filter |
| `person_seniorities` | **8 fixed levels** (below) | Hard filter |
| `include_similar_titles` | **`false`** | Title matching is near-literal |
| `organization_num_employees_ranges` | `["10,200", "200,1000"]` | Excludes <10 and >1,000 staff |
| `contact_email_status` | `["verified", "likely to engage"]` | Excludes unverified contacts |
| `person_locations` | selected countries, if any | Filters on the **person's** location |
| `per_page` | `100` | Maximum; free |
| `page` | 1…10 | Paging |

**Titles sent** (`APOLLO_TITLES`):
`purchase manager`, `procurement manager`, `plant manager`, `managing director`, `production manager`, `procurement head`, `purchase officer`, `technical manager`, `proprietor`, `founder`

**Seniorities sent** (`APOLLO_SENIORITIES`):
`owner`, `founder`, `c_suite`, `partner`, `vp`, `head`, `director`, `manager`

**What the user never sees:** picking "Injection Moulding" does not search for injection moulders. It searches for *people holding one of ten specific job titles, at one of eight seniorities, in a company of 10–1,000 staff, with a verified email, whose record mentions "molding"*. Five hidden filters, one visible.

---

## 5. Field-by-field improvement opportunities

Ordered by expected yield gain. **None of these cost extra credits** — people search is free; credits are only spent later, per lead actually revealed. That also means widening the search widens *spend*, because more matches means more reveals, so every change below needs the cap discussion alongside it.

### 5.1 `include_similar_titles: false` → `true` — highest impact

Currently forces near-literal title matching. A "Purchasing Manager", "Head of Purchasing", "Sr. Procurement Manager" or "Chief Procurement Officer" can all fail to match `purchase manager`. Turning this on is a one-word change with the largest expected effect on match volume.

**Risk:** looser titles mean less relevant people, and every one imported eventually costs a reveal credit. Pair with a tighter cap, or make it a user toggle.

### 5.2 `person_titles` — the list has real gaps

Missing terms that are standard in this industry:
`buyer`, `purchasing manager`, `sourcing manager`, `supply chain manager`, `materials manager`, `category manager`, `import manager`, `export manager`, `general manager`, `operations manager`, `head of procurement`, `owner`, `director`, `CEO`, `partner`

`export manager` is a notable omission for a business selling to exporters.

### 5.3 `organization_num_employees_ranges` — excludes both ends of the market

`["10,200", "200,1000"]` silently removes:
- companies with **fewer than 10 staff** — small trading houses and agents, a real segment here
- companies with **more than 1,000 staff** — the large manufacturers and exporters most worth winning

**Also needs verification:** Apollo's documented buckets are values like `"1,10"`, `"11,20"`, `"21,50"`, `"51,100"`, `"101,200"`, `"201,500"`, `"501,1000"`, `"1001,5000"`. Whether `"10,200"` is honoured as an arbitrary range or silently ignored/misparsed **has never been confirmed against a live response**. If it is being rejected, the filter may not be doing what anyone thinks. This is free to test.

### 5.4 `contact_email_status` — excludes `unverified`

Only `verified` and `likely to engage` are accepted. Apollo also returns `unverified`. Those contacts still have addresses and still cost the same credit; the question is whether their lower deliverability is worth it. Currently the decision is hard-coded and invisible.

### 5.5 `person_locations` vs `organization_locations` — possibly the wrong axis

The search filters on where the **person** is, not where the **company** is. For an export-targeting business, "Kenyan plastics companies" is the intent — but a procurement manager for a Kenyan firm who lives in Dubai is excluded, while a Kenyan-resident employee of an unrelated multinational is included.

Apollo supports `organization_locations` on the same endpoint. Using it — or both — likely matches intent better. **Requires verification** against a live response before switching.

### 5.6 `q_keywords` — one term per search, matched broadly

`q_keywords` searches loosely across the record, so `"molding"` can match on almost any mention. Combined with the collapse below, the effective search surface is narrower than the keyword list suggests.

### 5.7 Keyword collapse is invisible

The 29 selectable labels resolve to only **22 distinct Apollo queries**. All four "Masterbatch…" labels issue the same search; all three "Recycling…" labels likewise. Selecting 8 labels may perform as few as 5 searches, and the budget is divided by the *collapsed* group count. The user is never told.

---

## 6. The genuine defect

**Deleted leads permanently block re-import.**

`app/api/v1/leads/apollo-search/route.ts` — the duplicate check:

```ts
const { data: existing } = await db
  .from("leads").select("apollo_id, assigned_to").in("apollo_id", apolloIds);
```

There is no `is_deleted = false` filter. **349 soft-deleted Apollo leads** in the live tenant therefore block those people from ever being found again, and the client is told they are "already there" when they are not in their list at all.

There is a defensible argument for this behaviour — re-importing a deleted lead spends another reveal credit — but it is currently silent and mislabelled. This needs a deliberate product decision, not a silent one.

---

## 7. The reporting failure

`components/app/lead-forms.tsx` → `ApolloForm.handleImport()`

The API already returns everything needed to explain a short result:

- `skipped` — how many were already in the list
- `skipped_unenrichable` — how many are in the do-not-ask archive
- `warnings[]` — e.g. *"[Masterbatch] stopped after 3 pages with no new leads — got 0 of 4"*
- `duplicate_owners` — who already owns the duplicates
- `total_entries` — how many Apollo claims to hold

The UI reads `inserted`, shows a duplicate-owners toast, and then:

```ts
if (inserted === 0) {
  setError(warnings.length > 0 ? `No leads were imported: ${warnings[0]}` : "...");
  return;
}
onImport(inserted);   // warnings dropped on the floor
```

**Warnings are only surfaced when zero leads are imported.** Import 8 out of 25 and every explanation is discarded. The client sees "8 leads" and no reason — which is precisely why this looks like a bug rather than an exhausted niche.

---

## 8. Files involved

| File | Role | Problem |
|---|---|---|
| `app/api/v1/leads/apollo-search/route.ts` | Search, dedup, insert | Duplicate check ignores `is_deleted`; `MAX_BARREN_PAGES = 3` gives up early; page ceiling from Apollo's count; budget split across collapsed keyword groups |
| `lib/services/apollo.ts` (`searchPeople`) | Builds the Apollo request | `include_similar_titles: false`; employee ranges unverified; `person_locations` may be the wrong axis |
| `lib/constants.ts` | Filter definitions | `APOLLO_TITLES` too narrow; `EMPLOYEE_RANGES` excludes both market ends; `contact_email_status` excludes unverified; 29 labels → 22 queries |
| `components/app/lead-forms.tsx` (`ApolloForm`) | Import UI | Discards `warnings` unless zero imported; never shows skipped counts or keyword collapse |

---

## 9. Recommended changes

### Tier 1 — Reporting only. No behaviour change, no extra credits.

1. **Always show the outcome summary**, not only at zero:
   *"25 requested · 8 imported · 47 already in your list · 2 previously deleted · 3 keywords exhausted."*
2. **Always surface `warnings[]`** when `inserted < requested`.
3. **Show keyword collapse before searching** — *"8 labels → 5 Apollo searches"*.
4. **Reword the cap** from "Overall leads for this import" to "Maximum leads for this import", so it reads as a ceiling.

This alone would have prevented the demo from looking broken.

### Tier 2 — Yield, with credit implications

5. **`include_similar_titles: true`** — largest single expected gain.
6. **Widen `APOLLO_TITLES`** with the missing procurement/export terms.
7. **Widen `EMPLOYEE_RANGES`** to include <10 and >1,000, after verifying the format is honoured.
8. **Raise `MAX_BARREN_PAGES`** from 3 to ~5, and consider making it proportional to the duplicate rate rather than a flat count.

Every item here increases how many leads are found, therefore how many reveals are queued, therefore spend. They should ship together with the cap made prominent.

### Tier 3 — Product decisions

9. **Deleted leads:** exclude them from the duplicate check, or keep blocking but report them separately as "previously deleted" instead of "already there".
10. **`person_locations` vs `organization_locations`:** decide which matches the export-targeting intent.
11. **`unverified` emails:** include or not — deliverability against volume.

---

## 10. Needs verification against a live Apollo response

All free — people search costs 0 credits.

- Whether `"10,200"` / `"200,1000"` are honoured as employee ranges, or silently ignored.
- Whether `organization_locations` behaves better than `person_locations` for this use case.
- Actual `total_entries` for a typical keyword with the full filter stack, which would show how much headroom exists before any tuning.
- How much `include_similar_titles: true` widens results in practice.

A single throwaway script issuing these searches would quantify the whole funnel at zero cost, and should precede any tuning so the changes are measured rather than guessed.

---

## 11. What to tell the client

The import worked correctly; the reporting did not.

They asked for 25 leads from US injection-moulding companies. They already owned 566 US leads, most loaded during the 6 August migration, so Apollo had almost nothing left to offer under the current filters. The same system, pointed at Africa where they held ~100 leads, returned 28 — over three times as many.

The number entered is a **maximum**, not a quantity that will be delivered. The system should have said "8 new, 47 already yours, these keywords are exhausted — try a different region or widen the filters", and instead it said nothing.
