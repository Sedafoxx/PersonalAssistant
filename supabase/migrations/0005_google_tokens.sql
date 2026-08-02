-- Run in Supabase SQL editor.
-- Stores the single Google OAuth token set for the assistant's calendar access.
-- Single-row table (id = 1), written via NextAuth signIn callback (service role).

create table if not exists google_tokens (
  id            integer primary key,
  access_token  text,
  refresh_token text,
  expires_at    bigint,
  updated_at    timestamptz not null default now()
);

-- No RLS policies needed: only the server (service role) ever touches this table.
alter table google_tokens enable row level security;
