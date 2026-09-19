-- One notebook (M2): facts gain the semantics they were missing.
--
-- Two problems this fixes, both measured before the change:
--
-- 1. THE SAME TRUTH LIVED IN TWO STORES. `coach_memory` held 552 rows of
--    free-text memory about the user, written 0-3 rows per chat turn, with NO
--    update path at all (insert + exact-string de-dupe only). `memory_facts`
--    held 270 rows in (topic, key, value) form WITH supersede semantics. So the
--    store that could be corrected was the smaller one, and the store that could
--    not be corrected grew fastest. Facts become the single home; coach_memory
--    stops being written (its rows stay, read-only, as the migration's source).
--
-- 2. FACTS HAD NO IDEA WHAT KIND OF TRUTH THEY WERE. "Tofu: none left" and
--    "Career goal: move toward leadership" were the same shape with the same
--    lifetime, so volatile truths went stale silently and contradicted newer
--    ones — the exact failure the nightly review kept reporting. kind separates
--    them, and verify_after lets a state fact AGE instead of lying.
--
-- Nothing is ever deleted by any of this. kind/verify_after are advisory: a fact
-- past its verify_after is DEMOTED AND LABELLED in the prompt ("may be stale —
-- ask, do not assert"), never removed.
--
-- Additive + idempotent: safe to re-run.

alter table memory_facts
  -- durable = true for weeks (preferences, people, patterns)
  -- state   = true until reality moves (pantry, what he is reading, where he is)
  -- derived = a conclusion Nova itself drew (a coaching insight), not something said
  add column if not exists kind text not null default 'durable'
    check (kind in ('durable', 'state', 'derived')),
  -- Where it came from: a chat_messages id, a journal id, or a script name.
  add column if not exists source_ref text,
  -- How sure the extractor was, 0-1. Advisory, used to break ties when ranking.
  add column if not exists confidence numeric(3,2) not null default 0.70,
  -- When a state fact should be re-checked. NULL = never expires.
  add column if not exists verify_after timestamptz,
  -- When it was last confirmed by something the user actually said.
  add column if not exists verified_at timestamptz;

-- The staleness sweep asks "which state facts are past their verify date?".
create index if not exists memory_facts_verify_after_idx
  on memory_facts (verify_after) where status = 'active' and verify_after is not null;

-- Retrieval now also reports kind and verify_after, so the prompt can label a
-- fact that may have gone stale without a second query.
--
-- The DROP is required, not decorative: `create or replace` cannot change a
-- function's return type, and this one gains two columns. Without it the
-- migration fails with "cannot change return type of existing function" — and
-- because the statements above have already applied by then, a failed run leaves
-- the file half-applied, so everything here stays idempotent and re-runnable.
-- The app is the only caller, so there is nothing else to rebind.
drop function if exists match_memory_facts(vector, int, float);

create or replace function match_memory_facts(
  query_embedding vector(1536),
  match_count int default 40,
  match_threshold float default 0.15
) returns table (
  id uuid,
  topic_id uuid,
  key text,
  value text,
  kind text,
  pinned boolean,
  source text,
  verify_after timestamptz,
  updated_at timestamptz,
  similarity float
)
language sql stable as $$
  select f.id,
         f.topic_id,
         f.key,
         f.value,
         f.kind,
         f.pinned,
         f.source,
         f.verify_after,
         f.updated_at,
         1 - (f.embedding <=> query_embedding) as similarity
  from memory_facts f
  where f.status = 'active'
    and f.embedding is not null
    and 1 - (f.embedding <=> query_embedding) > match_threshold
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
