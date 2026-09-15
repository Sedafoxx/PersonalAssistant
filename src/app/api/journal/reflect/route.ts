import { NextRequest, NextResponse } from "next/server";
import {
  reflect,
  getCategories,
  getMemories,
  addMemory,
  getJournalEntries,
} from "@/lib/journal";
import { getGoals } from "@/lib/goals";

// Format a YYYY-MM-DD day string as a friendly label like "Monday, 6 September".
function friendlyDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Convert a UTC timestamp to the local date string for the given offset
// (minutes, as returned by Date#getTimezoneOffset — negative ahead of UTC).
function localDay(iso: string, offsetMin: number): string {
  const ms = new Date(iso).getTime() - offsetMin * 60000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Guided reflection, now session-aware:
//   - Empty history  = a NEW daily session. The AI opens the reflection for the
//     user's local day, grounded only on today's entries + background memory —
//     it does NOT re-process the previous session or latest old entry.
//   - Non-empty history = continuing the current session's thread.
// POST { history, day?, tz_offset? } — day/tz_offset are the client's local
// date + timezone offset so "today" is correct in the user's timezone.
export async function POST(req: NextRequest) {
  try {
    const { history, day, tz_offset } = (await req.json()) as {
      history?: { role: string; content: string }[];
      day?: string; // client's local YYYY-MM-DD
      tz_offset?: number; // Date#getTimezoneOffset() minutes
    };

    const isNewSession = !Array.isArray(history) || history.length === 0;
    const offsetMin = typeof tz_offset === "number" ? tz_offset : 0;
    const localToday = typeof day === "string" ? day : localDay(new Date().toISOString(), offsetMin);

    const recent = await getJournalEntries(100);

    // Only entries logged today feed the opener — older ones stay out so the
    // session starts fresh instead of talking about the past.
    const todayEntries = recent
      .filter((e) => localDay(e.created_at, offsetMin) === localToday)
      .map((e) => e.summary ?? e.raw_text)
      .slice(0, 5);

    const [categories, memories, goals] = await Promise.all([
      getCategories(),
      getMemories(50),
      getGoals("active"),
    ]);

    // For a continuing session, keep grounding on the latest entry; fresh
    // sessions intentionally pass no old entry so they don't rehash the past.
    const entryText = isNewSession ? "" : (recent[0]?.raw_text ?? "");

    const result = await reflect(entryText, {
      categories: categories.map((c) => c.name),
      memories: memories.map((m) => m.text),
      goals: goals.map((g) => g.title),
      history: isNewSession
        ? []
        : history
            .slice(-10)
            .map((h) => ({
              role:
                h.role === "assistant"
                  ? ("assistant" as const)
                  : ("user" as const),
              content: String(h.content ?? ""),
            })),
      // New-session context: the current day + what's been logged today.
      ...(isNewSession
        ? { todayLabel: friendlyDay(localToday) || "today", todayEntries }
        : {}),
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
      session: isNewSession ? "new" : "continue",
    });
  } catch (err) {
    console.error("journal reflect error", err);
    return NextResponse.json({ error: "Reflection failed" }, { status: 500 });
  }
}
