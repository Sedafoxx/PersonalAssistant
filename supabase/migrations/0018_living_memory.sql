-- Living memory: a maintained store of facts the coach keeps CURRENT instead
-- of accumulating. A fact is a (topic, key) pair with one live value; writing
-- the same key again supersedes the old value rather than adding a row that
-- contradicts it. Nothing here is ever deleted — superseded values stay for
-- history so the UI can show what changed.
--
-- Additive + idempotent: safe to re-run.

-- Topics: a named area of the user's life a set of facts belongs to, with a
-- single human-readable summary the AI keeps rewriting from its active facts.
create table if not exists memory_topics (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique,
  title              text not null,
  summary            text,
  summary_updated_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Facts: one current value per (topic, key). key_norm is a generated,
-- normalized copy of key (the same lower+trim pattern as list_items.name_norm)
-- so "Diet" / "diet " / " DIET" can never open a second live fact.
create table if not exists memory_facts (
  id            uuid primary key default gen_random_uuid(),
  topic_id      uuid not null references memory_topics(id) on delete cascade,
  key           text not null,
  -- lower+trim of key; stored so the partial unique index and lookups use it.
  key_norm      text generated always as (lower(btrim(key))) stored,
  value         text not null,
  status        text not null default 'active'
                check (status in ('active', 'superseded', 'pending_removal')),
  pinned        boolean not null default false,
  source        text,
  superseded_by uuid references memory_facts(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The constraint that does the real work: at most ONE live fact per
-- (topic, key_norm). It is PARTIAL so a key that was superseded can be
-- legitimately re-added later without colliding with its own history.
create unique index if not exists memory_facts_active_key
  on memory_facts (topic_id, key_norm) where status = 'active';

create index if not exists memory_facts_topic_idx
  on memory_facts (topic_id, status);
