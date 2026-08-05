-- =============================================================================
-- Give a liability a stable identity.
--
-- The sync deleted every liability for an institution and re-inserted them on
-- each run, so each row got a fresh uuid several times a day. `goal_links` is a
-- polymorphic link — (entity_type, entity_id) with no foreign key, because the
-- entity may be an account, a category, a tag, a liability or a recurring item
-- — so nothing enforced or cascaded the change, and nothing complained.
--
-- The effect: a goal linked to a credit card as a cost driver silently stopped
-- accruing cost attribution the next time a sync ran. The recap kept succeeding
-- and simply reported no goal costs, which is the worst shape a bug can take —
-- the flagship interest-attribution feature quietly produced nothing.
--
-- An account has at most one liability record per type, so that is the natural
-- key. With it, sync upserts instead of replacing, and ids survive.
-- =============================================================================

-- Collapse any duplicates the delete/insert cycle may have left behind, keeping
-- the most recently updated row for each (account, type).
delete from public.liabilities l
 where exists (
   select 1 from public.liabilities keep
    where keep.account_id = l.account_id
      and coalesce(keep.type, '') = coalesce(l.type, '')
      and (keep.updated_at, keep.id) > (l.updated_at, l.id)
 );

alter table public.liabilities
  alter column type set default 'credit';

update public.liabilities set type = 'credit' where type is null;

alter table public.liabilities
  alter column type set not null;

create unique index if not exists liabilities_account_type_key
  on public.liabilities (account_id, type);

comment on index public.liabilities_account_type_key is
  'Natural key so sync can upsert. Liability ids are referenced by
   goal_links.entity_id, which has no FK to enforce it — replacing rows on every
   sync silently orphaned every goal cost driver.';
