# Apollo search filters — measured, not assumed

**Method:** live probes against `mixed_people/api_search` (Apollo documents this endpoint at **0 credits**). No organization search, no `bulk_match`, no database writes. Reproduce with `npx tsx scripts/apollo-filter-probe.ts`.

Two scenarios, both taken from the client's real 13 August imports:

- **`molding` / United States** — the run that produced 8 leads
- **`packaging` / Kenya, Nigeria, South Africa, Egypt, Ghana** — the run that produced 28

---

## 1. Current search behaviour

`lib/services/apollo.ts` → `searchPeople()` sends **seven** filters per search:

| # | Field | Value |
|---|---|---|
| 1 | `q_keywords` | one resolved keyword |
| 2 | `person_titles` | 10 fixed titles |
| 3 | `person_seniorities` | 8 fixed levels |
| 4 | `organization_num_employees_ranges` | `["10,200", "200,1000"]` |
| 5 | `contact_email_status` | `["verified", "likely to engage"]` |
| 6 | `include_similar_titles` | `false` |
| 7 | `person_locations` | selected countries |

---

## 2. Headline result

| | `molding` / USA | `packaging` / Africa |
|---|---:|---:|
| Broad (keyword + location only) | 7,032 | 8,543 |
| **Current production — all 7 filters** | **46** | **59** |
| **Proposed — wider titles, similar titles, wider sizes** | **378** | **303** |
| Gain | **8.2×** | **5.1×** |

**The client asked for 25 US moulding leads from a total available pool of 46 — while already owning 566 US leads.** Extracting 8 new ones from that was close to the maximum the filters allowed. The import was not broken; the pool was nearly empty.

---

## 3. Per-filter measurement

Each row removes or changes exactly one thing from the current production filter set.

### `molding` / United States — baseline 46

| Test | Total | vs baseline | Verdict |
|---|---:|---:|---|
| Remove `person_seniorities` | 46 | **0%** | **Inert** — no effect whatsoever |
| `include_similar_titles: true` | 60 | +30% | Worth taking |
| `organization_locations` instead of `person_locations` | 47 | +2% | No material difference |
| Remove employee-size filter | 87 | +89% | Worth taking |
| Wider employee ranges | 84 | +83% | Worth taking |
| Remove `contact_email_status` | 78 *(only 46 with email)* | +0 usable | **Keep the filter** |
| **Wider `person_titles`** | **205** | **+346%** | **Biggest single lever** |
| Remove `person_titles` entirely | 813 | +1667% | **Reject — relevance collapses** |

### `packaging` / Africa — baseline 59

| Test | Total | vs baseline | Verdict |
|---|---:|---:|---|
| Remove `person_seniorities` | 59 | **0%** | **Inert** |
| `include_similar_titles: true` | 78 | +32% | Worth taking |
| `organization_locations` instead of `person_locations` | 54 | −8% | Slightly worse |
| Remove employee-size filter | 117 | +98% | Worth taking |
| Wider employee ranges | 108 | +83% | Worth taking |
| Remove `contact_email_status` | 129 *(only 46 with email)* | +0 usable | **Keep the filter** |
| **Wider `person_titles`** | **158** | **+168%** | **Biggest single lever** |
| Remove `person_titles` entirely | 550 | +832% | **Reject — relevance collapses** |

---

## 4. Lead-quality assessment

Sample titles and companies returned, judged against "someone who buys or specifies plastic".

**Proposed filter set — high relevance.** Real operating companies, decision-making roles:

```
Supply Chain Manager           @ National Molding, LLC.
Owner - CEO                    @ Molding Concepts
General Manager & Plant Manager @ Fox Valley Molding Inc
Supply Chain Manager           @ Core Molding Technologies
Founder and CEO                @ Pasco Packaging
Head of Procurement            @ Tempo Paper Pulp & Packaging
```

**No title filter — relevance collapses.** Same keyword, wrong people:

```
Group HR Executive             @ Bowler Packaging
Group Chief Financial Officer  @ Dune Packaging
Molding                        @ Thermo Fisher Scientific
Molding                        @ Pentair
```

Note the last two: with no title filter, `q_keywords` matches people whose *title is literally "Molding"* at large unrelated corporates. That is why the broad search shows 7,032 results but only **18 of the first 100 have an email at all** — it is volume without usable contacts.

This is the key distinction: **widening the title list keeps quality; removing the title filter destroys it.**

---

## 5. Employee-range format — verified

Earlier analysis flagged uncertainty over whether `"10,200"` is honoured, since Apollo documents bucket values like `"101,200"`. **Tested directly:**

