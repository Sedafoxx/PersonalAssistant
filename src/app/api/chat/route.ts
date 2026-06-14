import OpenAI from "openai";
import { NextRequest } from "next/server";
import { TOOL_DEFINITIONS, executeTool } from "@/lib/claude-tools";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a personal assistant embedded in a productivity app. You help the user manage their todos, notes, and ideas through natural conversation.

When the user mentions something they need to do, a thought they want to capture, or an idea they have — proactively create the appropriate item using your tools. Don't wait to be asked explicitly.

Guidelines:
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
