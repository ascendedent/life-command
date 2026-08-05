-- =============================================================================
-- Owner-controlled sender rules for receipt ingestion.
--
-- Heuristics catch banks and card issuers, but they cannot know that a given
-- sender is not a purchase for THIS owner: a 401(k) contribution confirmation
-- is a real financial email with a real dollar amount that is not an expense,
-- and neither is a transfer notice, a payroll advice, or an invoice from a
-- client. One click on a receipt row should stop that sender counting forever.
-- =============================================================================

create table public.receipt_sender_rules (
  id         uuid primary key default gen_random_uuid(),
  -- What to compare. `domain` matches the sender domain (suffix-aware, so
  -- "capitalone.com" also catches "notification.capitalone.com"); `address`
  -- matches the full From address; `vendor` matches the parsed merchant name.
  match_type text not null check (match_type in ('domain', 'address', 'vendor')),
  pattern    text not null,
  action     text not null default 'ignore' check (action in ('ignore', 'allow')),
  note       text,
  hit_count  int not null default 0,
  created_at timestamptz not null default now(),
  unique (match_type, pattern)
);

create index receipt_sender_rules_action_idx on public.receipt_sender_rules (action);

alter table public.receipt_sender_rules enable row level security;
create policy owner_all on public.receipt_sender_rules
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

grant select, insert, update, delete on public.receipt_sender_rules
  to authenticated, service_role;

-- `allow` wins over every heuristic, so a merchant the issuer-detector
-- misreads (a bank that genuinely sells you something) can be rescued without
-- editing code.
comment on table public.receipt_sender_rules is
  'Owner overrides for receipt ingestion: ignore = never a receipt, allow = always consider one.';
