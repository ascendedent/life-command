-- =============================================================================
-- Make the broker-account key usable as an ON CONFLICT target.
--
-- The unique index added alongside the provider column was partial —
-- `where external_account_id is not null` — and PostgREST cannot infer a
-- partial index as a conflict target. Every upsert failed with "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification", so
-- *Create it from the broker* would have failed the first time it was pressed,
-- on a real account, with an error about a constraint the owner never wrote.
--
-- The predicate was never doing any work. A unique index treats NULLs as
-- distinct, so the hundreds of Plaid rows carrying a NULL external id do not
-- collide with each other whether the predicate is there or not.
--
-- This is the second time a partial unique index has been written where an
-- upsert needed a full one; the first silently no-op'd a whole pipeline.
-- =============================================================================

drop index if exists public.accounts_provider_external_key;

create unique index if not exists accounts_provider_external_key
  on public.accounts (provider, external_account_id);

comment on index public.accounts_provider_external_key is
  'Conflict target for broker-account upserts. Deliberately not partial:
   PostgREST cannot infer a partial index for ON CONFLICT, and NULL external
   ids do not collide anyway.';
