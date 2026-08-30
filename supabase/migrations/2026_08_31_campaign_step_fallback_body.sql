-- Per-step follow-up fallback text.
--
-- When a follow-up cannot be personalised, something safe is sent instead. That
-- happens for two different reasons, and until now they used two different
-- texts, neither campaign-aware:
--
--   lead has no company data  -> a HARDCODED constant in generate-drafts.ts,
--                                editable nowhere, naming "Kuber Polyplast" in
--                                the source itself
--   the AI failed outright    -> settings.followup_fallback_body, global to the
--                                whole install
--
-- Both mean the same thing ("we have nothing personal to say here"), so they
-- now share one text — and that text belongs to the campaign, because a campaign
-- running a 10% introductory offer wants its fallback to say so and a global
-- default can never know that.
--
-- Nullable on purpose. Empty means "use the Settings default", so every existing
-- campaign behaves exactly as it does today and a template is set only where a
-- campaign actually needs its own.
alter table campaign_steps
  add column if not exists fallback_body text;

comment on column campaign_steps.fallback_body is
  'Per-step follow-up text used when the email cannot be personalised (lead has no company data, or the AI failed). NULL means inherit settings.followup_fallback_body. Step 1 ignores this - the opening email has its own generic template in settings.';
