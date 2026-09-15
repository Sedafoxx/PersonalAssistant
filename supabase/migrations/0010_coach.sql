-- Proactive Life Coach (Phase 1: morning/evening check-in + closed feedback loop).
-- coach_checkins: one row per check-in (morning/evening per day). Carries mood,
-- a one-question exchange, and the single proposed next action. Status/feedback
-- close the loop (proposed -> done|skipped|failed + outcome note).
-- coach_goal_state: per-goal running notes the coach updates over time.
-- coach_people: light memory of people the user cares about (e.g. Theresa).

create table if not exists coach_checkins (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null default 'morning',  -- morning | evening
  day                date not null,                    -- user's local day
  mood               int,                              -- 1..5
  energy             int,                              -- 1..5 (optional)
  focus              text,                             -- "what I want to focus on today" (morning)
  question           text,                             -- the coach's question
  answer             text,                             -- the user's answer
  went_well          text,                             -- evening: what went well
  could_improve      text,                             -- evening: what to improve
  next_action        text,                             -- the ONE proposed next action
  next_action_domain text,                             -- books|fitness|food|habits|reflection|social|work|money|fun|other
  next_action_goal   uuid references goals(id),
  next_action_due    date,                             -- optional deadline
  status             text not null default 'proposed', -- proposed | done | skipped | failed
  feedback           text,                             -- user note: "this worked / this didn't"
  outcome            text,                             -- coach reflection on the outcome
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists coach_checkins_day_idx on coach_checkins (day desc);
create index if not exists coach_checkins_kind_day_idx on coach_checkins (kind, day desc);
create index if not exists coach_checkins_status_idx on coach_checkins (status);

create table if not exists coach_goal_state (
  goal_id        uuid primary key references goals(id) on delete cascade,
  notes          text,
  last_action    text,
  last_outcome   text,
  updated_at     timestamptz not null default now()
);

create table if not exists coach_people (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  relation   text,                -- friend | partner | colleague | family | ...
  notes      text,                -- context/reminders the coach should remember
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_people_name_idx on coach_people (lower(name));
