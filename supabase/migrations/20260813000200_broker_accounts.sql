-- =============================================================================
-- Let an account come from somewhere other than Plaid.
--
-- The executor lands every order in an account row flagged
-- `is_agent_controlled`, and the guardrails refuse an order with no such
-- account. But the brokerage account is at Alpaca, and Alpaca is not a bank
-- Plaid aggregates — so the one account trading actually needs was the one
-- account that could never exist. The picker on the Agent page had nothing to
-- pick, and no amount of correct guardrail code was going to fix that.
--
-- `plaid_account_id` was the obvious place to stash a broker id and the wrong
-- one: a column called plaid_account_id holding an Alpaca id is a lie that
-- every later reader has to discover. A provider and its own id for the account
-- says what is true, and leaves room for Kalshi at 3b.
-- =============================================================================

alter table public.accounts
  add column if not exists provider text not null default 'plaid',
  add column if not exists external_account_id text;

create unique index if not exists accounts_provider_external_key
  on public.accounts (provider, external_account_id)
  where external_account_id is not null;

comment on column public.accounts.provider is
  'Where this account comes from: plaid (the default, and every aggregated bank
   account), or a broker the platform talks to directly — alpaca, kalshi.';

comment on column public.accounts.external_account_id is
  'The provider''s own id for the account. NULL for Plaid rows, which already
   have plaid_account_id; set for broker accounts so a refresh updates the row
   it created rather than adding another.';
