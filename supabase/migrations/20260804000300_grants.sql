-- =============================================================================
-- Explicit table grants. This PG17 image's default privileges do not include
-- DML for authenticated/service_role, so grant it deliberately:
--   service_role  -> workers/scripts (bypasses RLS)
--   authenticated -> the owner's browser session (RLS enforces ownership)
--   anon          -> nothing at all
-- =============================================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete
  on all tables in schema public to authenticated, service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;

grant execute on all functions in schema public to authenticated, service_role;

-- Future tables inherit the same grants (migrations run as postgres).
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;

-- Re-assert lockdowns on top of the blanket grant:

-- audit_log stays append-only for the browser role (the reject_mutation
-- trigger additionally blocks service_role rewrites).
revoke update, delete on public.audit_log from authenticated;

-- anon gets nothing.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke usage on schema public from anon;
