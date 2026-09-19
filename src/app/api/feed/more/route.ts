import { NextResponse } from "next/server";
import { topUpFeed } from "@/lib/feed";

export const dynamic = "force-dynamic";

// POST /api/feed/more — the bottom of the scroll asking for more.
//
// Called by the UI when the pool runs out, never on a timer. It is the ONLY feed
// endpoint that can spend money, and it spends it in the cheapest order:
//
//   step 1 judges candidates that are already stored but were never scored (no
//          search calls at all — this is most of the supply),
//   step 2 runs a real discovery round only when step 1 had nothing left, rotating
//          the interests one pass further so it searches something new.
//
// It answers with what it did rather than with items: the caller re-fetches the next
// page, so there is exactly one place that decides what the pool contains.
export async function POST() {
  try {
    const result = await topUpFeed();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
