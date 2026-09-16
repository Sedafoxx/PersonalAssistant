-- Nova's feed: what FITS the user and what has been FOUND for them.
--
-- Four tables, additive + idempotent: safe to re-run. P1 (fit) only writes
-- feed_interests; the rest are created now so discovery (P2) and ranking (P3)
-- need no further migration.
--
--   feed_interests — the areas the assistant derived from the user's own
--                    signals, each with the EVIDENCE that produced it.
--   feed_items     — real, individually validated links. url_norm is the
--                    dedupe key, so a repeat discovery run cannot duplicate.
--   feed_feedback  — the user's save / not_for_me / done signal per item.
--   feed_prefs     — a single row of daily volume preferences.

-- Interests: one row per area. kind 'topic' is something to seek out,
-- 'avoid' is something the signals show the user wants LESS of (brain rot,
-- doomscrolling, outrage news). text_norm is a generated, normalized copy of
-- text (the same lower+trim pattern as memory_facts.key_norm) so "Sourdough
-- Baking" / "sourdough baking " can never open a second row. evidence is the
-- actual signal the model cited; source says where the row came from, and only
-- source='derived' rows may ever be rewritten by the model.
create table if not exists feed_interests (
  id         uuid primary key default gen_random_uuid(),
  text       text not null,
  -- lower+trim of text; stored so the unique index and lookups use it.
  text_norm  text generated always as (lower(btrim(text))) stored,
  kind       text not null default 'topic'
             check (kind in ('topic', 'avoid')),
  weight     numeric not null default 1,
  evidence   text,
  source     text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live row per (text, kind): re-deriving the same interest updates it
-- instead of adding a near-duplicate.
create unique index if not exists feed_interests_text_norm_kind_key
  on feed_interests (text_norm, kind);

-- Items: a real link the assistant found and validated. url_norm is the generated
-- lower+trim of url and is the DEDUPE KEY — the unique index below is the whole
-- reason a repeat run cannot insert the same link twice. score/reason/bucket are
-- filled by ranking (P3) and stay null until then.
create table if not exists feed_items (
  id                  uuid primary key default gen_random_uuid(),
  url                 text not null,
  -- lower+trim of url; stored so the unique index and lookups use it.
  url_norm            text generated always as (lower(btrim(url))) stored,
  kind                text not null
                      check (kind in ('article', 'video', 'podcast', 'post')),
  platform            text not null,
  title               text not null,
  summary             text,
  creator             text,
  published_at        timestamptz,
  duration_seconds    integer,
  image_url           text,
  validated           boolean not null default false,
  score               numeric,
  reason              text,
  matched_goal_id     uuid references goals(id) on delete set null,
  matched_interest_id uuid references feed_interests(id) on delete set null,
  bucket              text check (bucket in ('growth', 'fun')),
  status              text not null default 'new'
                      check (status in ('new', 'saved', 'done', 'hidden')),
  surfaced_day        date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The dedupe constraint that does the real work.
create unique index if not exists feed_items_url_norm_key
  on feed_items (url_norm);

-- Today's surface: "what is waiting for me right now".
create index if not exists feed_items_surfaced_idx
  on feed_items (surfaced_day, status);

-- Feedback: the user's one-tap signal on an item. Never a delete — the item
-- stays and its status is what changes.
create table if not exists feed_feedback (
  id      uuid primary key default gen_random_uuid(),
  item_id uuid references feed_items(id) on delete cascade,
  signal  text not null check (signal in ('save', 'not_for_me', 'done')),
  at      timestamptz default now()
);

-- Preferences: a single row (id is pinned to 1) holding how much to surface
-- and when it was last refreshed.
create table if not exists feed_prefs (
  id              integer primary key default 1 check (id = 1),
  daily_count     integer not null default 6,
  daily_minutes   integer not null default 45,
  last_refresh_at timestamptz
);
