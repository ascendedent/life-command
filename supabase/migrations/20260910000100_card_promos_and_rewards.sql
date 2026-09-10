-- =============================================================================
-- Promo end dates and cash-back rates — the two things about a card that decide
-- what it costs and what it earns, and that Plaid does not return.
--
-- Plaid reports a card's APR array, so the dashboard can already say "0% on
-- purchases". What it cannot say is *until when*. A 0% balance is free money
-- right up to the day it reprices, at which point it becomes the most expensive
-- debt in the account. The difference between those two states is a single date
-- that exists only on the paper statement, so it has to be entered by hand.
--
-- Same for rewards: the issuer's category multipliers are nowhere in the API,
-- but they decide which card a given purchase belongs on. Modelled per category
-- with caps, because the rates that matter most (5% rotating, 3% dining) are
-- exactly the ones that are capped or expire.
-- =============================================================================

create table public.card_promos (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts (id) on delete cascade,
  kind              text not null default 'balance_transfer'
                    check (kind in ('balance_transfer','purchase','both')),
  apr               numeric(7,4) not null default 0,
  ends_on           date not null,
  started_on        date,
  balance_at_start  numeric(14,2),
  post_promo_apr    numeric(7,4),   -- what it reprices to; null = use the card's purchase APR
  -- True for retail "no interest if paid in full by" financing, where failing
  -- to clear the balance by ends_on charges ALL the interest back to day one.
  -- A normal 0% promo only starts charging from the end date forward. The two
  -- are worth wildly different amounts of urgency, so they are not the same flag.
  deferred_interest boolean not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index card_promos_account_idx on public.card_promos (account_id);
create index card_promos_ends_idx    on public.card_promos (ends_on);

create trigger card_promos_updated_at
  before update on public.card_promos
  for each row execute function public.set_updated_at();

comment on table public.card_promos is
  'Promotional APR windows entered by hand from the statement. Plaid returns the
   rate but never the end date, which is the number that decides whether a
   balance is free or expensive.';

create table public.card_rewards (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.accounts (id) on delete cascade,
  -- null category = the card's base rate on everything not otherwise matched
  category_id uuid references public.categories (id) on delete cascade,
  rate        numeric(6,3) not null check (rate >= 0),  -- percent back
  cap_amount  numeric(14,2),   -- spend cap per period before the rate drops to base
  cap_period  text check (cap_period in ('month','quarter','year')),
  -- rotating categories: a 5% quarter that has to be re-entered each quarter
  starts_on   date,
  ends_on     date,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index card_rewards_account_idx  on public.card_rewards (account_id);
create index card_rewards_category_idx on public.card_rewards (category_id);

create trigger card_rewards_updated_at
  before update on public.card_rewards
  for each row execute function public.set_updated_at();

comment on column public.card_rewards.category_id is
  'Null means the base rate — what the card earns on anything with no better
   category match. Exactly one base row per card is the intended shape.';

-- Same single-owner policy as every other application table.
do $$
declare t text;
begin
  foreach t in array array['card_promos','card_rewards'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated
         using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;
