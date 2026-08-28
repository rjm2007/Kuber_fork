-- Steering the follow-up writer, without rewriting the prompt.
--
-- Until now the only way to say "mention the new Dubai warehouse" was to
-- regenerate leads one at a time and hope the model picked it up. These two
-- fields are appended to the follow-up prompt AFTER the length/tone contract,
-- so an instruction can add a fact but cannot talk the model out of writing a
-- short, personalised email.
--
-- Two levels because the need genuinely has two levels: "mention the warehouse"
-- belongs on every follow-up in the campaign, while "ask directly for a call"
-- belongs only on the last one. The step instruction adds to the campaign one
-- rather than replacing it.
alter table campaigns
  add column if not exists followup_instruction text;

alter table campaign_steps
  add column if not exists ai_instruction text;

comment on column campaigns.followup_instruction is
  'Extra guidance applied to every follow-up in this campaign. Appended after the tone contract.';
comment on column campaign_steps.ai_instruction is
  'Extra guidance for this step only, added on top of the campaign-wide instruction.';
