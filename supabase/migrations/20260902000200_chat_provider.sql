-- =============================================================================
-- The chat and the workers do not have to use the same model.
--
-- They cannot, in fact. `claude_code` runs on the Claude Code login already on
-- the machine — no API key, no metered billing — which is exactly what a chat
-- surface wants. But the Agent SDK exposes no schema-enforced output, and every
-- worker depends on one: the agent's recommendations, the recap's scores,
-- categorisation, receipt parsing. Point a single setting at claude_code to get
-- free chat and the nightly agent stops producing anything.
--
-- So chat gets its own provider, falling back to the shared one when unset.
-- =============================================================================

alter table public.app_settings
  add column if not exists llm_chat_provider text,
  add column if not exists llm_chat_auth text;

alter table public.app_settings drop constraint if exists app_settings_llm_chat_provider_check;
alter table public.app_settings add constraint app_settings_llm_chat_provider_check
  check (llm_chat_provider is null
         or llm_chat_provider in ('claude_code', 'anthropic', 'google', 'openai', 'ollama'));

alter table public.app_settings drop constraint if exists app_settings_llm_chat_auth_check;
alter table public.app_settings add constraint app_settings_llm_chat_auth_check
  check (llm_chat_auth is null or llm_chat_auth in ('api_key', 'oauth', 'none'));

comment on column public.app_settings.llm_chat_provider is
  'Provider for the chat surface only. NULL falls back to llm_provider. Exists
   because claude_code is chat-capable and schema-incapable, so the two surfaces
   genuinely need different answers.';
