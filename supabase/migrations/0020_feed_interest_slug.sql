-- Feed interests: a stable identity and real search phrases.
--
-- The first derivation run showed why free text is not enough as an identity:
-- "Tennis spielen Hobby" and "tennis training drills and technique" are the same
-- interest, but (text_norm, kind) only catches byte-identical strings, so every
-- re-derivation added near-duplicates instead of updating a row. `slug` is the
-- model's own stable name for the area ("vegan-curry"), so re-deriving updates
-- the existing row, and near-identical labels collapse together.
--
-- `queries` holds the concrete search phrases for the area, kept separate from
-- the human-readable label so the label stays readable and the queries stay
-- effective (English keyword phrases search better than a sentence).
--
-- Additive + idempotent: safe to re-run.

alter table feed_interests
  add column if not exists slug text;

alter table feed_interests
  add column if not exists queries text[] not null default '{}';

-- One live row per (slug, kind). Partial so slug-less rows (hand-added by the
-- user later) are unaffected and can still rely on the (text_norm, kind) index.
create unique index if not exists feed_interests_slug_kind_key
  on feed_interests (slug, kind) where slug is not null;
