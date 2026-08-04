-- =============================================================================
-- Phase 2: goal contribution matching, plus the job types the remaining Phase 2
-- workers dispatch through the existing lightweight queue.
-- =============================================================================

alter table public.sync_jobs drop constraint sync_jobs_type_check;
alter table public.sync_jobs add constraint sync_jobs_type_check
  check (type in (
    'sync_all', 'sync_item', 'agent_run',
    'goal_match',      -- re-match contributions after a goal or its links change
    'enrich',          -- LLM categorization + business suggestion pass
    'recap_weekly',
    'recap_monthly'
  ));

-- The matcher runs repeatedly over the same history; one transaction may only
-- ever count once per goal.
create unique index if not exists goal_contributions_unique_txn
  on public.goal_contributions (goal_id, transaction_id)
  where transaction_id is not null;

-- Provenance so the UI can show why a contribution counted, and so a manual
-- attach is never clobbered by the auto-matcher.
alter table public.goal_contributions
  add column if not exists source text not null default 'auto'
    check (source in ('auto', 'manual')),
  add column if not exists via text;

-- goal_links: the same entity should not be linked twice in the same role.
create unique index if not exists goal_links_unique_entity
  on public.goal_links (goal_id, entity_type, entity_id, role);
