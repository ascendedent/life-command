-- =============================================================================
-- Let income be attributed to the month it is meant to cover.
--
-- Most pay schedules land on the 15th and the 30th, and the 30th funds the
-- month that is about to start, not the one that is ending. Counting it as the
-- ending month's income overstates that month and leaves the next one looking
-- like it began with nothing — both months read wrong from a single correct
-- transaction.
--
-- Off by default: calendar attribution is what a bank statement shows, and
-- changing what a month means without being asked would be worse than the
-- problem. Expenses are never shifted — only income moves, because only income
-- is being earmarked forward.
-- =============================================================================

alter table public.app_settings
  add column if not exists income_attribution text not null default 'calendar',
  add column if not exists income_shift_from_day integer not null default 26;

alter table public.app_settings
  drop constraint if exists app_settings_income_attribution_check;
alter table public.app_settings
  add constraint app_settings_income_attribution_check
  check (income_attribution in ('calendar', 'forward_shift'));

alter table public.app_settings
  drop constraint if exists app_settings_income_shift_from_day_check;
alter table public.app_settings
  add constraint app_settings_income_shift_from_day_check
  check (income_shift_from_day between 15 and 31);

comment on column public.app_settings.income_attribution is
  'calendar = income counts in the month it posted (default, matches a bank
   statement). forward_shift = income posting on or after income_shift_from_day
   counts toward the following month, which is how a month-end paycheque is
   actually budgeted.';

comment on column public.app_settings.income_shift_from_day is
  'Day of month from which income shifts forward under forward_shift. 26 by
   default so a 15th/30th schedule splits the way it is spent, while a mid-month
   cheque stays put. Floor of 15 keeps the first half of the month from moving.';
