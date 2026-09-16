import { NextResponse } from "next/server";
import {
  getInterests,
  getStoredItems,
  discoverCandidates,
  saveCandidates,
} from "@/lib/feed";

export const dynamic = "force-dynamic";

// The discovery surface for Nova's feed (P2).
//
// GET returns the links already found and stored, newest first, so the result
// of a discovery run can be read without any UI.
//
// POST derives nothing: it loads the existing interests, finds candidates for
// them (searching each interest's queries, validating every candidate
// individually), stores the survivors and returns them grouped by interest.
// A repeat run inserts nothing new — feed_items.url_norm is the dedupe key.
export async function GET() {
  try {
    const items = await getStoredItems();
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/feed/discover -> { stats, items, byInterest }
export async function POST() {
  try {
    const interests = await getInterests();
    const { candidates, stats } = await discoverCandidates(interests);

    const interestIdById = new Map(interests.map((i) => [i.id, i.id]));
    const saved = await saveCandidates(candidates, interestIdById);

    // Grouped by interest text so the found links are readable in one response:
    // each entry carries the validated URL, kind, platform, duration and title.
    const byInterest: Record<
      string,
      { url: string; kind: string; platform: string; title: string; duration_seconds: number | null }[]
    > = {};
    for (const item of candidates) {
      const key = item.interest_text;
      (byInterest[key] ??= []).push({
        url: item.candidate.url,
        kind: item.kind,
        platform: item.platform,
        title: item.candidate.title,
        duration_seconds: item.candidate.duration_seconds,
      });
    }

    const items = await getStoredItems();
    return NextResponse.json({ stats: { ...stats, ...saved }, items, byInterest });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
