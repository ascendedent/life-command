-- =============================================================================
-- Statement balances, by that name.
--
-- Sync was already writing Plaid's `last_statement_balance` into a column
-- called `balance`, next to a card's live `current_balance` on the account. Two
-- different numbers, one of them named as though it were the other, and neither
-- labelled — so nothing downstream could tell you the figure that actually
-- decides whether you pay interest.
--
-- That distinction is not academic here. The recap once reported interest
-- accruing on a card whose statement balance is paid in full every month,
-- because it reasoned from a balance rather than from what was billed. The
-- statement balance is what you must pay to owe nothing; the current balance
-- includes everything charged since, which you do not yet owe.
-- =============================================================================

alter table public.liabilities
  add column if not exists last_statement_balance   numeric(14,2),
  add column if not exists last_statement_issue_date date,
  add column if not exists last_payment_amount      numeric(14,2),
  add column if not exists last_payment_date        date,
  add column if not exists is_overdue               boolean;

-- The existing column already held this figure; move it under the honest name
-- so nothing has to be re-synced to become correct.
update public.liabilities
   set last_statement_balance = balance
 where last_statement_balance is null and balance is not null;

comment on column public.liabilities.last_statement_balance is
  'What the last statement billed — the amount that must be paid to avoid
   interest. Not the same as accounts.current_balance, which includes charges
   made since the statement closed and is not yet owed.';

comment on column public.liabilities.balance is
  'Legacy alias of last_statement_balance, kept so existing readers do not
   break. New code should read last_statement_balance, which says what it is.';

comment on column public.liabilities.is_overdue is
  'Plaid''s own flag. Reported rather than derived: whether a payment is late
   depends on the issuer''s posting, not on comparing a due date to today.';
