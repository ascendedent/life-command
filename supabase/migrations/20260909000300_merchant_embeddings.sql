-- =============================================================================
-- Semantic merchant recall.
--
-- Substring search needs the name. "That garden place", "the mattress people",
-- "wherever I bought the storage boxes" are how people actually remember a
-- purchase, and `ilike '%garden%'` answers none of them.
--
-- Deliberately merchants, not transactions. There are 785 distinct merchants
-- against 3,099 transactions, and every transaction from one merchant would
-- embed to the same point anyway — indexing them individually would be four
-- times the work, four times the storage, and no better an answer.
--
-- This is a recall feature, not a cost saving. The token cost of the chat was
-- already solved by querying instead of carrying history (132k tokens per turn
-- down to about two); embeddings do not shrink what is left. They answer
-- questions SQL cannot express.
-- =============================================================================

create extension if not exists vector;

create table if not exists public.merchant_embeddings (
  -- The merchant as it appears on a transaction: merchant_clean where the
  -- pipeline has produced one, the raw descriptor otherwise.
  merchant    text primary key,
  -- nomic-embed-text, running locally through Ollama: no account, no API key,
  -- no third party seeing a list of everywhere the owner shops.
  embedding   vector(768) not null,
  model       text not null default 'nomic-embed-text',
  -- What the embedding was built from, so a change of input is detectable
  -- without re-embedding to compare.
  source_text text not null,
  txn_count   int not null default 0,
  updated_at  timestamptz not null default now()
);

-- Cosine distance, because these are direction-only comparisons — magnitude
-- carries no meaning for a name. Lists sized for hundreds of rows, not millions.
create index if not exists merchant_embeddings_vec_idx
  on public.merchant_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 32);

alter table public.merchant_embeddings enable row level security;
drop policy if exists owner_all on public.merchant_embeddings;
create policy owner_all on public.merchant_embeddings
  to authenticated using (public.is_owner()) with check (public.is_owner());
grant select, insert, update, delete on public.merchant_embeddings to authenticated;
grant all on public.merchant_embeddings to service_role;

/**
 * Nearest merchants to a query vector.
 *
 * A function rather than a client-side query because PostgREST cannot express
 * a vector distance operator, and because keeping the ranking in the database
 * means the whole table never crosses the wire to be sorted in JavaScript.
 */
create or replace function public.match_merchants(
  query_embedding vector(768),
  match_count int default 10,
  min_similarity float default 0.5
)
returns table (merchant text, similarity float, txn_count int)
language sql stable security invoker
as $$
  select m.merchant,
         1 - (m.embedding <=> query_embedding) as similarity,
         m.txn_count
    from public.merchant_embeddings m
   where 1 - (m.embedding <=> query_embedding) >= min_similarity
   order by m.embedding <=> query_embedding
   limit match_count;
$$;

comment on function public.match_merchants is
  'Semantic merchant lookup. security invoker so RLS applies to the caller
   exactly as it does to a normal select.';
