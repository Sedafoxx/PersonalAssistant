-- Coach check-ins are one row per (kind, day). The upsert (onConflict) needs a
-- real UNIQUE constraint, not just the index added in 0010. Dedup any rows that
-- slipped in before the constraint existed (keep the newest per kind+day), then
-- enforce uniqueness.

delete from coach_checkins a
using coach_checkins b
where a.kind = b.kind
  and a.day = b.day
  and a.created_at < b.created_at;

alter table coach_checkins
  add constraint coach_checkins_kind_day_key unique (kind, day);
