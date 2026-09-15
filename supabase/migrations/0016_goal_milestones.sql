-- Real per-goal milestones. A goal becomes a short ordered checklist of
-- concrete steps; when a goal has milestones, its progress/target are derived
-- from them (progress = done count, target = total count) instead of the
-- journal-driven increment. Goals without milestones keep working as before.
--
-- Additive + idempotent: safe to re-run.

create table if not exists goal_milestones (
  id          uuid primary key default gen_random_uuid(),
  goal_id     uuid not null references goals(id) on delete cascade,
  title       text not null,
  target_date date,
  position    int  not null default 0,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists goal_milestones_goal_idx
  on goal_milestones (goal_id, position);
