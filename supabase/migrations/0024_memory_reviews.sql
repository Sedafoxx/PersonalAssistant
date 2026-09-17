-- Nightly review (P6b): one auditable row per nightly run.
--
-- The complaint behind this phase: the coach promised to "tidy up at night" —
-- consolidate facts, resolve contradictions — so the morning starts from a tidy
-- record instead of a pile. But tidying must never be silent: the review may
-- rewrite a topic SUMMARY (a derived, regenerable artefact, exactly the curate
-- step that already exists) and NOTHING else. It may not change a loop's state
-- or waiting_on, delete or supersede a fact, or touch an item or a commitment.
--
-- So what it produces instead is a REPORT: what it tidied, what looks
-- contradictory, what has gone quiet. That report lives here (auditable, and the
-- only thing the 08:00 morning check needs), where the user or the coach can act
-- on it in the conversation. Same discipline as forget_fact being propose-only.
--
-- Additive + idempotent: safe to re-run.

create table if not exists memory_reviews (
  id                 uuid primary key default gen_random_uuid(),
  ran_at             timestamptz not null default now(),
  -- How many topics the run looked at, and how many actually produced a new
  -- summary (a failed curate leaves the previous summary in place and does not
  -- count). Keeping both makes a night where curation failed indistinguishable
  -- from a night with nothing to curate only if you ignore the pair.
  topics_curated     integer not null default 0,
  topics_considered  integer not null default 0,
  -- Counts the review observed but did NOT act on. They are the evidence that it
  -- reported rather than mutated: they are here, and the loops/commitments they
  -- describe are unchanged.
  stale_loops        integer not null default 0,
  open_commitments   integer not null default 0,
  -- The model's findings: an array of
  -- { topic?: string, kind: "contradiction" | "stale" | "note", text: string }.
  -- An empty array is the correct answer on a clean night, and the default here
  -- so a row can never be written without stating it.
  observations       jsonb not null default '[]'::jsonb,
  notes              text,
  created_at         timestamptz not null default now()
);

-- The latest review is the only one the morning needs, and this is the index
-- that makes "latest" a single first-row read rather than a sort of the history.
create index if not exists memory_reviews_ran_at_idx
  on memory_reviews (ran_at desc);
