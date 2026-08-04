-- Multiple email accounts per provider (personal + business inboxes).
alter table public.connections drop constraint connections_provider_key;
alter table public.connections
  add constraint connections_provider_email_key unique (provider, account_email);

-- Which mailbox a receipt came from (display + correct Gmail deep links).
alter table public.email_receipts add column mailbox text;
