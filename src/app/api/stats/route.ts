import { NextResponse } from "next/server";
import { getLifeStats } from "@/lib/journal";

export const dynamic = "force-dynamic";

// Lightweight life-stats for the sidebar XP chip (avoids loading the full
// journal payload just to show level/XP).
export async function GET() {
  try {
    const stats = await getLifeStats();
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
