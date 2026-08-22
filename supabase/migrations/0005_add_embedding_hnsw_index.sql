create index if not exists attempts_embedding_idx
  on attempts using hnsw (embedding vector_cosine_ops);
