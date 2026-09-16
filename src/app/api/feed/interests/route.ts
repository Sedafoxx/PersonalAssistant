import { NextResponse } from "next/server";
import { getInterests, deriveInterests } from "@/lib/feed";

export const dynamic = "force-dynamic";

// The fit surface for Nova's feed (P1).
//
// GET returns every derived interest, INCLUDING inactive ones, so an interest
// the user removed stays visible and inspectable instead of silently vanishing
// — the same "archive, never hide" stance as /api/memory.
//
// POST is the manual "work out what fits me" trigger: it re-reads the user's
// own signals, derives interests from them, and upserts the result. It never
// deletes and never touches an interest the user added or removed by hand.
export async function GET() {
  try {
    const interests = await getInterests(false);
    return NextResponse.json({ interests });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const { interests, created, updated } = await deriveInterests();
    return NextResponse.json({ interests, created, updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
