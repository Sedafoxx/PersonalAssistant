-- Semantic search for items via pgvector + OpenAI embeddings.
-- Embedding model: text-embedding-3-small (1536 dims).

create extension if not exists vector;

alter table items add column if not exists embedding vector(1536);

create index if not exists items_embedding_idx
  on items using hnsw (embedding vector_cosine_ops);

-- Cosine-similarity search. Returns whole item rows ordered by closeness.
-- match_threshold: cosine similarity floor (1 = identical, 0 = unrelated).
create or replace function match_items(
  query_embedding vector(1536),
  match_count int default 20,
  match_threshold float default 0.2,
  filter_type text default null
) returns setof items
language sql stable as $$
  select i.*
  from items i
  where i.status <> 'archived'
    and (filter_type is null or i.type = filter_type)
    and i.embedding is not null
    and 1 - (i.embedding <=> query_embedding) > match_threshold
  order by i.embedding <=> query_embedding
  limit match_count;
$$;
