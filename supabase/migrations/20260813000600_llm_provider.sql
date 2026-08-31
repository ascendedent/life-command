-- =============================================================================
-- Which model answers, and what it is being paid with.
--
-- Four workers each constructed their own Anthropic client, which made an
-- Anthropic API key a hard requirement for running the platform at all. Fine
-- for the owner; wrong for anyone cloning the repo, for whom the cost of trying
-- this should not be a metered bill.
--
-- `llm_auth = 'oauth'` selects the signed-in Anthropic profile (`ant auth
-- login`) over an API key. The distinction has to be stored rather than
-- inferred, because the SDK silently prefers a key when both exist — including
-- an empty one — so "I signed in" and "I have a stale blank key in .env" are
-- indistinguishable to anything that only looks at the environment.
-- =============================================================================

alter table public.app_settings
  add column if not exists llm_provider text not null default 'anthropic',
  add column if not exists llm_auth text not null default 'api_key';

alter table public.app_settings drop constraint if exists app_settings_llm_provider_check;
alter table public.app_settings add constraint app_settings_llm_provider_check
  check (llm_provider in ('anthropic', 'google', 'openai', 'ollama'));

alter table public.app_settings drop constraint if exists app_settings_llm_auth_check;
alter table public.app_settings add constraint app_settings_llm_auth_check
  check (llm_auth in ('api_key', 'oauth', 'none'));

comment on column public.app_settings.llm_provider is
  'Who answers: anthropic, google (AI Studio free tier), openai, or ollama
   (local, no account). Every worker reads this — switching provider is a
   settings change, not a rewrite.';

comment on column public.app_settings.llm_auth is
  'api_key reads the provider key from the environment. oauth uses the Anthropic
   profile written by `ant auth login`, and removes ANTHROPIC_API_KEY from the
   worker process so a stale key cannot outrank the login.';
