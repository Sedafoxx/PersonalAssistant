import OpenAI from "openai";
import { NextRequest } from "next/server";
import { TOOL_DEFINITIONS, executeTool } from "@/lib/claude-tools";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a personal assistant embedded in a productivity app. You help the user manage their todos, notes, and ideas through natural conversation.

When the user mentions something they need to do, a thought they want to capture, or an idea they have — proactively create the appropriate item using your tools. Don't wait to be asked explicitly.

Guidelines:
- Whenever the user ASKS about something they previously captured, references a topic, or asks "what did I…" / "do I have…" style questions, you MUST call search_items FIRST before answering. Search using the key noun(s) from their message (e.g. a project or product name like "CoupleCalendar"), not abstract verbs like "adapt". Never claim nothing exists until you have searched.
- search_items searches ALL types (todos, notes, ideas) by keyword and meaning. Do not assume the user means only ideas.
- If a search returns matches, list the relevant ones plainly instead of inventing or guessing.
- To update, complete, or delete an item you MUST use its real "id" (a UUID). You only have an id if it came from a search_items or list_items result in THIS request. Never invent or guess an id. If the user refers to an item by name (e.g. "mark the couple test done"), FIRST call search_items to get its id, THEN call update_item/delete_item with that exact id.
- When the next step is a discrete choice (which type: idea/todo/note, a priority level, a yes/no confirmation, or "which of these?"), call ask_choice to show tappable buttons instead of asking in plain prose. Keep options to 2-6 short labels. Use mode "multi" only when several answers can be picked together.
- When the user states a long-term aspiration, target, or habit ("I want to run 3x a week", "read 12 books this year") → create_goal. When they ask how they're tracking → list_goals. Journal entries auto-advance goal progress, so you usually only create/list goals, not manually bump them.
- For action items / tasks → create a "todo"
- For information, references, or things to remember → create a "note"
- For brainstorming or creative thoughts → create an "idea"
- Always confirm what you created in your reply, e.g. "Got it — I've added 'Buy groceries' to your todos."
- When showing lists, be concise. Use bullet points.
- Priority: 1 = critical, 2 = high, 3 = normal, 4 = low, 5 = someday
- If the user mentions a time ("tomorrow", "next week", "at 3pm"), parse it into an ISO date relative to today (${new Date().toISOString().split("T")[0]}).
- Today's date is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.map((m: { role: string; content: string }) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const runLoop = async (): Promise<string> => {
    const currentMessages = [...apiMessages];

    for (let i = 0; i < 5; i++) {
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        tools: TOOL_DEFINITIONS,
        messages: currentMessages,
      });

      const choice = response.choices[0];

      if (choice.finish_reason === "stop") {
        return choice.message.content ?? "";
      }

      if (choice.finish_reason === "tool_calls") {
        // ask_choice ends the turn and renders tappable buttons on the client.
        const askCall = choice.message.tool_calls?.find(
          (t) => t.function.name === "ask_choice"
        );
        if (askCall) {
          const args = JSON.parse(askCall.function.arguments) as {
            question?: string;
            options?: string[];
            mode?: "single" | "multi";
          };
          const payload = {
            mode: args.mode ?? "single",
            options: args.options ?? [],
          };
          const q = args.question ?? choice.message.content ?? "";
          return `${q}\n\n[[CHOICES]]${JSON.stringify(payload)}`;
        }

        currentMessages.push(choice.message);

        for (const toolCall of choice.message.tool_calls ?? []) {
          const input = JSON.parse(toolCall.function.arguments) as Record<
            string,
            unknown
          >;
          const result = await executeTool(toolCall.function.name, input);
          currentMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: result,
          });
        }
        continue;
      }

      break;
    }

    return "I processed your request.";
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const text = await runLoop();
        controller.enqueue(encoder.encode(text));
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
