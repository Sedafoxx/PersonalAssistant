-- Day tasks attach to a milestone. A day task belongs to at most one
-- milestone, and the milestone's completion is DERIVED from its tasks: a
-- milestone with any attached tasks (status != 'archived') is done only when
-- every attached task is done; a milestone with no attached tasks is left
-- alone and stays manually managed.
--
-- Additive + idempotent: safe to re-run.

alter table items
  add column if not exists milestone_id uuid references goal_milestones(id) on delete set null;

create index if not exists items_milestone_idx
  on items (milestone_id) where status = 'active';
