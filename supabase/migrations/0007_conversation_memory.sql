-- Per-conversation memory: scope chat history by a client id so the assistant
-- can recall prior turns (not just the current page session).
alter table chat_messages add column if not exists client_id text;

create index if not exists chat_messages_client_created_idx
  on chat_messages (client_id, created_at);
