-- =============================================================================
-- Keep the bank's own descriptor alongside the cleaned merchant name.
--
-- Sync stored `merchant_name ?? name`, so whenever Plaid supplied a tidy
-- merchant name the fuller descriptor was thrown away. The rows that show
-- useful text today ("CAPITAL ONE AUTOPAY PYMT", "DISCOVER E-PAYMENT 5827 WEB
-- ID: 251002") only do so by accident — those happen to have no merchant_name.
--
-- The descriptor is what makes a transaction identifiable when the merchant
-- name is ambiguous, both for the owner reading the list and for rules
-- matching against it.
-- =============================================================================

alter table public.transactions
  add column if not exists description text;

comment on column public.transactions.description is
  'The institution''s raw descriptor (Plaid transaction.name), kept even when a
   cleaner merchant_name is available. merchant/merchant_clean stay the display
   name; this is the underlying bank text.';

-- Backfill from the raw payload already stored on every synced transaction —
-- no re-sync, and no extra Plaid calls.
update public.transactions
   set description = raw->>'name'
 where description is null
   and raw ? 'name';

create index if not exists transactions_description_idx
  on public.transactions using gin (to_tsvector('simple', coalesce(description, '')));
