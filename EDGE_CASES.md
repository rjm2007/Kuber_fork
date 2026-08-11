# Edge Cases Audit — Roles, Leads, Campaigns, Unibox

Read-only analysis of the current implementation's business-logic edge cases: situations where ownership, visibility, or state can diverge in ways the code allows but the product probably didn't intend. Every item is grounded in the actual route/service code, not hypothetical. No fixes applied — this is a punch list to triage.

Severity: **High** = data/ownership corruption, security-relevant, or silent data loss. **Med** = confusing UX or inconsistent rule enforcement, no data loss. **Low** = cosmetic/nice-to-have.

---

## 1. Roles & Users

### 1.7 No audit trail for lead reassignment (Med)

Campaign assignment has an append-only `campaign_assignments` table recording who/when/previous-assignee. Lead assignment has no equivalent — `assigned_at` is simply overwritten. If a lead's ownership is disputed later ("I was working this lead, why did it move?"), there's no history to check.

*(Reviewed and skipped for now — not correctness-critical, Med severity.)*

---

## 2. Campaigns

### 2.4 Campaign assignment can silently reassign leads to a third employee (High)

`POST /api/v1/campaigns/[id]/assign` with `reassign_leads=true` overwrites `leads.assigned_to` for **every lead currently in `campaign_leads`** to the new campaign assignee — including leads that were never that assignee's to begin with (e.g. leads originally owned by Employee A, added to a campaign by a manager, campaign then reassigned to Employee C: all those leads now silently become Employee C's, with no notice to Employee A). There's also no lock against reassigning an already-assigned campaign — every "assign" call is a no-questions-asked overwrite, and clicking the same assignee twice ("second click") still re-runs the lead-reassignment side effect.

### 2.5 Territory is never checked at campaign-assignment time (Med)

The assign endpoint validates only that the new assignee is `is_active` — it never checks whether that employee's territory matches the leads in the campaign. A campaign full of India leads can be assigned to a Foreign-territory rep with no warning.

### 2.6 A lead can be enrolled in multiple active campaigns simultaneously (Med)

The duplicate-guard in `campaigns/[id]/leads` only blocks re-adding a lead to the **same** campaign twice — there is no cross-campaign guard. The same lead can be actively worked in two different outreach campaigns at once, risking duplicate/conflicting emails to the same contact.

### 2.7 Lead ownership and campaign ownership drift apart permanently, by default (High)

**Resolved.** Campaign creation now forces resolution to a single employee owner (`components/app/create-campaign-modal.tsx`): if every selected lead already belongs to the same one employee, the campaign auto-assigns to them; otherwise a manager must explicitly pick an employee before the campaign can be created, and that choice is applied via `assignCampaign(..., reassignLeads: true)` so the campaign and all its leads move to the same owner together. `created_by` still records who actually created it (manager or employee) — only the *ownership* (`assigned_to`) is forced to converge.

### 2.8 Draft approval authority follows the campaign, not the lead (Med — inconsistent with reply-drafts)

Whether an employee can approve/reject/edit an initial-outreach draft is gated by campaign access (`created_by`/`assigned_to` on the *campaign*), not by whether the underlying lead is assigned to them. Concretely: if Lead L is assigned to Employee C but sits inside Campaign X (owned by Employee A), **Employee A can approve C's lead's draft while C cannot** (unless C also happens to be the campaign's creator/assignee). Largely mitigated by §2.7's fix (campaigns now converge to one owner at creation time), but can still arise via later campaign reassignment (§2.4).

### 2.9 Reply-draft access has a lead-based fallback that initial drafts don't (Med — inconsistent rule across nearly-identical features)

`assertReplyDraftAccess` falls back to "is this lead assigned to me?" when campaign access fails, so an employee whose lead got pulled into someone else's campaign keeps access to *reply* drafts but not *initial* drafts for the exact same lead. This asymmetry is confusing and worth resolving one way or the other.

### 2.10 Campaign steps/report editable by mere assignee, propagates to live sending (Med)

**Resolved.** Under the container model (§5), a campaign's Options (sender identity,
daily limit, sending window, send days, follow-up schedule — `PATCH
/campaigns/[id]/config`) and Sequences (step subject/body — `PUT
/campaigns/[id]/steps`) are campaign-wide: they propagate live to every Instantly
sub-campaign, i.e. to every lead in the container, not just the editor's own.

Both writes therefore go through `assertCampaignSettingsAccess`:

- **Managers** may always edit.
- **An employee** may edit only a campaign **no other employee is part of**. Alone
  in the container, the only sending they can change is their own leads', so there
  is nobody to surprise. The moment a teammate's lead joins it, the campaign
  reverts to manager-only.

"Employees in a campaign" (`campaignEmployeeOwners`) means every employee who owns
a lead in it, plus its creator and assignee when those are employees — so a
campaign someone built but has not filled with leads yet is still theirs. Managers
are deliberately not counted, or every manager-created container would be
permanently multi-employee and lock out the one employee working it.

Employees always keep read-only access (GET stays open) so they can see what is
being sent. The Options and Sequences tabs (`campaign-drawer.tsx`,
`edit-campaign-modal.tsx`) key off the server's `can_edit_settings` flag on the
campaign payload rather than the viewer's role, disabling every control with an
inline notice when it is false. The flag is a UI hint only — the two write routes
re-check server-side.

---

## 3. Leads — all items resolved

