import { NextRequest, NextResponse } from "next/server";
import { runAssistant } from "@/lib/chat";
import { buildCoachContext, extractMemories } from "@/lib/coach";
import { logChatMessages, getConversation, getThread } from "@/lib/chat-log";

// Chat contract: POST { message: string, client_id?: string, mode?: "assistant"|"coach" }.
// The client sends only the NEW user message; the server reconstructs the
// conversation from per-client history (conversation memory) and answers with
// full context. Memory is scoped by client_id, which the browser persists.
// `mode` is accepted but ignored: the assistant and the coach are now one
// persona and one conversation.
export async function POST(req: NextRequest) {
  // `mode` is still accepted for backwards compatibility but is ignored: both
  // doors now resolve to the same persona and the same conversation.
  const { message, client_id } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const userText = String(message ?? "").trim();

        // Load recent turns for this conversation and build full context. The
        // Assistant and the Coach used to be two threads (the legacy coach id
        // was `${client_id}:coach`); merge them chronologically so neither
        // history is abandoned, then keep the newest 40 for the model window.
        const primaryId = client_id ? String(client_id) : undefined;
        const legacyCoachId = primaryId ? `${primaryId}:coach` : undefined;
        const [primary, legacy] = primaryId
          ? await Promise.all([
              getConversation(primaryId, 40),
              legacyCoachId
                ? getConversation(legacyCoachId, 40).catch(() => [])
                : Promise.resolve([]),
            ])
          : [[] as Awaited<ReturnType<typeof getConversation>>, [] as Awaited<ReturnType<typeof getConversation>>];
        const history = [...primary, ...legacy]
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          )
          .slice(-40);
        const context: { role: "user" | "assistant"; content: string }[] = [
          ...history.map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
            content: m.content,
          })),
          { role: "user", content: userText || " " },
        ];

        // Always feed the live coach context digest (goals, mood, open actions,
        // people, per-goal notes) into the prompt, best-effort.
        let userContext: string | undefined;
        try {
          userContext = await buildCoachContext();
        } catch {
          userContext = undefined; // coach tables may not exist yet
        }

        const text = await runAssistant(context, {
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

        // Extract durable long-term memories from the exchange so the assistant
        // remembers what was discussed (best-effort).
        if (userText && reply) {
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
// The panel calls this on mount to restore the visible thread.
// A missing client_id is not an error: an anonymous browser simply has no
// history, so we answer with an empty list and 200.
export async function GET(req: NextRequest) {
  try {
    const clientId = new URL(req.url).searchParams.get("client_id");
    if (!clientId) return NextResponse.json({ messages: [] });

    // Merge the legacy coach thread into the restored view exactly as the POST
    // path merges it for the model. Without this the screen would show a shorter
    // conversation than the assistant is actually answering from, which would
    // look like history had been lost when it had not.
    const [primary, legacy] = await Promise.all([
      getThread(clientId, 200),
      getThread(`${clientId}:coach`, 200).catch(() => []),
    ]);
    const messages = [...primary, ...legacy].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
    );
    return NextResponse.json({ messages: messages.slice(-200) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
