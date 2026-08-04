-- App-level user settings (single row, like agent_config).
-- auto_lock_minutes: dashboard requires a fresh TOTP challenge when the last
-- one is older than this. 0 disables auto-lock.

create table public.app_settings (
  id                int primary key default 1 check (id = 1),
  auto_lock_minutes int not null default 60 check (auto_lock_minutes between 0 and 1440),
  updated_at        timestamptz not null default now()
);

create trigger app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

insert into public.app_settings (id) values (1);

alter table public.app_settings enable row level security;
create policy owner_all on public.app_settings
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
