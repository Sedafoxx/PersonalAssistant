import { NextRequest, NextResponse } from "next/server";
import {
  createJournalEntry,
  getJournalEntries,
  getLifeStats,
  getCategories,
  getMemories,
} from "@/lib/journal";
import { getGoals } from "@/lib/goals";

export async function GET() {
  try {
    const [entries, stats, goals, categories, memories] = await Promise.all([
      getJournalEntries(),
      getLifeStats(),
      getGoals("active"),
      getCategories(),
      getMemories(),
    ]);
    return NextResponse.json({ entries, stats, goals, categories, memories });
  } catch (err) {
    console.error("journal GET error", err);
    return NextResponse.json({ error: "Failed to load journal" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { text } = (await req.json()) as { text?: string };
    if (!text || !text.trim()) {
      return NextResponse.json({ error: "Empty entry" }, { status: 400 });
    }
    const { entry, advancedGoals, newCategory } = await createJournalEntry(
      text.trim()
    );
    const [stats, categories] = await Promise.all([getLifeStats(), getCategories()]);
    return NextResponse.json({ entry, stats, advancedGoals, newCategory, categories });
  } catch (err) {
    console.error("journal POST error", err);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }
}
