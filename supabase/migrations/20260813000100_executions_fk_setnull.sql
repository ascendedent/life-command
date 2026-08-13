-- =============================================================================
-- Let a recommendation be deleted without wedging the database.
--
-- `executions.recommendation_id` is declared `on delete set null`, which says
-- plainly: you may delete a recommendation, and the execution record outlives
-- it. It could not. The append-only trigger fires `before update` and refuses
-- everything, so the foreign key's own referential action was rejected and the
-- delete failed with "executions is append-only" — an error about a table the
-- caller never touched, for an operation the schema advertises as legal.
--
-- Nothing in the app deletes recommendations, so this stayed invisible until a
-- verification harness tried to clean up after itself and could not.
--
-- The fix is narrow on purpose. Append-only is worth having as an absolute, so
-- the exception is not "updates are sometimes allowed" but exactly one shape:
-- clearing the recommendation link, changing nothing else, which is the only
-- update the foreign key can generate. Every field that records what happened
-- stays immutable, and `request` already carries the recommendation's summary,
-- so the trail survives the link being cut.
-- =============================================================================

create or replace function public.executions_append_only()
returns trigger language plpgsql as $$
declare
  unlinked public.executions%rowtype;
begin
  if tg_op = 'UPDATE' then
    unlinked := old;
    unlinked.recommendation_id := null;
    -- The foreign key's ON DELETE SET NULL, and nothing that looks like it.
    if old.recommendation_id is not null
       and new.recommendation_id is null
       and new is not distinct from unlinked then
      return new;
    end if;
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;

drop trigger if exists executions_append_only on public.executions;
create trigger executions_append_only
  before update or delete on public.executions
  for each row execute function public.executions_append_only();

comment on function public.executions_append_only is
  'Append-only guard for executions, with one exception: the foreign key''s own
   ON DELETE SET NULL when a recommendation is deleted. Any other update, and
   every delete, is refused.';
