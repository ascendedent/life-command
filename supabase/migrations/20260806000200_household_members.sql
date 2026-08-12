-- =============================================================================
-- Whose account is this.
--
-- Linking a partner's bank already worked — Plaid Link takes any credentials —
-- but every account then landed in one undifferentiated pile. A household that
-- shares a dashboard still needs to know which balances are whose: to answer
-- "what do we have" and "what do I have" from the same data, and to keep one
-- person's spending from silently becoming the other's budget overrun.
--
-- Not multi-user. There is still exactly one login and RLS still allows exactly
-- one owner; this is an attribute of an account, not an identity that can sign
-- in. Adding a second login would mean rethinking every policy in the schema,
-- and that is a different project from telling two people's money apart.
-- =============================================================================

create table if not exists public.household_members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- The owner of the install. Exactly one, and it cannot be deleted.
  is_primary boolean not null default false,
  color      text,
  created_at timestamptz not null default now()
);

create unique index if not exists household_members_one_primary
  on public.household_members (is_primary) where is_primary;

create unique index if not exists household_members_name_key
  on public.household_members (lower(name));

alter table public.household_members enable row level security;
drop policy if exists owner_all on public.household_members;
create policy owner_all on public.household_members
  to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.household_members to authenticated;
grant all on public.household_members to service_role;

-- Per account, not per institution: a joint chequing account and one person's
-- own savings routinely live behind the same login.
alter table public.accounts
  add column if not exists member_id uuid references public.household_members(id) on delete set null;

create index if not exists accounts_member_idx on public.accounts (member_id);

comment on column public.accounts.member_id is
  'Which household member this account belongs to. NULL means unassigned, which
   is treated as the household rather than hidden — an unlabelled account must
   never quietly drop out of net worth.';

-- A generic primary member so a fresh install has something to assign to. The
-- name is data the owner edits; nothing personal ships in the schema.
insert into public.household_members (name, is_primary)
select 'Me', true
where not exists (select 1 from public.household_members where is_primary);