| Ranges sent | Total |
|---|---:|
| No size filter | 7,032 |
| Production `["10,200","200,1000"]` | 3,962 |
| Documented buckets `["11,20"…"501,1000"]` | 3,858 |
| Nonsense `["7,9"]` | 190 |
| Huge `["1,100000"]` | 6,855 |

**Arbitrary `min,max` ranges are honoured.** `["7,9"]` collapses the result set and `["1,100000"]` restores nearly all of it, which could only happen if Apollo is parsing the numbers. The production values work as intended — they are simply **too narrow**, excluding 44% of the market: every company under 10 staff and over 1,000.

---

## 6. Person location vs organization location — no change warranted

Earlier analysis speculated that `person_locations` was the wrong axis. **The measurement does not support that.**

| | `person_locations` | `organization_locations` |
|---|---:|---:|
| USA | 46 | 47 |
| Africa | 59 | 54 |

A 1–5 result difference, and *worse* for Africa. **Recommendation: leave `person_locations` unchanged.** This was a plausible theory that the data disproved.

---

## 7. Which filters stay, which change

| Filter | Decision | Evidence |
|---|---|---|
| `q_keywords` | **Keep** | Core of the search |
| `person_titles` | **Keep but widen** | +346% / +168% with relevance intact; removing it destroys quality |
| `contact_email_status` | **Keep unchanged** | Removing it adds only people with no email — unusable, and each would still cost a reveal credit |
| `person_locations` | **Keep unchanged** | Organization locations measured no better |
| `organization_num_employees_ranges` | **Widen** | +83% with relevance intact; format confirmed honoured |
| `include_similar_titles` | **Change to `true`** | +30% / +32%, same title quality |
| `person_seniorities` | **Inert — no change needed** | Removing it changed nothing in either scenario; `person_titles` already implies the seniority. Harmless to keep, gains nothing to remove. |

Net: **two filters widened, one flag flipped, four left alone.** No filter is being removed.

---

## 8. Pagination after removing the barren-page rule

`MAX_BARREN_PAGES = 3` is removed. New stopping conditions, in order:

1. **Target met** — the keyword's share of new leads is filled → stop immediately.
2. **Apollo exhausted** — `pageCeiling = ceil(total_entries / 100)` pages have been read, or Apollo returns an empty page → stop and report *exhausted*.
3. **Page seatbelt** — `MAX_PAGES_PER_KEYWORD = 10` retained, because the import runs inside a serverless function with a hard time limit. Reported distinctly as *page limit reached*, never conflated with *exhausted*.

Pages returning only duplicates no longer end the search. The worked example now behaves as intended:

```
page 1 → 4 new     (total 4)
page 2 → 0 new     (continue)
page 3 → 0 new     (continue)
page 4 → 5 new     (total 9)
page 5 → 16 new    (total 25) → STOP
```

The seatbelt rarely binds in practice: with the widened filters these pools are 300–400 people, so `pageCeiling` is 3–4 pages.

---

## 9. Soft-delete fix — larger than it first appears

The duplicate check ignores `is_deleted`, so 349 soft-deleted leads block re-import. **But removing that filter alone would not work**, and this is important:

`uq_leads_company_apollo` is a unique index on `(company_id, apollo_id)` with **no partial predicate**, so a soft-deleted row still occupies the key. Treating the person as "new" and inserting would hit the conflict, `ignoreDuplicates` would silently drop the row, and the lead would be counted as *not inserted* — the same shortfall, now invisible.

The correct fix is to **revive** the existing row rather than insert a new one: clear `is_deleted`, attach it to the new import batch, and report it separately as *recovered*. Leads that still hold an email are recovered at **zero credit cost**; those without one re-enter the normal reveal path.

---

## 10. Partial-result reporting

Warnings are currently shown only when `inserted === 0`, so a 25-requested / 8-imported run explains nothing. Changing to `inserted < requested` and surfacing the counts the API already returns (`skipped`, `skipped_unenrichable`, `warnings`, `duplicate_owners`, `total_entries`).

---

## 11. Remaining risks

- **Spend rises with yield.** These changes are designed to find more leads, and every additional lead eventually costs a reveal credit. The per-import cap is now the only thing standing between a wide search and a large bill — it should be treated as the primary control, and the widened filters shipped with the cap made prominent in the UI.
- **Wider titles pull in adjacent roles.** "Supply Chain Manager" and "General Manager" are sound for this business; "Operations Manager" is more marginal. The list is in `lib/constants.ts` and can be trimmed after the client reviews a real batch.
- **Only two keyword/geography pairs were measured.** Both showed the same pattern and the same ranking of levers, but a third scenario would confirm it generalises.
- **`include_similar_titles: true` is Apollo's own fuzzy matching**, whose exact behaviour is not documented in detail. Measured gain was modest and clean in both tests, but it is the change most worth reviewing against a real imported batch.
