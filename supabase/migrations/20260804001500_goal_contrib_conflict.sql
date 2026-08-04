-- A partial unique index cannot be used for ON CONFLICT inference unless the
-- statement repeats its predicate, which PostgREST's upsert never does. Since
-- Postgres already treats NULLs as distinct, the full index behaves the same
-- for manual contributions that carry no transaction — and it works as a
-- conflict target.
drop index if exists public.goal_contributions_unique_txn;

create unique index if not exists goal_contributions_unique_txn
  on public.goal_contributions (goal_id, transaction_id);
