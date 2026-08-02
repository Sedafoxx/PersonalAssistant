-- Gamified task completion: award XP when a todo is marked done.
-- xp_awarded is set once, on the first active->done transition (see db.ts),
-- so re-completing or re-opening a todo never double-counts. getLifeStats()
-- folds the sum of this column into the same totalXp/level as journal XP.

alter table items
  add column if not exists xp_awarded int not null default 0;

-- Sum query in getLifeStats filters on this; cheap partial index.
create index if not exists items_xp_awarded_idx
  on items (xp_awarded) where xp_awarded > 0;
