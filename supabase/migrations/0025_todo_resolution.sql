-- Resolution for todos: the third state.
--
-- THE BUG THIS FIXES. Ticking a task in the Today view flipped items.status to
-- 'done' and stopped there. The row kept its planned_for, so the finished task
-- went on occupying its day forever, and the Todos tab — which listed every
-- non-archived item — went on presenting it as a todo. The user's own words:
-- "the todo items are added to today, are crossed out, but they remain a todo.
-- i have many finished todos now that need clean up." Measured at the time:
-- 113 todos, 45 active, 57 done, 34 of the done ones still pinned to a day.
--
-- WHY NOT status = 'archived'. status and planned_for are the HISTORY KEYS, and
-- three readers depend on them meaning what they mean today:
--   - getTaskTrend() and getDayMetrics() count a completed task by reading
--     status = 'done' together with planned_for, so archiving would blank out
--     the done-counts the Stats tab draws.
--   - syncMilestoneFromTasks() and getMilestoneTaskCounts() exclude archived
--     tasks (status <> 'archived'), so archiving a finished task would REMOVE it
--     from its milestone's roll-up and could flip a completed milestone back to
--     open — silently deleting visible progress.
--   - 'archived' already means "dropped without doing it" (day.ts dropTask, and
--     the commitments ledger), so reusing it would make the two
--     indistinguishable.
--
-- So resolution gets its own marker and hides without erasing:
--   resolved_at IS NULL      → live for planning: the list, the day, the backlog
--   resolved_at IS NOT NULL  → finished and put away. status stays 'done' and
--                              planned_for stays, so every historical reader is
--                              unchanged. Reversible: set it back to null.
--
-- Additive + idempotent: safe to re-run.

alter table items add column if not exists resolved_at timestamptz;

-- The sweep asks "which finished todos are still unresolved?" on every Today
-- read, so that lookup is the one worth an index.
create index if not exists items_done_unresolved_idx
  on items (resolved_at) where status = 'done';
