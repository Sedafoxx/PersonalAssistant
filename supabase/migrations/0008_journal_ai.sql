-- Journal AI: dynamic life categories (with auto-creation), long-term memories,
-- and auto-categorization of entries.

create table if not exists journal_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_auto     boolean not null default false,   -- true = created by the AI
  created_at  timestamptz not null default now()
);

-- Seed the starting life categories (the AI can add more over time).
insert into journal_categories (name, description, is_auto) values
  ('Health', 'Physical and mental wellbeing', false),
  ('Work', 'Career, job, professional life', false),
  ('Relationships', 'Family, friends, partner', false),
  ('Money', 'Finances, spending, savings', false),
  ('Personal Growth', 'Learning, habits, self-improvement', false),
  ('Fun & Leisure', 'Hobbies, rest, enjoyment', false)
on conflict (name) do nothing;

-- Categories each entry was auto-assigned to.
alter table journal_entries add column if not exists categories text[] not null default '{}';

-- Long-term memory notes the AI keeps so it can recall people, situations, and
-- recurring themes across sessions.
create table if not exists journal_memories (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  category    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists journal_memories_created_idx on journal_memories (created_at desc);
