-- A feed you can actually scroll, and read inside the app (P8).
--
-- TWO COMPLAINTS, ONE SHAPE.
--
-- 1. "i wanna be able to really scroll through a bunch of stuff." buildShortlist()
--    answers exactly one question — what are today's six items? — and that was the
--    only question the tab could ask, so every other item that had already scored
--    3+ was unreachable. Measured when this was written: 44 items met the bar and
--    121 stored candidates had never been judged at all. Nothing was missing; the
--    pool was simply unreadable.
--
-- 2. "the experience [should be] like in X: the post is directly in the app." A card
--    could only ever be a link, because the only stored text was Tavily's
--    ~300-character snippet. full_text holds the article BODY once it has been
--    fetched for reading, so the second open is instant and the feed stops being a
--    list of doors.
--
-- full_text is deliberately NOT part of the list queries — it would ride along in
-- every page payload — and it is fetched per item, on open.
--
-- Additive + idempotent: safe to re-run.

alter table feed_items
  add column if not exists full_text    text,
  add column if not exists full_text_at timestamptz;

-- The paged pool query is `status = 'new' and score >= 3, ordered by score desc,
-- created_at desc` and it is the only query a scroll runs repeatedly.
create index if not exists feed_items_pool_idx
  on feed_items (score desc, created_at desc)
  where status = 'new' and score is not null;
