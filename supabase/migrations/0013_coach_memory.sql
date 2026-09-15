-- Coach long-term memory ("backlog"): durable facts the coach should remember
-- across sessions — people, preferences, decisions, situations, wins, patterns.
-- Distinct from journal_memories (which is the journal AI's memory) so the two
-- can be tuned/cleared independently.
--
-- coach_memory: one row per remembered fact.

create table if not exists coach_memory (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'fact',   -- fact | person | preference | decision | win | pattern | goal_note
  text       text not null,
  category   text,                           -- optional life area / topic
  source     text,                           -- 'chat' | 'checkin' | 'reflection' | 'manual'
  pinned     boolean not null default false, -- always include in context, never prune
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_memory_created_idx on coach_memory (created_at desc);
create index if not exists coach_memory_kind_idx on coach_memory (kind);
