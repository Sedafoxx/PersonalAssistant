-- Persistent shopping lists (grocery + general shopping).
-- DB-level dedup: a generated, normalized name column under a unique
-- constraint means re-adding "Milk" / "milk " / " MILK" can never create a
-- second row — the insert is a no-op. This kills doubled entries at the
-- source instead of relying on the assistant to remember what's already there.

create table if not exists list_items (
  id         uuid primary key default gen_random_uuid(),
  list       text not null check (list in ('grocery', 'shopping')),
  name       text not null,
  -- lower+trim of name; stored so the unique constraint and lookups use it.
  name_norm  text generated always as (lower(btrim(name))) stored,
  checked    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint list_items_unique unique (list, name_norm)
);

create index if not exists list_items_list_idx on list_items (list);
