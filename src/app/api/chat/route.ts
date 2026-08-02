import { NextRequest } from "next/server";
import { runAssistant } from "@/lib/chat";
import { logChatMessages, getConversation } from "@/lib/chat-log";

// Chat contract: POST { message: string, client_id?: string }.
// The client sends only the NEW user message; the server reconstructs the
// conversation from per-client history (conversation memory) and answers with
// full context. Memory is scoped by client_id, which the browser persists.
export async function POST(req: NextRequest) {
  const { message, client_id } = await req.json();

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

        const text = await runAssistant(context);
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
