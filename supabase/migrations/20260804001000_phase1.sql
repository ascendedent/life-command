-- =============================================================================
-- Phase 1: Plaid link + sync + categorization foundations
-- =============================================================================

-- ---------- institutions: token storage + sync state --------------------------
-- access_token_enc is AES-256-GCM encrypted at the application layer
-- (packages/shared crypto; key = APP_ENCRYPTION_KEY env). Never stored plain.

alter table public.institutions
  add column plaid_institution_id text,
  add column access_token_enc     text,
  add column transactions_cursor  text,
  add column last_error           text;

-- ---------- transaction splits -------------------------------------------------

alter table public.transactions
  add column parent_transaction_id uuid references public.transactions (id) on delete cascade;

create index transactions_parent_idx on public.transactions (parent_transaction_id)
  where parent_transaction_id is not null;

-- ---------- lightweight job queue (UI-triggered syncs) -------------------------

create table public.sync_jobs (
  id             uuid primary key default gen_random_uuid(),
  type           text not null default 'sync_all' check (type in ('sync_all','sync_item')),
  institution_id uuid references public.institutions (id) on delete cascade,
  status         text not null default 'pending'
                 check (status in ('pending','running','done','error')),
  requested_by   text not null default 'user' check (requested_by in ('user','system')),
  requested_at   timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  error          text
);

create index sync_jobs_pending_idx on public.sync_jobs (requested_at) where status = 'pending';

alter table public.sync_jobs enable row level security;
create policy owner_all on public.sync_jobs
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

alter publication supabase_realtime add table public.sync_jobs;

-- ---------- receipts storage bucket --------------------------------------------

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy receipts_owner_all on storage.objects
  for all to authenticated
  using (bucket_id = 'receipts' and public.is_owner())
  with check (bucket_id = 'receipts' and public.is_owner());

-- ---------- category taxonomy seed (Monarch-style, spec §1.6) -------------------

alter table public.category_groups add constraint category_groups_name_key unique (name);
alter table public.categories add constraint categories_group_name_key unique (group_id, name);

insert into public.category_groups (name, type, sort_order) values
  ('Income', 'income', 0),
  ('Housing', 'expense', 10),
  ('Utilities', 'expense', 20),
  ('Transportation', 'expense', 30),
  ('Food & Drink', 'expense', 40),
  ('Shopping', 'expense', 50),
  ('Health & Wellness', 'expense', 60),
  ('Entertainment', 'expense', 70),
  ('Travel', 'expense', 80),
  ('Family & Personal', 'expense', 90),
  ('Financial', 'expense', 100),
  ('Business', 'expense', 110),
  ('Other', 'expense', 120),
  ('Transfers', 'transfer', 130)
on conflict (name) do nothing;

