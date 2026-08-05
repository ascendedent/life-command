-- =============================================================================
-- Deferred + retryable sync jobs.
--
-- The first sync fires the moment an institution is linked, but Plaid is often
-- still preparing the Item and answers PRODUCT_NOT_READY (HTTP 400). That is a
-- "not yet", not a failure — yet it marked the institution permanently `error`
-- with no retry until the 6-hourly cron. A freshly linked bank could sit there
-- looking broken for hours while nothing was actually wrong.
-- =============================================================================

alter table public.sync_jobs
  add column if not exists run_after timestamptz,
  add column if not exists attempts  int not null default 0;

-- The poller now skips jobs whose backoff has not elapsed.
drop index if exists sync_jobs_pending_idx;
create index sync_jobs_pending_idx
  on public.sync_jobs (run_after nulls first, requested_at)
  where status = 'pending';

comment on column public.sync_jobs.run_after is
  'Earliest time this job may be claimed; null means immediately.';
comment on column public.sync_jobs.attempts is
  'Retry counter for transient Plaid errors (PRODUCT_NOT_READY and friends).';
