-- What the manager actually asked for, kept with the import.
--
-- On 2026-09-04 a client typed 500 and received 400. The reason was knowable
-- (8 keywords x a hard 50-per-keyword ceiling = 400) but not PROVABLE: `imports`
-- stored only the label, the final count and the assignment strategy. The
-- keywords, the countries, the caps, and the warnings the search route already
-- generates all lived in the HTTP response and were discarded when it closed.
-- Every import was unauditable the moment the browser got its answer, so the
-- only honest reply to "why did I get 400?" was a guess.
--
-- search_criteria also records `reachable_ceiling` (keywords x
-- max_leads_per_keyword) next to the number requested, because that is the
-- limit that actually binds and it is invisible in the UI today.
alter table public.imports
  add column if not exists search_criteria jsonb,
  add column if not exists search_warnings jsonb;

comment on column public.imports.search_criteria is
  'Exactly what was requested: keywords, locations, titles, seniorities, advanced filters and the caps. Written once at import time, never updated.';
comment on column public.imports.search_warnings is
  'Why the import stopped short of its cap - per-keyword exhaustion, page limits, credit clamping. Previously returned to the browser and thrown away.';