-- seed categories: (group, name, emoji, is_system, exclude_from_budget, sort)
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      ('Income', 'Paycheck', '💰', false, false, 0),
      ('Income', 'Business Income', '💼', false, false, 1),
      ('Income', 'Interest', '🏦', false, false, 2),
      ('Income', 'Dividends & Capital Gains', '💹', true, false, 3),
      ('Income', 'Refunds & Reimbursements', '↩️', false, false, 4),
      ('Income', 'Other Income', '➕', false, false, 5),

      ('Housing', 'Rent', '🏠', false, false, 0),
      ('Housing', 'Mortgage', '🏦', false, false, 1),
      ('Housing', 'Home Improvement', '🔨', false, false, 2),
      ('Housing', 'Home Services', '🧹', false, false, 3),
      ('Housing', 'Property Tax', '🏛️', false, false, 4),

      ('Utilities', 'Electric', '⚡', false, false, 0),
      ('Utilities', 'Gas & Heating', '🔥', false, false, 1),
      ('Utilities', 'Water', '💧', false, false, 2),
      ('Utilities', 'Internet', '🌐', false, false, 3),
      ('Utilities', 'Mobile Phone', '📱', false, false, 4),
      ('Utilities', 'Trash & Recycling', '🗑️', false, false, 5),

      ('Transportation', 'Auto Payment', '🚗', false, false, 0),
      ('Transportation', 'Gas', '⛽', false, false, 1),
      ('Transportation', 'Auto Maintenance', '🔧', false, false, 2),
      ('Transportation', 'Auto Insurance', '🛡️', false, false, 3),
      ('Transportation', 'Parking & Tolls', '🅿️', false, false, 4),
      ('Transportation', 'Public Transit', '🚇', false, false, 5),
      ('Transportation', 'Rideshare & Taxi', '🚕', false, false, 6),
      ('Transportation', 'Other Transport', '🚙', false, false, 7),

      ('Food & Drink', 'Groceries', '🛒', false, false, 0),
      ('Food & Drink', 'Restaurants', '🍽️', false, false, 1),
      ('Food & Drink', 'Coffee Shops', '☕', false, false, 2),
      ('Food & Drink', 'Delivery & Takeout', '🥡', false, false, 3),
      ('Food & Drink', 'Alcohol & Bars', '🍺', false, false, 4),

      ('Shopping', 'Shopping', '🛍️', false, false, 0),
      ('Shopping', 'Clothing', '👕', false, false, 1),
      ('Shopping', 'Electronics', '💻', false, false, 2),
      ('Shopping', 'Home Goods', '🛋️', false, false, 3),
      ('Shopping', 'Hobbies', '🎨', false, false, 4),
      ('Shopping', 'Books', '📚', false, false, 5),

      ('Health & Wellness', 'Medical', '🏥', false, false, 0),
      ('Health & Wellness', 'Dental', '🦷', false, false, 1),
      ('Health & Wellness', 'Vision', '👓', false, false, 2),
      ('Health & Wellness', 'Pharmacy', '💊', false, false, 3),
      ('Health & Wellness', 'Fitness', '💪', false, false, 4),
      ('Health & Wellness', 'Personal Care', '💇', false, false, 5),

      ('Entertainment', 'Entertainment', '🎬', false, false, 0),
      ('Entertainment', 'Streaming Services', '📺', false, false, 1),
      ('Entertainment', 'Music', '🎵', false, false, 2),
      ('Entertainment', 'Games', '🎮', false, false, 3),
      ('Entertainment', 'Events & Tickets', '🎟️', false, false, 4),

      ('Travel', 'Travel', '✈️', false, false, 0),
      ('Travel', 'Hotels', '🏨', false, false, 1),
      ('Travel', 'Vacation', '🏖️', false, false, 2),

      ('Family & Personal', 'Gifts', '🎁', false, false, 0),
      ('Family & Personal', 'Charity', '❤️', false, false, 1),
      ('Family & Personal', 'Education', '🎓', false, false, 2),
      ('Family & Personal', 'Childcare', '👶', false, false, 3),
      ('Family & Personal', 'Pets', '🐾', false, false, 4),
      ('Family & Personal', 'Subscriptions', '📦', false, false, 5),

      ('Financial', 'Insurance', '🛡️', false, false, 0),
      ('Financial', 'Taxes', '🏛️', false, false, 1),
      ('Financial', 'Bank Fees', '💸', false, false, 2),
      ('Financial', 'Interest Paid', '💳', false, false, 3),
      ('Financial', 'Loan Payment', '📄', false, false, 4),
      ('Financial', 'Legal & Professional', '⚖️', false, false, 5),

      ('Business', 'Business Expense', '💼', false, false, 0),
      ('Business', 'SaaS & Software', '🧩', false, false, 1),
      ('Business', 'Advertising', '📣', false, false, 2),
      ('Business', 'Shipping & Postage', '📦', false, false, 3),
      ('Business', 'Contractors', '👷', false, false, 4),
      ('Business', 'Business Travel', '🧳', false, false, 5),

      ('Other', 'Cash & ATM', '🏧', false, false, 0),
      ('Other', 'Check', '📝', false, false, 1),
      ('Other', 'Miscellaneous', '❓', false, false, 2),
      ('Other', 'Uncategorized', '📥', true, false, 3),

      ('Transfers', 'Transfer', '🔁', true, true, 0),
      ('Transfers', 'Credit Card Payment', '💳', true, true, 1),
      ('Transfers', 'Investment Buy/Sell', '📈', true, true, 2),
      ('Transfers', 'Savings Contribution', '🐖', false, true, 3)
    ) as t(group_name, cat_name, emoji, is_system, exclude_budget, sort)
  loop
    insert into public.categories (group_id, name, emoji, is_system, exclude_from_budget, sort_order)
    select g.id, rec.cat_name, rec.emoji, rec.is_system, rec.exclude_budget, rec.sort
    from public.category_groups g where g.name = rec.group_name
    on conflict (group_id, name) do nothing;
  end loop;
end $$;
