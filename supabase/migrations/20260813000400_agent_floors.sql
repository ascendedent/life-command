-- =============================================================================
-- Floors: guardrails about the world, not about the order.
--
-- Every limit so far asks whether an action is too big — per-transaction cap,
-- daily cap, position size, position count. All of them are properties of the
-- action, checkable without knowing anything about the owner.
--
-- "Never let my liquid cash fall below $10,000" is not that. It cannot be
-- expressed as a cap on any single transfer: two $4,000 transfers are each
-- fine and together are not. A cap is a property of an action; a floor is a
-- property of the state the action leaves behind, and it has to be evaluated
-- against a projection of the balance sheet rather than against the amount.
--
-- Floors outrank approval the same way caps do. Approving a transfer that
-- breaches one is the owner saying "I want this" while the floor is the owner
-- saying "not below here" — the earlier, calmer instruction wins.
-- =============================================================================

create table if not exists public.agent_floors (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in (
               'liquid_minimum',        -- total depository cash may not fall below
               'account_minimum',       -- this one account may not fall below
               'credit_utilization_max',-- total utilization may not rise above
               'never_touch'            -- the agent may not draw from this at all
             )),
  account_id uuid references public.accounts (id) on delete cascade,
  -- Absolute dollars, for the minimums.
  amount     numeric(14,2),
  -- Percent, for utilization ceilings.
  pct        numeric,
  -- A liquid minimum stated in months of average expenses instead of dollars.
  -- Better than an absolute figure because it moves with the owner's life
  -- rather than going quietly stale.
  months     numeric,
  -- How far ahead obligations are reserved. `recurring_items` knows what is due
  -- and when; a floor measured against a raw balance is a floor that lets the
  -- agent spend the rent because it is not due until Tuesday.
  horizon_days int not null default 14,
  enabled    boolean not null default true,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agent_floors_shape check (
    (kind = 'liquid_minimum'         and (amount is not null or months is not null))
    or (kind = 'account_minimum'     and account_id is not null and amount is not null)
    or (kind = 'credit_utilization_max' and pct is not null)
    or (kind = 'never_touch'         and account_id is not null)
  )
);

create trigger agent_floors_updated_at
  before update on public.agent_floors
  for each row execute function public.set_updated_at();

-- One floor of each kind per account (and one global floor per non-account
-- kind), so "raise my minimum" edits the rule instead of adding a second one
-- that silently contradicts the first.
create unique index if not exists agent_floors_kind_account_key
  on public.agent_floors (kind, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.agent_floors enable row level security;
drop policy if exists owner_all on public.agent_floors;
create policy owner_all on public.agent_floors
  to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.agent_floors to authenticated;
grant all on public.agent_floors to service_role;

comment on table public.agent_floors is
  'Balance-sheet invariants the agent may not violate. Checked against a
   projection of the state after a proposed action, twice — once when the agent
   proposes so the queue never offers a decision that will be refused, and once
   at execution against balances that have moved since.';