- **3.1** Employees now see (read-only) leads in a campaign they have access to, not just leads directly assigned to them — matches Unibox's model. Fixed in `app/api/v1/leads/route.ts`, `app/api/v1/leads/[id]/route.ts`, `app/api/v1/organizations/[id]/route.ts` via `getCampaignAccessibleLeadIds` (`lib/auth/scope.ts`).
- **3.2** Managers can now reassign a single lead directly (`PATCH /api/v1/leads/[id]` accepts `assigned_to`, manager-only) — surfaced as an "Owner" control in the lead drawer.
- **3.3** Apollo/Excel imports now return `duplicate_owners` (who already owns each skipped duplicate) and the import UI shows it via a toast.
- **3.4** Org-level enrichment fan-out (by design — one profile per org, shared by all its leads) now leaves an `audit_log` entry when it touches leads across multiple owners, and the lead drawer shows "this profile is shared with N other leads" so the current viewer isn't blindsided.
- **3.5** `scrape-orgs` claims its batch atomically via a new `claim_queued_orgs` RPC (`FOR UPDATE SKIP LOCKED`) instead of select-then-update, closing the concurrent-pickup race.
- **3.6** Documented as intentional in `lib/services/lead-removal.ts` — pre-send data is hard-deleted, post-send history (reply_events/unibox_emails/reply_drafts) is left in place and relies on existing `is_deleted` scoping.
- **3.7** Territory-based load balancing (`lib/services/assignment.ts`) is now scoped to the region being routed, not an employee's total lead count — a rep's unrelated cross-territory assignments no longer skew how many new regional leads they get next.

---

## 4. Unibox — all items resolved

- **4.1** Resolved as a side effect of §3.1 — lead visibility now matches thread visibility, so an employee who can reply to a thread can also see the underlying Lead record.
- **4.2** Outbound replies now record `sent_by` (`unibox_emails.sent_by`, new column) — set only for replies sent through our own reply endpoints, never overwritten by resync. The thread view shows the actual sender's name instead of a hardcoded "You" for every outbound message.
- **4.3** The webhook now distinguishes "resolved the campaign + lead but no active `campaign_leads` link" (the stale-sub-campaign case) from a generic unmapped reply, logging it to `audit_log` (action `reply_unmapped_stale_campaign_link`) plus a `console.error` for visibility — the `reply_events` row was already kept either way.

---

## 5. Cross-cutting scenarios (the "what if" list)

These are compound scenarios combining the above, worth explicitly deciding the intended behavior for:

1. **Manager A builds a campaign from Employee B's and Employee C's leads, then assigns the campaign to Employee D with "reassign leads" on.** Resolved for campaign *creation* (§2.7 — the manager must pick one owner up front, applied to leads immediately); still possible via a later manual reassignment (§2.4), which stays a deliberate manager action.
2. **Two managers both edit the same campaign's steps at the same time.** No optimistic-locking/version check found — last write wins, no conflict warning.
3. **A manager deactivates an employee who is mid-approval on 40 drafts.** Partially resolved: deactivation requires an explicit handover decision for the employee's held campaigns/leads before it proceeds (§1.4 fix), and draft-approval authority follows campaign access (§2.8), so the new owner automatically gains approval rights on the transferred campaigns' drafts. Still open: nobody is actively *notified* there's a queue waiting — no notification system exists yet.
11. **The only active employee has to be deactivated.** Resolved — the handover picker no longer demands a named successor. `handover_strategy: "pool"` unassigns the whole book back to the manager pool, and is the modal's default (with round-robin and territory disabled) whenever nobody else is eligible. Previously this was an unescapable dead end: "No other active employee is available to reassign to" with a dead confirm button and no way to proceed. See `lib/services/handover.ts` and the handover section of `ASSUMPTIONS.md`.
12. **A departing employee's book is redistributed across the team rather than dumped on one person.** Resolved — `round_robin` rotates the leads through the shared `assignment_cursors` lane and `territory` routes each lead by its country (anything uncovered stays in the pool). Each campaign follows whoever inherited the most of its own leads, so campaign ownership does not drift away from lead ownership (§2.7) on every handover. Unlike routine assignment, the readiness gate is deliberately *not* applied: every held lead moves regardless of status, because leaving `open`/`closed` leads behind would strand them on a deactivated account.
4. **An employee's territory is changed after leads were already assigned under their old territory.** Confirmed intentional and now documented in code (`lib/services/assignment.ts`): existing `assigned_to` leads are untouched (territory is only consulted at assignment-time, not continuously); only *new* auto-assignments honor the new territory. Retroactively re-territorying an employee's whole book on every edit would silently move leads out from under whoever is actively working them.
5. **The same lead is simultaneously a member of two active campaigns run by two different employees.** Both can draft/send outreach to the same contact independently — no cross-campaign collision detection *(§2.6, still open — Campaigns-side)*.
6. **A lead is deleted while its reply thread is open in Unibox for another user.** Resolved as intentional: the thread keeps working (matches §3.6's design — post-send history stays visible), and the Unibox UI now shows a "Lead deleted" badge in the thread header so the viewer isn't left thinking the record still exists.
7. **The last active manager deactivates themselves or gets deactivated by another manager moments earlier.** Resolved — only the last Super Admin is protected (by design); regular managers have no floor; self-deactivation is blocked for all managers (§1.3).
8. **A regular (non-super-admin) manager wants to restrict what other managers can see/do.** Resolved — Super Admin exclusively controls manager accounts (create/edit/deactivate/demote); full campaign visibility across managers is confirmed intentional (managers are collaborators, not siloed).
9. **30 India leads are bulk-selected with two active India-territory employees.** Resolved (§3.7) — territory-based bulk-assign and auto-assignment both split least-loaded-first, scoped to the region being routed; picking `manual` with one named assignee still dumps all 30 on that one person (a deliberate, explicit manager choice, not a bug).
10. **A manager creates a campaign from leads spanning multiple employees.** Resolved — the manager must pick a single employee to own the campaign (and its leads) before it can be created (the dropdown pre-fills when they already all belong to one employee) *(§2.7)*.
