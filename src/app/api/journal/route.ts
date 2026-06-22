import { NextRequest, NextResponse } from "next/server";
import {
  createJournalEntry,
  getJournalEntries,
  getLifeStats,
} from "@/lib/journal";
import { getGoals } from "@/lib/goals";

export async function GET() {
  try {
    const [entries, stats, goals] = await Promise.all([
      getJournalEntries(),
      getLifeStats(),
      getGoals("active"),
    ]);
    return NextResponse.json({ entries, stats, goals });
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
    const { entry, advancedGoals } = await createJournalEntry(text.trim());
    const stats = await getLifeStats();
    return NextResponse.json({ entry, stats, advancedGoals });
  } catch (err) {
    console.error("journal POST error", err);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }
}
