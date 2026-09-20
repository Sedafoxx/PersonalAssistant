-- Feed quality (2026-09-20): popularity as evidence, so an interesting TITLE can
-- stop outranking a poor video.
--
-- The complaint, and the measurement behind it: 81 videos were stored and a
-- salary-negotiation video with **2,465 views** had scored 5/5 — the top of the
-- pool — while a video from a 464k-subscriber channel sat at 3. The rubric judged
-- the topic and never asked whether anyone had found the video worth watching.
--
-- Where the numbers come from, in order of trust:
--   1. YouTube Data API v3 (`statistics`), when YOUTUBE_API_KEY is set. Exact, and
--      covers every video: 1 quota unit per 50 ids, so it is effectively free.
--   2. The Tavily snippet, which often carries the page's own text ("2,465 views",
--      "2910 subscribers"). Parsed as a fallback — measured at 13 of 81 stored
--      rows, i.e. useful, not sufficient.
--   3. NULL, which means UNKNOWN and is never treated as zero: a video whose
--      popularity is unknown is judged on substance alone, because silently
--      demoting everything unmeasured would empty the feed quietly.
--
-- Additive + idempotent: safe to re-run.
alter table feed_items
  -- Real counts, as YouTube reports them.
  add column if not exists view_count integer,
  add column if not exists like_count integer,
  add column if not exists comment_count integer,
  -- The channel, and how big it is. A tiny channel is the strongest signal that a
  -- "how to X" upload is one person's hobby rather than a resource.
  add column if not exists channel_name text,
  add column if not exists channel_subs integer;

-- The pool is ordered by score and then read in pages; the quality cap is applied
-- when a row is scored or swept, so no index is needed for the page query itself.
-- This one exists for the sweep, which asks "which videos have no counts yet?".
create index if not exists feed_items_video_counts_idx
  on feed_items (view_count) where kind = 'video';
