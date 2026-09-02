-- =============================================================================
-- Conversations: asking the platform a question instead of reading a page.
--
-- Every LLM surface so far is one-shot and scheduled — the nightly agent, the
-- recap, categorisation. None of them can be asked a follow-up, which is the
-- thing a person actually wants at the moment a number looks wrong: not another
-- report, but "why is that figure what it is".
--
-- Stored rather than held in the browser for the same reason a manual analysis
-- run is stored: a conversation that evaporates on reload is a conversation you
-- stop trusting with anything long.
-- =============================================================================

create table if not exists public.conversations (
  id         uuid primary key default gen_random_uuid(),
  title      text,
  -- Which provider answered. Worth keeping: the same question put to a local
  -- 0.6B model and to Claude gets different answers, and a year from now the
  -- only way to read an old thread fairly is to know which one wrote it.
  provider   text,
  model      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  tokens          int,
  -- What the assistant was shown when it answered. The chat sees balances and
  -- merchants, and an answer whose inputs are unknown cannot be checked later.
  context         jsonb,
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists conversation_messages_conv_idx
  on public.conversation_messages (conversation_id, created_at);
create index if not exists conversations_updated_idx
  on public.conversations (updated_at desc);

create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
drop policy if exists owner_all on public.conversations;
create policy owner_all on public.conversations
  to authenticated using (public.is_owner()) with check (public.is_owner());
drop policy if exists owner_all on public.conversation_messages;
create policy owner_all on public.conversation_messages
  to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.conversation_messages to authenticated;
grant all on public.conversations to service_role;
grant all on public.conversation_messages to service_role;

alter table public.app_settings
  drop constraint if exists app_settings_llm_provider_check;
alter table public.app_settings add constraint app_settings_llm_provider_check
  check (llm_provider in ('claude_code', 'anthropic', 'google', 'openai', 'ollama'));

comment on table public.conversations is
  'Chat threads about the owner''s own finances. The provider and model are
   recorded per thread because the answers are not interchangeable between them.';
