import { createServiceClient } from "./supabase";

// Persist chat turns so the suggestion engine can learn from how the user
// actually talks to the assistant (where it fails, what they repeat, what they
// reach for), and so the assistant can remember a conversation across requests
// (per-client_id history). Best-effort — never let a logging error break the
// chat reply.
export async function logChatMessages(
  msgs: { role: "user" | "assistant"; content: string }[],
  clientId?: string
): Promise<void> {
  const rows = msgs
    .map((m) => ({ role: m.role, content: m.content.trim(), client_id: clientId ?? null }))
    .filter((m) => m.content.length > 0);
  if (rows.length === 0) return;
  try {
    const db = createServiceClient();
    await db.from("chat_messages").insert(rows);
  } catch {
    // swallow — logging is non-essential
  }
}

export interface ChatMessageRow {
  role: string;
  content: string;
  created_at: string;
}

export async function getRecentChat(limit = 40): Promise<ChatMessageRow[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("chat_messages")
    .select("role,content,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  // Return chronological (oldest first) for readable digests.
  return ((data ?? []) as ChatMessageRow[]).reverse();
}

// Recent turns for ONE conversation (client_id), oldest first — this is what
// the assistant uses to remember the conversation.
export async function getConversation(
  clientId: string,
  limit = 40
): Promise<ChatMessageRow[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("chat_messages")
    .select("role,content,created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ChatMessageRow[]).reverse();
}
