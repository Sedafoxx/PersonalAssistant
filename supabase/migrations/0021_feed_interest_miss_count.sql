-- Retiring an interest area takes TWO consecutive misses, not one.
--
-- The first version retired an area the moment a derivation did not mention it,
-- and the active set flapped between 11 and 12 areas across runs: the model
-- re-phrases a label or re-balances weights between derivations, so an area can
-- legitimately drop out once without meaning anything. Deactivating on that is
-- noise, and a feed that loses a topic for a day is worse than one that keeps a
-- marginal topic for a day.
--
-- `miss_count` counts consecutive derivations in which an active area was not
-- produced. It resets to 0 the moment the area comes back. At 2 the row is
-- deactivated — still never deleted, so its evidence and history stay and
-- getInterests() simply hides it.
--
-- Additive + idempotent: safe to re-run.

alter table feed_interests
  add column if not exists miss_count integer not null default 0;
