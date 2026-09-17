-- Commitments ledger + open loops (P6a).
--
-- The complaint behind this phase: "you forget things, even though you have so
-- much memory." Two things were claimed by memory but never persisted: a ledger
-- of the promises the USER made, and a state we can move per open thread. Prose
-- in a chat turn is not a durable write, so a promise said in the morning had
-- nothing a later run could verify or re-surface.
--
-- Additive + idempotent: safe to re-run.

-- Commitments: one row per promise the user made, backed by a REAL item.
-- text_norm is a generated, normalized copy of text (the same lower+trim
-- pattern as memory_facts.key_norm) so "Kaufe Karotten" and "kaufe karotten "
-- cannot open two live commitments for the same promise.
create table if not exists commitments (
  id         uuid primary key default gen_random_uuid(),
  text       text not null,
  -- lower+trim of text; the idempotency guarantee keys off this.
  text_norm  text generated always as (lower(btrim(text))) stored,
  quote      text,
  due_date   date,
  item_id    uuid references items(id) on delete set null,
  status     text not null default 'open'
             check (status in ('open', 'done', 'dropped')),
  source     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The constraint that does the real work: at most ONE OPEN commitment per
-- normalized text. A promise said twice must not become two items. It is
-- PARTIAL so a commitment that was closed can be legitimately re-opened later
-- without colliding with its own history.
create unique index if not exists commitments_open_text
  on commitments (text_norm) where status = 'open';

create index if not exists commitments_status_due_idx
  on commitments (status, due_date);

-- Open loops: one thread per person or project, with a state we can move
-- (open → waiting → done) instead of a fact that only ever holds one value.
create table if not exists open_loops (
  id              uuid primary key default gen_random_uuid(),
  subject         text not null,
  -- lower+trim of subject; pairs with thread_norm to make a thread unique.
  subject_norm    text generated always as (lower(btrim(subject))) stored,
  thread          text not null,
  thread_norm     text generated always as (lower(btrim(thread))) stored,
  state           text not null default 'open'
                  check (state in ('open', 'waiting', 'done')),
  waiting_on      text check (waiting_on in ('you', 'them')),
  detail          text,
  due_date        date,
  last_touched_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- At most ONE live thread per (subject, thread). PARTIAL, so a done thread can
-- be re-opened without colliding with the row that already recorded it.
create unique index if not exists open_loops_thread
  on open_loops (subject_norm, thread_norm) where state <> 'done';

create index if not exists open_loops_state_touched_idx
  on open_loops (state, last_touched_at);
