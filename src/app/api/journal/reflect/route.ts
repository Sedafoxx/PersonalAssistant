import { NextRequest, NextResponse } from "next/server";
import {
  reflect,
  getCategories,
  getMemories,
  addMemory,
  getJournalEntries,
} from "@/lib/journal";
import { getGoals } from "@/lib/goals";

// Guided reflection: the AI asks ONE warm, casual follow-up question at a time,
// grounded in the user's latest entry, their life categories, long-term
// memories, and goals. POST { entry_id?, history: [{role, content}] }.
export async function POST(req: NextRequest) {
  try {
    const { entry_id, history } = (await req.json()) as {
      entry_id?: string;
      history?: { role: string; content: string }[];
    };

    const recent = await getJournalEntries(100);
    const entry = entry_id
      ? recent.find((e) => e.id === entry_id) ?? recent[0]
      : recent[0];
    if (!entry) {
      return NextResponse.json(
        { error: "Log a journal entry first, then reflect on it." },
        { status: 400 }
      );
    }

    const [categories, memories, goals] = await Promise.all([
      getCategories(),
      getMemories(50),
      getGoals("active"),
    ]);

    const result = await reflect(entry.raw_text, {
      categories: categories.map((c) => c.name),
      memories: memories.map((m) => m.text),
      goals: goals.map((g) => g.title),
      history: Array.isArray(history)
        ? history
            .slice(-10)
            .map((h) => ({
              role: h.role === "assistant" ? ("assistant" as const) : ("user" as const),
              content: String(h.content ?? ""),
            }))
        : [],
    });

    if (result.memory) {
      try {
        await addMemory(result.memory.text, result.memory.category);
      } catch {
        // non-fatal
      }
    }

    return NextResponse.json({
      reply: result.reply,
      memory: result.memory,
      categories: categories.map((c) => c.name),
    });
  } catch (err) {
    console.error("journal reflect error", err);
    return NextResponse.json({ error: "Reflection failed" }, { status: 500 });
  }
}
