-- =============================================================================
-- Make the floors key usable as an ON CONFLICT target.
--
-- The index shipped with the table was over `coalesce(account_id, <sentinel>)`
-- — an expression index, which PostgREST cannot infer for ON CONFLICT any more
-- than it can infer a partial one. Setting a floor twice would have failed with
-- a complaint about a constraint the owner never wrote.
--
-- The coalesce was there because a plain unique index treats NULLs as distinct,
-- so two global floors of the same kind would not collide. Postgres 15 gave us
-- the honest way to say that: NULLS NOT DISTINCT, on the real columns.
--
-- Third time an index has been written in a shape an upsert cannot use. The
-- rule worth remembering: if a table is ever upserted, its conflict target must
-- be a plain unique index over exactly the named columns — no predicate, no
-- expression.
-- =============================================================================

drop index if exists public.agent_floors_kind_account_key;

create unique index if not exists agent_floors_kind_account_key
  on public.agent_floors (kind, account_id) nulls not distinct;

comment on index public.agent_floors_kind_account_key is
  'Conflict target for floor upserts: plain columns, NULLS NOT DISTINCT so the
   one global floor per kind collides with itself instead of multiplying.';
