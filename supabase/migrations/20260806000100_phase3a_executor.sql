-- =============================================================================
-- Phase 3a: human-approved paper execution.
--
-- Every execution attempt is recorded, including the ones the guardrails
-- refuse. A rejection is the more interesting record of the two: it is the
-- evidence that the limits hold, and the acceptance criterion for this phase is
-- thirty days with zero guardrail violations — which cannot be checked against
-- a table that only stores successes.
-- =============================================================================

create table if not exists public.executions (
  id                uuid primary key default gen_random_uuid(),
  recommendation_id uuid references public.recommendations(id) on delete set null,
  broker            text not null,
  mode              text not null default 'paper',
  action            text not null,
  -- What was asked for, exactly as the executor read it.
  request           jsonb not null default '{}'::jsonb,
  -- allowed | rejected | submitted | filled | failed
  outcome           text not null,
  -- Every guardrail that refused it, in the order they were checked.
  violations        text[] not null default '{}',
  broker_order_id   text,
  response          jsonb,
  error             text,
  created_at        timestamptz not null default now(),
  constraint executions_mode_check check (mode in ('paper', 'live')),
  constraint executions_outcome_check
    check (outcome in ('rejected', 'submitted', 'filled', 'failed'))
);

create index if not exists executions_created_idx on public.executions (created_at desc);
create index if not exists executions_recommendation_idx on public.executions (recommendation_id);
create index if not exists executions_outcome_idx on public.executions (outcome);

alter table public.executions enable row level security;
drop policy if exists owner_all on public.executions;
create policy owner_all on public.executions
  to authenticated using (public.is_owner()) with check (public.is_owner());

grant select, insert, update, delete on public.executions to authenticated;
grant all on public.executions to service_role;

-- Executions are a record of what happened; nothing may rewrite one.
drop trigger if exists executions_append_only on public.executions;
create trigger executions_append_only
  before update or delete on public.executions
  for each row execute function public.reject_mutation();

-- Paper until deliberately switched. The spec requires a minimum of 30 days in
-- paper mode before live is even considered, so the default must not be live.
alter table public.agent_config
  add column if not exists execution_mode text not null default 'paper';

alter table public.agent_config
  drop constraint if exists agent_config_execution_mode_check;
alter table public.agent_config
  add constraint agent_config_execution_mode_check
  check (execution_mode in ('paper', 'live'));

comment on column public.agent_config.execution_mode is
  'paper or live. Guardrails are identical in both; this only selects which
   broker endpoint the executor talks to. Live requires the owner to change it
   by hand, and the spec gates that on 30 days of clean paper trading.';

comment on table public.executions is
  'Every execution attempt the executor made, successful or refused. Append-only
   — the audit trail of a system that moves money must not be editable by the
   thing that writes it.';
