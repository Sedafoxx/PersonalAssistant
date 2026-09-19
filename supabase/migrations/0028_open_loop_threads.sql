-- Threads become the entities the coach moves (M3).
--
-- THE PROBLEM. What Nova knew about Theresa, Viktoria, Vienna Pharma, the Feed and
-- the Coach MVP lived in sentences: 552 of them in the prose store, against 8 rows
-- in the one structure with a state that can actually be moved. But a coach does
-- not move sentences — it moves THREADS. A person or a project with a state, a last
-- touch and a next step is something you can plan against; a paragraph about them
-- is something you can only read back.
--
-- PROMOTION, NOT ADDITION. open_loops is already most of an entity layer (subject,
-- thread, state, waiting_on, detail, due_date, last_touched_at), so it is extended
-- rather than duplicated. A second parallel table is exactly how the memory store
-- ended up with two notebooks, one of which could not be corrected.
--
--   kind      — what the thread is about: a person, a project, or a theme
--   next_step — the ONE next concrete move
--
-- A thread with a state but no next step is a note. A thread with a next step is
-- something the coach can put in a day.
--
-- Additive + idempotent: safe to re-run.

alter table open_loops
  add column if not exists kind text not null default 'topic'
    check (kind in ('person', 'project', 'topic')),
  add column if not exists next_step text;

-- Label the existing threads that can be labelled WITHOUT guessing: if a thread's
-- subject contains the name of someone already recorded in coach_people, the thread
-- is about that person. Everything else stays 'topic' until the coach labels it in
-- conversation — which is better than a heuristic inventing a category for it.
--
-- Wrapped in a DO block so the migration is safe on a database where the coach
-- tables were never created.
do $$
begin
  if to_regclass('public.coach_people') is not null
     and to_regclass('public.open_loops') is not null then
    update open_loops l
    set kind = 'person'
    where l.kind = 'topic'
      and exists (
        select 1
        from coach_people p
        where p.name is not null
          and length(btrim(p.name)) > 2
          and lower(l.subject) like '%' || lower(btrim(p.name)) || '%'
      );
  end if;
end $$;

create index if not exists open_loops_kind_state_idx on open_loops (kind, state);
