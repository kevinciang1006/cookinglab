-- Vector search over saved recipes, mirroring match_attempts — used to
-- check "is there already a saved recipe for this dish?" before falling
-- back to reconstructing an answer from attempt notes.
create index recipes_embedding_idx
  on recipes using hnsw (embedding vector_cosine_ops);

create function match_recipes(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  id uuid,
  dish text,
  variation_label text,
  ingredients jsonb,
  steps jsonb,
  summary text,
  source_answer text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
language sql stable
as $$
  select
    r.id,
    r.dish,
    r.variation_label,
    r.ingredients,
    r.steps,
    r.summary,
    r.source_answer,
    r.created_at,
    r.updated_at,
    1 - (r.embedding <=> query_embedding) as similarity
  from recipes r
  where r.embedding is not null
  order by r.embedding <=> query_embedding
  limit match_count;
$$;
