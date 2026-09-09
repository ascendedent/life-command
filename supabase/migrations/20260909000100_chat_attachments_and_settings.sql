-- =============================================================================
-- Files in the chat, and per-surface model settings.
--
-- A finance conversation is often *about* a document — a statement, a receipt,
-- a letter from an issuer. Describing it in prose loses the thing worth asking
-- about, so the chat takes images and PDFs.
--
-- Bytes go to Storage rather than into a column. A base64 PDF in Postgres is
-- carried by every query that touches the row and by every backup of it; the
-- bucket is already archived by `npm run db:backup`, so Storage costs nothing
-- extra to protect and keeps the message rows readable.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

drop policy if exists owner_all_chat_attachments on storage.objects;
create policy owner_all_chat_attachments on storage.objects
  for all to authenticated
  using (bucket_id = 'chat-attachments' and public.is_owner())
  with check (bucket_id = 'chat-attachments' and public.is_owner());

create table if not exists public.conversation_attachments (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid references public.conversation_messages (id) on delete cascade,
  -- Kept when the message is still being written, so an upload that arrives
  -- before the turn is saved is not orphaned.
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kind       text not null check (kind in ('image', 'pdf')),
  media_type text not null,
  name       text,
  bytes      int not null,
  -- Path within the chat-attachments bucket.
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists conversation_attachments_message_idx
  on public.conversation_attachments (message_id);
create index if not exists conversation_attachments_conv_idx
  on public.conversation_attachments (conversation_id, created_at);

alter table public.conversation_attachments enable row level security;
drop policy if exists owner_all on public.conversation_attachments;
create policy owner_all on public.conversation_attachments
  to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.conversation_attachments to authenticated;
grant all on public.conversation_attachments to service_role;

-- Model and reasoning effort, per surface.
--
-- Separate from the provider columns because the useful settings differ: the
-- chat wants a cheap fast model at low effort for "what did I spend on X",
-- while the recap wants the opposite. A single global model would force one of
-- them to be wrong.
alter table public.app_settings
  add column if not exists llm_chat_model text,
  add column if not exists llm_chat_effort text,
  add column if not exists llm_chat_thinking text;

alter table public.app_settings drop constraint if exists app_settings_llm_chat_effort_check;
alter table public.app_settings add constraint app_settings_llm_chat_effort_check
  check (llm_chat_effort is null
         or llm_chat_effort in ('low', 'medium', 'high', 'xhigh', 'max'));

alter table public.app_settings drop constraint if exists app_settings_llm_chat_thinking_check;
alter table public.app_settings add constraint app_settings_llm_chat_thinking_check
  check (llm_chat_thinking is null or llm_chat_thinking in ('adaptive', 'off'));

comment on column public.app_settings.llm_chat_effort is
  'Reasoning effort for the chat: low..max. Not every model accepts every level
   — effort errors outright on Haiku 4.5 — so it is clamped per model before a
   request is built rather than sent and hoped for.';
