-- Journaling + life-gamification.
-- journal_entries: one brain-dump (voice or typed). GPT enriches it with a
-- summary, mood, sentiment, topics, and per-category stat points that feed XP.
-- goals: long-term targets the assistant tracks against journal mentions.

create extension if not exists vector;

create table if not exists journal_entries (
  id            uuid primary key default gen_random_uuid(),
  raw_text      text not null,                 -- what the user said/typed, verbatim
  summary       text,                          -- 1-2 line GPT summary
  mood          text,                          -- short label e.g. "energized", "drained"
  sentiment     real,                          -- -1 (negative) .. 1 (positive)
  topics        text[] not null default '{}',
  stats         jsonb  not null default '{}',  -- {"health":2,"focus":1,...}
  xp            int    not null default 0,
  embedding     vector(1536),
  created_at    timestamptz not null default now()
);

create index if not exists journal_created_idx on journal_entries (created_at desc);
create index if not exists journal_embedding_idx
  on journal_entries using hnsw (embedding vector_cosine_ops);

create table if not exists goals (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  cadence       text,                          -- "daily" | "weekly" | "monthly" | null
  target        int,                           -- optional numeric target
  progress      int  not null default 0,
  status        text not null default 'active',-- active | done | archived
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists goals_status_idx on goals (status);

-- Semantic search over journal entries (mirrors match_items).
create or replace function match_journal(
  query_embedding vector(1536),
  match_count int default 20,
  match_threshold float default 0.2
) returns setof journal_entries
language sql stable as $$
  select j.*
  from journal_entries j
  where j.embedding is not null
    and 1 - (j.embedding <=> query_embedding) > match_threshold
  order by j.embedding <=> query_embedding
  limit match_count;
$$;
