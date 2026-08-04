-- Allow UI-triggered agent runs through the same lightweight job queue.
alter table public.sync_jobs drop constraint sync_jobs_type_check;
alter table public.sync_jobs add constraint sync_jobs_type_check
  check (type in ('sync_all', 'sync_item', 'agent_run'));
