-- =============================================================================
-- Keep every APR a card carries, not just one.
--
-- Plaid returns an array per card — purchase_apr, cash_apr,
-- balance_transfer_apr and `special`, which is the promotional or introductory
-- rate. Sync stored a single number, picking purchase_apr and discarding the
-- rest, so a 0% intro offer and a 26.99% cash-advance rate were both invisible.
-- The promotional rate is the one that actually decides whether carrying a
-- balance is cheap or ruinous, and it is the one that expires.
--
-- Each entry may also carry `balance_subject_to_apr` (the issuer's own average
-- daily balance) and `interest_charge_amount` (interest charged on the last
-- statement). Both are stored because both are the issuer's own arithmetic
-- rather than ours.
-- =============================================================================

alter table public.liabilities
  add column if not exists aprs jsonb not null default '[]'::jsonb;

comment on column public.liabilities.aprs is
  'Full APR array as Plaid returns it: [{apr_type, apr_percentage,
   balance_subject_to_apr, interest_charge_amount}]. apr_type is one of
   purchase_apr, cash_apr, balance_transfer_apr, special. The `apr` column
   remains the purchase rate for the common case; read this for promotional
   rates, cash-advance rates, and the issuer''s own interest figures.';

comment on column public.liabilities.apr is
  'Purchase APR, kept as a scalar for the common case. Not necessarily the rate
   being paid — a `special` entry in `aprs` overrides it while the promotion
   lasts.';
