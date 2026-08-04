-- =============================================================================
-- Personal AI Finance Platform — initial schema (spec §4)
-- Single-user app: all rows belong to the one allow-listed owner (see RLS
-- migration). Workers connect with the service role.
-- =============================================================================

-- ---------- owner allow-list -------------------------------------------------

create table public.app_owner (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- shared trigger helpers ------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.reject_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

-- ---------- institutions & accounts ------------------------------------------

create table public.institutions (
  id            uuid primary key default gen_random_uuid(),
  plaid_item_id text unique,
  name          text not null,
  status        text not null default 'ok',
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table public.accounts (
  id                  uuid primary key default gen_random_uuid(),
  institution_id      uuid references public.institutions (id) on delete cascade,
  plaid_account_id    text unique,
  name                text not null,
  type                text not null,   -- checking/savings/credit/investment/loan
  subtype             text,
  mask                text,
  current_balance     numeric(14,2),
  available_balance   numeric(14,2),
  is_agent_controlled boolean not null default false,  -- the capped sub-account flag
  is_business         boolean not null default false,  -- every txn auto-tags business
  business_entity     text,                            -- e.g. 'Acme Studios'
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger accounts_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

-- ---------- categorization (Monarch parity layer) ----------------------------

create table public.category_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null check (type in ('income','expense','transfer')),
  budget_mode text not null default 'by_category'
              check (budget_mode in ('by_category','by_group')),
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

create table public.categories (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null references public.category_groups (id) on delete cascade,
  name                text not null,
  emoji               text,
  is_system           boolean not null default false,
  is_active           boolean not null default true,
  is_rollover         boolean not null default false,  -- unspent budget carries forward
  exclude_from_budget boolean not null default false,
  sort_order          int not null default 0
);

create table public.tags (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique,
  color text
);

-- ---------- transactions ------------------------------------------------------

create table public.transactions (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null references public.accounts (id) on delete cascade,
  plaid_txn_id           text unique,
  date                   date not null,
  amount                 numeric(14,2) not null,
  merchant               text,
  merchant_clean         text,
  category_id            uuid references public.categories (id) on delete set null,
  category_source        text check (category_source in ('plaid','rule','merchant_map','llm','user')),
  plaid_category_primary text,   -- raw PFC v2 baseline, kept for audit
  plaid_category_detail  text,
  pending                boolean not null default false,
  hidden                 boolean not null default false,  -- excluded from budget/cash flow
  needs_review           boolean not null default false,
  reviewed_at            timestamptz,
  notes                  text,
  item_lines             jsonb,   -- optional receipt item-level breakdown
  is_business            boolean not null default false,
  business_source        text check (business_source in ('account_default','suggested_accepted','user')),
  business_entity        text,
  receipt_status         text check (receipt_status in ('requested','uploaded','waived')),
  raw                    jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

create index transactions_account_date_idx on public.transactions (account_id, date desc);
create index transactions_date_idx         on public.transactions (date desc);
create index transactions_category_idx     on public.transactions (category_id);
create index transactions_needs_review_idx on public.transactions (needs_review) where needs_review;
create index transactions_business_idx     on public.transactions (is_business) where is_business;

create table public.transaction_tags (
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  tag_id         uuid not null references public.tags (id) on delete cascade,
  primary key (transaction_id, tag_id)
);

create table public.receipts (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  file_ref       text not null,   -- Supabase Storage (local stack) path
  uploaded_at    timestamptz not null default now(),
  source         text not null check (source in ('ui_upload','drop_folder','email_aldyn','gmail')),
  parsed         jsonb            -- optional OCR/LLM extraction
);

-- ---------- agent run bookkeeping (needed early for FKs) ----------------------

create table public.agent_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  trigger        text,   -- 'cron' / 'manual' / 'recap_weekly' / 'recap_monthly'
  input_snapshot jsonb,
  model          text,
  tokens_used    int,
  status         text not null default 'running',
  error          text
);

create table public.recommendations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  run_id      uuid references public.agent_runs (id) on delete set null,
  type        text not null check (type in ('transfer','trade','prediction_position','alert','rebalance')),
  summary     text not null,
  rationale   text,
  payload     jsonb,   -- structured action: from, to, amount, symbol, side, qty, limits
  confidence  numeric,
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected','executed','failed','expired')),
  expires_at  timestamptz,
  reviewed_at timestamptz,
  executed_at timestamptz,
  result      jsonb
);

create index recommendations_status_idx  on public.recommendations (status);
create index recommendations_created_idx on public.recommendations (created_at desc);

-- ---------- email receipts, anticipation, vendor memory (spec §1.7) -----------

create table public.email_receipts (
  id                     uuid primary key default gen_random_uuid(),
  source                 text not null check (source in ('aldyn_api','gmail')),
  external_id            text not null,  -- dedupe key
  email_ref              text,           -- deep link back into Aldyn
  sender_domain          text,
  sender_verified        boolean not null default false,  -- DKIM/SPF + vendor-domain gate
  card_last4             text,
  received_at            timestamptz,
  vendor                 text,
  total                  numeric(14,2),
  currency               text not null default 'USD',
  txn_date_guess         date,
  aldyn_category         text,
  line_items             jsonb,
  attachment_ref         text,
  match_status           text not null default 'unmatched'
                         check (match_status in ('unmatched','auto_matched','ambiguous','resolved','ignored','archived')),
  matched_transaction_id uuid references public.transactions (id) on delete set null,
  resolved_at            timestamptz,
  created_at             timestamptz not null default now(),
  unique (source, external_id)
);

create index email_receipts_match_status_idx on public.email_receipts (match_status);

create table public.vendor_signatures (
  id                  uuid primary key default gen_random_uuid(),
  vendor_name         text not null unique,     -- as seen on receipts
  descriptor_patterns text[] not null default '{}',  -- observed bank descriptors
  name_aliases        text[] not null default '{}',  -- confirmed "X is Y" answers
  exact_match_count   int not null default 0,
  mismatch_count      int not null default 0,
  reliability         numeric,
  source              text not null default 'auto'
                      check (source in ('auto','user_confirmed','user_prefilled')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger vendor_signatures_updated_at
  before update on public.vendor_signatures
  for each row execute function public.set_updated_at();

create table public.anticipated_transactions (
  id                          uuid primary key default gen_random_uuid(),
  email_receipt_id            uuid references public.email_receipts (id) on delete set null,
  created_at                  timestamptz not null default now(),
  vendor                      text not null,
  amount                      numeric(14,2) not null,
  currency                    text not null default 'USD',
  expected_descriptor_patterns text[] not null default '{}',
  card_last4                  text,
  account_id                  uuid references public.accounts (id) on delete set null,
  category_id                 uuid references public.categories (id) on delete set null,
  is_business                 boolean not null default false,
  business_entity             text,
  item_lines                  jsonb,
  verification_state          text check (verification_state in
                              ('known_vendor','unverified_vendor','user_approved','user_prefilled')),
  status                      text not null default 'open'
                              check (status in ('open','reconciled','expired_review','dismissed','quarantined')),
  reconciliation_confidence   numeric,
  reconciliation_factors      jsonb,
  reconciled_transaction_id   uuid references public.transactions (id) on delete set null,
  reconciled_at               timestamptz,
  expires_at                  timestamptz   -- 14 days; expiry = refund/cancel/fraud signal
);

create index anticipated_txns_status_idx  on public.anticipated_transactions (status);
create index anticipated_txns_expires_idx on public.anticipated_transactions (expires_at)
  where status = 'open';

create table public.notification_rules (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('spend_threshold','vendor_match','account_activity')),
  min_amount     numeric(14,2),
  vendor_pattern text,
  account_id     uuid references public.accounts (id) on delete cascade,
  channel        text not null default 'email' check (channel in ('email','ntfy')),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);

create table public.notifications_log (
  id                         uuid primary key default gen_random_uuid(),
  rule_id                    uuid references public.notification_rules (id) on delete set null,
  anticipated_transaction_id uuid references public.anticipated_transactions (id) on delete set null,
  transaction_id             uuid references public.transactions (id) on delete set null,
  sent_at                    timestamptz not null default now(),
  channel                    text,
  content                    text
);

create index notifications_log_sent_idx on public.notifications_log (sent_at desc);

create table public.vendor_watchlist (
  id                  uuid primary key default gen_random_uuid(),
  vendor_name         text not null,
  vendor_signature_id uuid references public.vendor_signatures (id) on delete set null,
  flag_type           text not null check (flag_type in ('fraud','cancelled')),
  reason              text,
  cancelled_on        date,
  source              text not null default 'user'
                      check (source in ('user','subscription_review_cut','expired_anticipation')),
  is_active           boolean not null default true,
  flagged_at          timestamptz not null default now(),
  resolved_at         timestamptz
);

create table public.watchlist_hits (
  id                         uuid primary key default gen_random_uuid(),
  watchlist_id               uuid not null references public.vendor_watchlist (id) on delete cascade,
  detected_at                timestamptz not null default now(),
  ingress                    text not null check (ingress in
                             ('email_receipt','anticipation','plaid_sync','recurring_detect')),
  anticipated_transaction_id uuid references public.anticipated_transactions (id) on delete set null,
  transaction_id             uuid references public.transactions (id) on delete set null,
  email_receipt_id           uuid references public.email_receipts (id) on delete set null,
  amount                     numeric(14,2),
  alerted_at                 timestamptz,
  recommendation_id          uuid references public.recommendations (id) on delete set null,
  resolution                 text check (resolution in ('disputed','refunded','false_positive','accepted')),
  resolved_at                timestamptz
);

create index watchlist_hits_detected_idx on public.watchlist_hits (detected_at desc);

create table public.business_suggestions (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  created_at     timestamptz not null default now(),
  run_id         uuid references public.agent_runs (id) on delete set null,
  confidence     numeric,
  rationale      text,
  status         text not null default 'pending' check (status in ('pending','accepted','dismissed'))
);

-- ---------- holdings & liabilities --------------------------------------------

create table public.holdings (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts (id) on delete cascade,
  symbol       text not null,
  quantity     numeric,
  cost_basis   numeric(14,2),
  market_value numeric(14,2),
  as_of        timestamptz not null default now()
);

create index holdings_account_idx on public.holdings (account_id);

create table public.liabilities (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts (id) on delete cascade,
  type            text,
  apr             numeric(7,4),
  minimum_payment numeric(14,2),
  next_due_date   date,
  balance         numeric(14,2),
  updated_at      timestamptz not null default now()
);

create trigger liabilities_updated_at
  before update on public.liabilities
  for each row execute function public.set_updated_at();

-- ---------- rules, merchant map, recurring ------------------------------------

create table public.txn_rules (
  id          uuid primary key default gen_random_uuid(),
  priority    int not null,   -- first match wins, retroactive apply supported
  criteria    jsonb not null, -- merchant pattern, amount range, account, category
  actions     jsonb not null, -- set_category, rename, add_tags, hide, needs_review, link_goal
  is_active   boolean not null default true,
  hit_count   int not null default 0,
  last_hit_at timestamptz,
  created_at  timestamptz not null default now()
);

create index txn_rules_priority_idx on public.txn_rules (priority) where is_active;

create table public.merchant_map (
  id                  uuid primary key default gen_random_uuid(),
  raw_pattern         text not null unique,
  clean_name          text,
  default_category_id uuid references public.categories (id) on delete set null,
  confidence          numeric,
  source              text not null default 'user' check (source in ('user','rule','llm')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger merchant_map_updated_at
  before update on public.merchant_map
  for each row execute function public.set_updated_at();

create table public.recurring_items (
  id                   uuid primary key default gen_random_uuid(),
  merchant             text not null,
  category_id          uuid references public.categories (id) on delete set null,
  cadence              text check (cadence in ('weekly','monthly','annual','custom')),
  expected_amount      numeric(14,2),
  amount_tolerance_pct numeric,
  next_expected_date   date,
  account_id           uuid references public.accounts (id) on delete set null,
  is_subscription      boolean not null default false,
  status               text not null default 'active'
                       check (status in ('active','price_changed','missed','cancelled')),
  purpose              text,      -- user-written: what this subscription accomplishes
  value_notes          text,      -- user-written: why it's worth it / doubts / usage
  overlap_tags         text[] not null default '{}',  -- capability tags for overlap detection
  last_reviewed_at     timestamptz,
  last_seen_txn_id     uuid references public.transactions (id) on delete set null,
  created_at           timestamptz not null default now()
);

create index recurring_items_status_idx on public.recurring_items (status);

-- ---------- recaps & subscription reviews -------------------------------------

create table public.recaps (
  id                uuid primary key default gen_random_uuid(),
  period_type       text not null check (period_type in ('weekly','monthly')),
  period_start      date not null,
  period_end        date not null,
  run_id            uuid references public.agent_runs (id) on delete set null,
  scores            jsonb,   -- per-domain 0-100
  overall_score     numeric,
  goal_cost_summary jsonb,   -- per-goal: contributed, true cost, net efficiency
  adjustments       jsonb,   -- recommended changes, linkable to recommendation rows
  content_md        text,
  created_at        timestamptz not null default now(),
  unique (period_type, period_start)
);

create table public.subscription_reviews (
  id                        uuid primary key default gen_random_uuid(),
  recap_id                  uuid references public.recaps (id) on delete cascade,
  recurring_item_id         uuid not null references public.recurring_items (id) on delete cascade,
  created_at                timestamptz not null default now(),
  verdict                   text check (verdict in ('keep','replace','cut','watch')),
  reasoning                 text,
  suggested_alternative     text,
  projected_monthly_savings numeric(14,2),  -- from actual observed prices (Stage 1)
  user_decision             text check (user_decision in ('accepted','rejected','deferred')),
  decided_at                timestamptz
);

-- ---------- budgets ------------------------------------------------------------

create table public.budgets (
  id         uuid primary key default gen_random_uuid(),
  month      date not null unique,   -- first of month
  style      text not null check (style in ('category','flex')),
  created_at timestamptz not null default now()
);

create table public.budget_lines (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,  -- null when flex bucket line
  flex_bucket text check (flex_bucket in ('fixed','flexible','non_monthly')),
  amount      numeric(14,2) not null default 0,
  rollover_in numeric(14,2) not null default 0,
  spent_cached numeric(14,2) not null default 0,
  check (category_id is not null or flex_bucket is not null)
);

create table public.net_worth_snapshots (
  id              uuid primary key default gen_random_uuid(),
  date            date not null unique,
  total           numeric(14,2) not null,
  by_account_type jsonb,
  created_at      timestamptz not null default now()
);

create table public.saved_reports (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  config     jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- goals + semantic linkage (powers recap cost attribution) -----------

create table public.goals (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  type               text not null check (type in
                     ('emergency_fund','debt_payoff','savings_target','investment_target','custom')),
  target_amount      numeric(14,2),
  current_amount     numeric(14,2) not null default 0,
  target_date        date,
  cadence_amount     numeric(14,2),  -- e.g. "save 800/month" style goals
  cadence            text,
  priority           int not null default 0,
  funding_account_id uuid references public.accounts (id) on delete set null,
  status             text not null default 'active',
  created_at         timestamptz not null default now()
);

create table public.goal_links (
  id          uuid primary key default gen_random_uuid(),
  goal_id     uuid not null references public.goals (id) on delete cascade,
  entity_type text not null check (entity_type in
              ('account','category','tag','liability','recurring_item')),
  entity_id   uuid not null,
  role        text not null check (role in
              ('funding','contribution_source','cost_driver','constraint')),
  notes       text,
  created_at  timestamptz not null default now()
);

create index goal_links_goal_idx on public.goal_links (goal_id);

create table public.goal_contributions (
  id             uuid primary key default gen_random_uuid(),
  goal_id        uuid not null references public.goals (id) on delete cascade,
  transaction_id uuid references public.transactions (id) on delete set null,
  amount         numeric(14,2) not null,
  occurred_at    timestamptz not null default now()
);

create index goal_contributions_goal_idx on public.goal_contributions (goal_id);

create table public.goal_costs (
  id                   uuid primary key default gen_random_uuid(),
  goal_id              uuid not null references public.goals (id) on delete cascade,
  period_start         date,
  period_end           date,
  run_id               uuid references public.agent_runs (id) on delete set null,
  cost_type            text not null check (cost_type in
                       ('interest_accrued','fee','penalty','missed_discount','opportunity')),
  amount               numeric(14,2) not null,
  liability_id         uuid references public.liabilities (id) on delete set null,
  contributing_txn_ids uuid[] not null default '{}',  -- exactly which transactions drove the cost
  computation          jsonb,   -- the math shown (balance carried, APR, days), fully auditable
  narrative            text,
  created_at           timestamptz not null default now()
);

create index goal_costs_goal_idx on public.goal_costs (goal_id);

-- ---------- agent config --------------------------------------------------------

create table public.agent_config (
  id                   int primary key default 1 check (id = 1),  -- single row
  autonomy_level       int not null default 0 check (autonomy_level between 0 and 3),
  max_txn_amount       numeric(14,2) not null default 0,
  max_daily_amount     numeric(14,2) not null default 0,
  max_open_positions   int not null default 0,
  max_position_size    numeric(14,2) not null default 0,
  drawdown_halt_pct    numeric not null default 10,
  allowed_action_types text[] not null default '{}',
  updated_at           timestamptz not null default now()
);

create trigger agent_config_updated_at
  before update on public.agent_config
  for each row execute function public.set_updated_at();

-- start at autonomy 0 (read-only), all caps zero
insert into public.agent_config (id) values (1);

-- ---------- self improvement (loose by design, spec §5.10) ----------------------

create table public.si_entries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  source      text not null default 'manual'
              check (source in ('manual','file_import','sie_agent','api')),
  category    text,      -- free-form, SIE agent's taxonomy
  title       text,
  body        text,
  metrics     jsonb,     -- arbitrary key/value numbers for charting
  tags        text[] not null default '{}',
  payload     jsonb,
  occurred_at timestamptz not null default now()
);

create index si_entries_occurred_idx on public.si_entries (occurred_at desc);

create table public.si_imports (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  filename    text,
  source_path text,
  format      text check (format in ('json','csv','md','txt')),
  row_count   int,
  status      text not null default 'pending',
  error       text,
  raw_ref     text   -- provenance for every import batch
);

-- ---------- safety ---------------------------------------------------------------

create table public.audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     text not null check (actor in ('agent','user','executor','system')),
  action    text not null,
  entity    text,
  entity_id text,
  detail    jsonb
);

create index audit_log_at_idx on public.audit_log (at desc);

-- append-only enforced for every role, including service_role
create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.reject_mutation();

create table public.circuit_breaker_events (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  rule        text not null,
  detail      jsonb,
  resolved_at timestamptz
);

-- ---------- worker health ---------------------------------------------------------

create table public.worker_heartbeats (
  worker_name text primary key,   -- 'sync' / 'agent' / 'executor'
  status      text not null default 'ok',
  last_beat_at timestamptz not null default now(),
  started_at  timestamptz,
  details     jsonb
);

-- ---------- realtime ---------------------------------------------------------------

alter publication supabase_realtime add table
  public.recommendations,
  public.accounts,
  public.worker_heartbeats;
