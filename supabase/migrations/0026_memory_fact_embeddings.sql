-- Retrieval for memory (M1): facts become findable by MEANING, not by recency.
--
-- WHY THIS EXISTS. The coach prompt carried every fact it had — 8,470 characters
-- of memory inside a 16,870-character context — while the prose memory store was
-- read as an arbitrary "newest 60" window. So memory was simultaneously too big
-- and silently incomplete: fact number 61 back was invisible forever, and the
-- facts that were visible were visible because they existed, not because the
-- conversation needed them.
--
-- Mirrors items (0001): same model (text-embedding-3-small, 1536 dims), same
-- cosine index. It differs from match_items in one deliberate way: it returns an
-- EXPLICIT column list. `returns setof memory_facts` would ship 1536 floats per
-- row back to the app (40 rows ≈ 1.2 MB of JSON) to be thrown away immediately.
--
-- Additive + idempotent: safe to re-run.

alter table memory_facts add column if not exists embedding vector(1536);

create index if not exists memory_facts_embedding_idx
  on memory_facts using hnsw (embedding vector_cosine_ops);

-- Cosine-similarity search over ACTIVE facts, with the topic's key and value and
-- the similarity it scored, so the caller can rank and group.
--
-- match_threshold is a floor (1 = identical, 0 = unrelated). 0.15 is deliberately
-- permissive: the caller caps the result by budget and per-topic count anyway,
-- and a missed fact costs more than an extra line.
create or replace function match_memory_facts(
  query_embedding vector(1536),
  match_count int default 40,
  match_threshold float default 0.15
) returns table (
  id uuid,
  topic_id uuid,
  key text,
  value text,
  pinned boolean,
  source text,
  updated_at timestamptz,
  similarity float
)
language sql stable as $$
  select f.id,
         f.topic_id,
         f.key,
         f.value,
         f.pinned,
         f.source,
         f.updated_at,
         1 - (f.embedding <=> query_embedding) as similarity
  from memory_facts f
  where f.status = 'active'
    and f.embedding is not null
    and 1 - (f.embedding <=> query_embedding) > match_threshold
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
