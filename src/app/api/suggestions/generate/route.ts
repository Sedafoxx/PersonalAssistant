import { NextResponse } from "next/server";
import { generateSuggestions } from "@/lib/suggestions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Manual trigger for the suggestion engine (the daily cron also calls
// generateSuggestions via /api/notifications/send). POST to refresh now.
export async function POST() {
  try {
    const added = await generateSuggestions();
    return NextResponse.json({ added: added.length, suggestions: added });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
