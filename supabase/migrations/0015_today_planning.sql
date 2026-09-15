-- "Today" task window + per-task planning.
--
-- The day window ("Today") is a *view* over real todos that carry a
-- planned_for date, NOT a separate task table: the same row the user creates
-- in the todo list is the row they see on Today, so there is nothing to sync
-- and no duplicate task concepts. planned_for is the day the user intends to
-- work on an item; planned_time/day_order give it a stable place inside that
-- day (a display/ordering label and a manual position), required marks
-- needed-vs-optional, and goal_id optionally links the task to the goal it
-- advances.
--
-- Additive + idempotent: every column is added with "if not exists", so
-- re-running this migration is a no-op.

alter table items
  add column if not exists planned_for   date,                                     -- the day the user intends to work on it
  add column if not exists planned_time  text,                                     -- HH:MM display/ordering label
  add column if not exists day_order     int,                                      -- manual position within a day
  add column if not exists required      boolean not null default true,            -- needed vs optional
  add column if not exists goal_id       uuid references goals(id) on delete set null;

-- Today queries filter on planned_for for active (non-archived) todos; a
-- partial index keeps that lookup cheap.
create index if not exists items_planned_for_idx
  on items (planned_for) where status = 'active';
