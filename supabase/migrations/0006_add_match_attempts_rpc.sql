create or replace function match_attempts(
  query_embedding vector(1536),
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
