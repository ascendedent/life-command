-- External service connections (Gmail first; Aldyn Path A later).
-- Refresh tokens are AES-256-GCM encrypted at the application layer, same as
-- Plaid access tokens.

create table public.connections (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null unique check (provider in ('gmail', 'aldyn')),
  account_email     text,
  refresh_token_enc text not null,
  status            text not null default 'ok',
  last_error        text,
  last_polled_at    timestamptz,
  meta              jsonb,
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger connections_updated_at
  before update on public.connections
  for each row execute function public.set_updated_at();

alter table public.connections enable row level security;
create policy owner_all on public.connections
  for all to authenticated using (public.is_owner()) with check (public.is_owner());
