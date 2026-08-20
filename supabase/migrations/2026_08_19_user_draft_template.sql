-- Personal email TEMPLATE, kept separate from the personal drafting PROMPT.
--
-- Why this column exists: sales staff are not prompt engineers. Asked for a
-- "drafting prompt" they paste the finished email they want sent — Ankit's
-- user_settings.draft_prompt is literally a complete Kuber email with one
-- bracketed aside, "(Write about the customer's exact company name...)".
--
-- That breaks in two ways. The template REPLACES the company system prompt
-- wholesale (resolveDraftPrompt returns the personal value and never reaches
-- getSystemPrompt), so every company rule — no invented prices, no invented
-- certifications, greeting form — is silently switched off. And nothing tells
-- the model the text IS a template, so it rewrites it: measured on 19 Aug 2026
-- across 20 leads, only 48% of the template's own elements survived, and the
-- bracketed aside has previously been printed into real emails.
--
-- Splitting them lets the template be framed as a template ("reproduce this,
-- replace only the customer-specific parts") while the non-negotiable rules
-- stay on underneath it.
alter table public.user_settings
  add column if not exists draft_template text;

comment on column public.user_settings.draft_template is
  'A finished example email this user wants reproduced for their leads. Framed as a template at generation time; the company safety rules always apply on top. NULL = no personal template.';
