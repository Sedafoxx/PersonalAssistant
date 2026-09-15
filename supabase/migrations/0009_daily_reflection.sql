-- Daily evening reflection (Habit + Journaling Tracker).
-- One row per calendar day. `checklist` holds toggleable evening habits; the
-- two text fields are the short reflection prompts; `completed` marks the day
-- as wrapped up. Linked to the journaling habit via the "journal" checklist
-- item, which the API auto-syncs with whether a journal entry exists that day.

create table if not exists daily_reflections (
  id            uuid primary key default gen_random_uuid(),
  day           date not null unique,          -- YYYY-MM-DD the reflection is for
  checklist     jsonb not null default '[]',   -- [{id,label,done}, ...]
  went_well     text,                          -- "Was lief heute gut?"
  could_improve text,                          -- "Was kann besser werden?"
  completed     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists daily_reflections_day_idx on daily_reflections (day desc);
create index if not exists daily_reflections_completed_idx on daily_reflections (completed);
