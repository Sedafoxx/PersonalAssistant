-- Self-improvement loop: log chat turns so the AI can learn from how the user
-- actually talks to the assistant, and store AI-generated suggestions for
-- improving the app's UX / features. Suggestions are surfaced to the developer
-- (via `npm run suggestions`) to decide what to build next.

create table if not exists chat_messages (
  id          uuid primary key default gen_random_uuid(),
  role        text not null,                 -- 'user' | 'assistant'
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_created_idx
  on chat_messages (created_at desc);

create table if not exists suggestions (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,                 -- short imperative headline
  category    text not null default 'feature',-- feature | ux | workflow | automation | content
  rationale   text,                          -- why this helps the user
  evidence    text,                          -- the data pattern that prompted it
  status      text not null default 'new',   -- new | building | done | dismissed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists suggestions_status_idx on suggestions (status);
