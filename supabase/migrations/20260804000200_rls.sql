-- =============================================================================
-- Row Level Security — single allow-listed owner (spec §7.2)
--
-- Every table is locked to the one user present in app_owner. The service
-- role (workers) bypasses RLS by design; the browser only ever holds the anon
-- key + the owner's session.
-- =============================================================================

create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.app_owner where user_id = auth.uid());
$$;

comment on function public.is_owner() is
  'True when the current authenticated user is the single allow-listed app owner.';

-- app_owner itself: user may see their own allow-list row; only service role writes it
alter table public.app_owner enable row level security;
create policy app_owner_select on public.app_owner
  for select to authenticated using (user_id = auth.uid());

-- Standard owner-only policy on every application table
do $$
declare
  t text;
begin
  foreach t in array array[
    'institutions','accounts','category_groups','categories','tags',
    'transactions','transaction_tags','receipts',
    'agent_runs','recommendations',
    'email_receipts','vendor_signatures','anticipated_transactions',
    'notification_rules','notifications_log','vendor_watchlist','watchlist_hits',
    'business_suggestions','holdings','liabilities',
    'txn_rules','merchant_map','recurring_items',
    'recaps','subscription_reviews',
    'budgets','budget_lines','net_worth_snapshots','saved_reports',
    'goals','goal_links','goal_contributions','goal_costs',
    'agent_config','si_entries','si_imports',
    'circuit_breaker_events','worker_heartbeats'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated
         using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- audit_log: append-only. Owner can read and insert; no update/delete policies
-- exist, and the reject_mutation trigger (schema migration) blocks even the
-- service role from rewriting history.
alter table public.audit_log enable row level security;

create policy audit_select on public.audit_log
  for select to authenticated using (public.is_owner());

create policy audit_insert on public.audit_log
  for insert to authenticated with check (public.is_owner());

revoke update, delete on public.audit_log from anon, authenticated;

-- anon role: no access to anything
revoke all on all tables in schema public from anon;
