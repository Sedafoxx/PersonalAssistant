import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_CHECKLIST,
  getReflection,
  getReflectionHistory,
  getReflectionStreak,
  todayISO,
  upsertReflection,
  type ChecklistItem,
} from "@/lib/reflection";
import { getJournalStreak, hasEntryToday } from "@/lib/journal";

export async function GET() {
  try {
    const [today, history, journaledToday, journalStreak, reflectStreak] =
      await Promise.all([
        getReflection(todayISO()),
        getReflectionHistory(20),
        hasEntryToday(),
        getJournalStreak(),
        getReflectionStreak(),
      ]);

    // Auto-sync the "journal" checklist item with whether an entry was logged.
    let checklist = today?.checklist ?? DEFAULT_CHECKLIST;
    if (journaledToday) {
      checklist = checklist.map((c) =>
        c.id === "journal" ? { ...c, done: true } : c
      );
    }

    return NextResponse.json({
      today: today ? { ...today, checklist } : null,
      history,
      journaledToday,
      journalStreak,
      reflectStreak,
    });
  } catch (err) {
    console.error("reflection GET error", err);
    return NextResponse.json({ error: "Failed to load reflection" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      checklist?: ChecklistItem[];
      went_well?: string | null;
      could_improve?: string | null;
      completed?: boolean;
    };

    const journaledToday = await hasEntryToday();
    let checklist = Array.isArray(body.checklist)
      ? body.checklist.map((c) => ({
          id: c.id,
          label: c.label,
          done: !!c.done,
        }))
      : undefined;
    if (journaledToday && checklist) {
      checklist = checklist.map((c) =>
        c.id === "journal" ? { ...c, done: true } : c
      );
    }

    const today = await upsertReflection({
      day: todayISO(),
      checklist,
      went_well: body.went_well ?? null,
      could_improve: body.could_improve ?? null,
      completed: body.completed ?? false,
    });

    const [reflectStreak, history] = await Promise.all([
      getReflectionStreak(),
      getReflectionHistory(20),
    ]);
    return NextResponse.json({ today, reflectStreak, history });
  } catch (err) {
    console.error("reflection POST error", err);
    return NextResponse.json({ error: "Failed to save reflection" }, { status: 500 });
  }
}
