import { NextRequest, NextResponse } from "next/server";
import { runAssistant, type ChatMode } from "@/lib/chat";
import { buildCoachContext, extractMemories } from "@/lib/coach";
import { logChatMessages, getConversation, getThread } from "@/lib/chat-log";

// Chat contract: POST { message: string, client_id?: string, mode?: "assistant"|"coach" }.
// The client sends only the NEW user message; the server reconstructs the
// conversation from per-client history (conversation memory) and answers with
// full context. Memory is scoped by client_id, which the browser persists.
// mode="coach" makes the same window act as the user's proactive life coach.
export async function POST(req: NextRequest) {
  const { message, client_id, mode } = await req.json();
  const chatMode: ChatMode = mode === "coach" ? "coach" : "assistant";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const userText = String(message ?? "").trim();

        // Load recent turns for this conversation and build full context.
        const history = client_id ? await getConversation(String(client_id), 40) : [];
        const context: { role: "user" | "assistant"; content: string }[] = [
          ...history.map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            content: m.content,
          })),
          { role: "user", content: userText || " " },
        ];

        // For coach mode, feed the live coach context digest (goals, mood,
        // open actions, people, per-goal notes) into the system prompt.
        let userContext: string | undefined;
        if (chatMode === "coach") {
          try {
            userContext = await buildCoachContext();
          } catch {
            userContext = undefined; // coach tables may not exist yet
          }
        }

        const text = await runAssistant(context, {
          mode: chatMode,
          userContext,
        });
        controller.enqueue(encoder.encode(text));

        // Log this turn (newest user message + assistant reply) for memory and
        // the suggestion engine. Strip the choice-button marker from storage.
        const reply = text.split("[[CHOICES]]")[0].trim();
        await logChatMessages(
          [
            ...(userText ? [{ role: "user" as const, content: userText }] : []),
            ...(reply ? [{ role: "assistant" as const, content: reply }] : []),
          ],
          client_id ? String(client_id) : undefined
        );

        // Coach mode: extract durable long-term memories from the exchange so
        // the coach remembers what was discussed (best-effort).
        if (chatMode === "coach" && userText && reply) {
          try {
            await extractMemories(userText, reply);
          } catch {
            // non-fatal
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encoder.encode(`Error: ${msg}`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// GET /api/chat?client_id=<id> -> { messages: ChatMessageRow[] }.
// The panel calls this on mount / mode change to restore the visible thread.
// A missing client_id is not an error: an anonymous browser simply has no
// history, so we answer with an empty list and 200.
export async function GET(req: NextRequest) {
  try {
    const clientId = new URL(req.url).searchParams.get("client_id");
    if (!clientId) return NextResponse.json({ messages: [] });
    const messages = await getThread(clientId, 200);
    return NextResponse.json({ messages });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
