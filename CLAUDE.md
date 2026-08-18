# Kuber — agent notes

## One shared component per control type (hard rule, strict)

**Every field-like control anywhere in this app MUST be the shared component from `components/ui/` — never a one-off hand-styled element, and never a local re-implementation.**

| Control | Use this, always |
|---|---|
| Text / number / email input | `Input` (`components/ui/input.tsx`) |
| Multi-line text | `Textarea` (`components/ui/textarea.tsx`) |
| Dropdown / picker | `Select` + `SelectTrigger` (`components/ui/select.tsx`) |
| Checkbox / tri-state selection | `AppCheckbox` (`components/ui/app-checkbox.tsx`) |
| Radio | `AppRadio` (`components/ui/app-radio.tsx`) |
| Single date | `DatePicker` (`components/ui/date-picker.tsx`) — wraps `Calendar` + `Popover`; never hand-roll a `Popover`+`Calendar`+`Button` date trigger again |
| Multi-select country/region | `LocationsPicker` (`components/ui/locations-picker.tsx`) |
| Toggle | `Switch` (`components/ui/switch.tsx`) |
| Rich text / HTML body | `RichTextEditor` (`components/ui/rich-text-editor.tsx`) |
| Choice card (a radio/checkbox rendered as a clickable bordered box with a label+description, e.g. "Assign imported leads" strategy cards, handover-strategy cards, Sequences' Step 1/Step 2 cards) | No dedicated component yet, but the fill rule is the same as every other field: `bg-field` when unselected, `border-primary bg-primary/10`-style tint when selected. Never `bg-card`/no-fill — a choice card is a field, not a panel. |
| Multi-step wizard progress | `Stepper` (`components/ui/stepper.tsx`) — the not-yet-reached step pill is `bg-field` for the same choice-card reason; don't hand-roll step chips. |
| Apollo credit-cost messaging ("N leads/contacts selected → N credits will be spent") | `ApolloCostNote` (`components/app/apollo-cost-note.tsx`) — shown twice per Apollo-backed import flow: once where the count that drives cost is chosen, once as final confirmation right before the button that spends it. Same UI in test-mode workspaces too (real credit count + a "(test)" tag), never a different box/copy for mock vs real. See `docs/apollo-credit-usage-rca.md` for the cost model — search is free, reveal is 1 credit/contact, org search is 1 credit/page; **no individual filter field has its own cost**, confirmed against Apollo's own docs, so never add a per-field "uses credits" pill. |

A miss worth remembering: `RichTextEditor` looked like a plain panel bug (its wrapper was `bg-card`) but the real cause was that it's a fully custom component, not built on the shared `Textarea` — so the global `Textarea` → `bg-field` fix never reached it. When a field-like control renders wrong, check whether it actually goes through one of the components in this table before assuming the token/ladder is at fault; a bespoke reimplementation is the more common cause.

Before writing a new field-like control (a hand-rolled `<input>`, a `Popover`-based trigger button standing in for a select, a `<input type="radio"/checkbox">`, a bespoke date field, etc.), **check this table first.** If nothing fits, extend the existing shared component's props (as `DatePicker` was extended with `size`/`showQuickActions`) rather than building a local one-off in the calling file. A local `DateField`/`FIELD_FILL`-style helper duplicated per-file is exactly the bug this rule exists to prevent — it already happened twice (`create-campaign-modal.tsx` and `edit-campaign-modal.tsx` each had their own copy of a `FIELD_FILL` constant, and `company-lookup-form.tsx` had its own `Popover`+`Calendar` date field) before being consolidated.

Exception: raw `<input type="file" hidden>` and raw `<input type="checkbox"/radio">` used purely as a native a11y target under a custom-styled wrapper (not visible itself) don't need a shared wrapper — but the *visible* control next to them (the checkmark, the radio dot) still must be `AppCheckbox`/`AppRadio`.

## UI surface contrast (hard rule)

**A field's fill (`bg-field`) must never match its surrounding container's fill, and a field's wrapper must never be given its own card/white background "for emphasis."**

If a field sits on a container using the same fill, it disappears — thin borders alone are not enough. This has bitten us repeatedly in light mode (Add user, Batch Name, and other forms): a plain padding wrapper around one field was styled with `bg-card` + `border`, which visually competed with the white field inside it and read as a second nested card. The fix in that case was to strip the wrapper down to bare spacing (no bg, no border) and let the field itself carry the only white in that region.

### Surface ladder

| Role | Token | Notes |
|------|--------|--------|
| Page | `bg-background` | Page chrome |
| Panel / card / modal | `bg-card` | Top-level cards, modals — a bordered region, not a separate white block |
| Nested section | `bg-secondary` | Inside a panel/drawer |
| Field | `bg-field` | Input, Select, Textarea, Checkbox, Radio, DatePicker trigger, and every other field-like control — the ONLY white surface in light mode |

### Do / don't

- **Do** keep shared `Input` / `SelectTrigger` / `Textarea` / `AppCheckbox` / `AppRadio` / `DatePicker` on their default `bg-field` — never override it.
- **Don't** override fields with `bg-card`, `bg-secondary/NN`, `bg-white`, or any other ad-hoc fill. If a field looks invisible against its container, that means the *container* is wrong (should have no fill, or should be the next ladder step down), not the field.
- **Don't** wrap a single field (or a couple of fields) in its own `bg-card`/bordered box purely for visual grouping — that reintroduces a competing white/card surface. Plain spacing (`p-4`, `space-y-*`) is enough; save `bg-card` + `border` for an actual multi-row panel (a data table, a list of results, a modal).
- **Don't** duplicate a field-fill constant per file (see the component-reuse rule above) — if the shared default isn't enough, extend the shared component.

### Row-list surfaces are white, not shade (exception, by design)

**A bordered container whose whole job is to hold a list of selectable/clickable rows — a search-results table, a people/contacts picker, a conversation list — uses `bg-field dark:bg-card`, not `bg-card`.** This is the one deliberate exception to "panels are shade gray": the list itself reads as a white surface sitting on the normal gray page/panel behind it, the same way a single field would. Loading skeletons for that list get the same treatment so they don't flash gray then flip white once data arrives.

This is different from wrapping a couple of fields in `bg-card` for grouping (still banned, see above) — the trigger is "this container's content is a `.map()` of rows a user picks from," not "this container has more than one child."

Examples: `company-lookup-form.tsx` (company results table, people picker, and their loading skeletons), `unibox-thread-list.tsx` (conversation list), `campaign-drawer.tsx` (the Leads-tab table + its skeleton, the Outbox mail-thread container), `discussion-comment.tsx` (chat message bubbles and the reply composer — a chat log is a row-list of messages). Not a match: a panel that mixes a header/inline form with a table inside one wrapper (e.g. `team-view.tsx`'s Users card) — that's a panel that happens to contain a table, not a bare row-list, so it stays `bg-card`.

**Corollary — a bare-row list (no card chrome per row, just `divide-y` separators) follows the exception above and the whole container goes white. But a list whose rows already read as individual cards (rounded, bordered, gapped) does NOT also make the container white — that would be two white layers stacked with nothing between them.** There, the container stays the normal page/panel shade and each row-card is `bg-field` on its own, exactly like a kanban card sitting on its column. `campaign-drawer.tsx`'s Outbox lead-tiles rail is this case: the rail itself has no bg (transparent, showing the ambient page shade), and each lead row is its own `rounded-lg border bg-field` card with a gap between them — it looked like a "make the container white" case at first (bare list, no visible per-row card border) but the fix that actually matched the design intent was restyling the rows into cards, not whitening the container.

### Light-mode color budget (client requirement, strict)

Light mode uses exactly **4 colors**: primary, one primary-tinted "shade" gray, full white, and black text. No other near-white or near-gray value may exist. Concretely (see `buildLightPalette()` in `lib/branding.ts`):

- **Shade** (one gray, reused flat) → `background`, `card`, `popover`, `secondary`, `muted`, `accent`.
- **White** (the only white) → `field` only, via `bg-field`.
- **Black** (with opacity for the muted variant, never a separate gray) → `foreground`, `card-foreground`, `popover-foreground`, `secondary-foreground`, `accent-foreground`; `muted-foreground` is black at 60% opacity.
- **Primary** → `primary`, `ring`, and nothing else.
- `border`/`input` are a slightly darker step of the same shade hue (needed so a border line stays visible against both the shade and white) — this is not a 5th color, it's an opacity/lightness step of the shade, same as `muted-foreground` is a step of black.

If a design need seems to require a new near-white or near-gray tone, it doesn't — use opacity on one of the four instead, or reconsider whether the surface should be a field (white) or a panel (shade). Dark mode is unaffected by this rule and keeps its existing tinted ladder.

See also the ladder comment in `app/globals.css`.

## No focus ring at all (hard rule)

**No element may show any visible focus ring or outline on selection/click/tab — no browser native outline, and no Tailwind `ring-*` box-shadow either.** This applies to inputs, selects, textareas, calendar/date-picker day cells, dropdown triggers, buttons, anything focusable.

This was a blue rectangle in two different forms: the browser's native `outline`, and separately our own `focus-visible:ring-2 focus-visible:ring-ring` utility (used on `Input`/`Select`/`Textarea`/`Button`) — in light mode `--ring` resolves to the primary brand color, so that box-shadow ring rendered blue too. Both are killed globally in `app/globals.css` via:

```css
*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }
```

right after the `* { border-color: var(--border); }` rule. Do not remove or narrow that rule, and do not re-add `outline` or `ring-*`/`shadow-*` on `:focus`/`:focus-visible` anywhere, even scoped to one component — the global `!important` reset is intentional and should stay the single source of truth.

- **Don't** add `focus:outline-*`, `focus-visible:outline-*`, `focus:ring-*`, or `focus-visible:ring-*` Tailwind classes on new components. They're dead weight — the global reset overrides them anyway — and reintroducing them invites someone to "fix" the reset instead of just deleting the dead classes.
- If a new custom interactive element needs a *non-focus* visual state for being active/selected/open (e.g. the locations picker's open state), use a state-driven class (`data-[state=open]:...`, a conditional className) instead of a focus pseudo-class.
