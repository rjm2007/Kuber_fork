# Kuber — agent notes

## UI surface contrast (hard rule)

**Input / select / textarea fills must never match the surrounding panel background.**

If a field sits on `bg-card` (or any panel) and uses the same fill, it disappears — thin borders alone are not enough. This has bitten us in light mode on Add user and other forms.

### Surface ladder

| Role | Token | Notes |
|------|--------|--------|
| Page | `bg-background` | Page chrome |
| Panel | `bg-card` | Top-level cards, modals |
| Nested section | `bg-secondary/30` | Inside a panel/drawer — not `/20` |
| Field | `bg-background` | Input, Select, Textarea, field-like triggers |

### Do / don't

- **Do** keep shared `Input` / `SelectTrigger` / `Textarea` on `bg-background`.
- **Do** use `bg-background` (or leave the shared default) for field-like buttons (mailbox, territory, locations picker).
- **Don't** override fields with `bg-card` when they sit inside a `bg-card` panel.
- **Don't** nest `bg-card` on `bg-card`, or wash-out fills like `bg-secondary/20` on card sections — use the next ladder step so the nested surface is visible.

See also the ladder comment in `app/globals.css`.
