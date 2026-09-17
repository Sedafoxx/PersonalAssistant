-- The feed's score is now an integer 1-5, not 0-100 (P5).
--
-- P3a ranked each candidate 0-100 against the derived INTEREST areas. P5 ranks
-- it 1-5 against the user's ACTIVE GOALS, with a threshold of 3: a 5-point scale
-- with a meaningful floor, not a percentage. The two scales cannot coexist in
-- one table, and a leftover 0-100 value would read as "well above the 1-5
-- maximum" and pin an old item to the top of every list forever.
--
-- So any row that carries an old-scale score (score > 5) is cleared: score,
-- reason and surfaced_day all go back to null, and the row returns to the
-- unranked pool with status untouched, eligible for a fresh 1-5 ranking on the
-- next run. Nothing is deleted and no row with a 1-5 score is affected, so this
-- is safe to re-run.
--
-- Additive + idempotent: safe to re-run.

update feed_items
  set score = null,
      reason = null,
      surfaced_day = null
  where score > 5;
