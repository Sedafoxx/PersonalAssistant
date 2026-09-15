-- "Plan my day": store the generated time-blocked day plan on the day's
-- morning check-in row (one plan per day). Shape:
--   { date, headline, note, generated_at, blocks:[{start,end,title,type,goal,why}] }

alter table coach_checkins
  add column if not exists plan jsonb;
