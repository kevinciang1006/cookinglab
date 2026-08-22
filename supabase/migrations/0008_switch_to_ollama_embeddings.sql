-- Ollama migration: embeddings move from Gemini's gemini-embedding-001
-- (reduced to 1536 dims) to nomic-embed-text's native 768 dims. Existing
-- 1536-dim vectors are the wrong shape for the new model, so they're
-- nulled out here; scripts/backfill-embeddings.ts re-embeds every row via
-- Ollama afterward.
drop index if exists attempts_embedding_idx;

drop function if exists match_attempts(vector(1536), int);

update attempts set embedding = null;

alter table attempts
  alter column embedding type vector(768);

create index attempts_embedding_idx
  on attempts using hnsw (embedding vector_cosine_ops);

create function match_attempts(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  id uuid,
  dish text,
  changes text,
  outcome text,
  analysis text,
  rating int,
  cooked_at date,
  target text,
  similarity float
)
language sql stable
as $$
  select
    a.id,
    a.dish,
    a.changes,
    a.outcome,
    a.analysis,
    a.rating,
    a.cooked_at,
    a.target,
    1 - (a.embedding <=> query_embedding) as similarity
  from attempts a
  where a.embedding is not null
  order by a.embedding <=> query_embedding
  limit match_count;
$$;
