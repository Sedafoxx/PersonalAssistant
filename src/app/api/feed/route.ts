import { NextRequest, NextResponse } from "next/server";
import {
  buildShortlist,
  buildFeedPage,
  getInterests,
  withGoalTitles,
  type FeedItem,
} from "@/lib/feed";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// The Feed tab's single read (P3b).
//
// Everything the tab renders comes back in ONE call — the day's ranked
// shortlist, the items the user saved, the active interests and the volume
// preferences — so the UI never has to sequence four requests or invent
// defaults for a row that has not been written yet.

const SAVED_LIMIT = 30;

const ITEM_COLS =
  "id,url,kind,platform,title,summary,creator,published_at,duration_seconds,image_url,validated,matched_interest_id,status,surfaced_day,created_at,updated_at";

// The preferences row, CREATED ON DEMAND. `feed_prefs` is a single pinned row
// (id = 1) and an empty table is a perfectly normal first-run state, so a
// missing row is not an error — it is the defaults being inserted. A failed
// write still returns the defaults rather than an error, because a feed with
// default volume is strictly better than a blank page.
async function loadPrefs(): Promise<{ daily_count: number; daily_minutes: number }> {
  const defaults = { daily_count: 6, daily_minutes: 45 };
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("feed_prefs")
      .select("daily_count,daily_minutes")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      return {
        daily_count: Number(data.daily_count ?? defaults.daily_count) || defaults.daily_count,
        daily_minutes: Number(data.daily_minutes ?? defaults.daily_minutes) || defaults.daily_minutes,
      };
    }
    const { data: inserted, error: insErr } = await db
      .from("feed_prefs")
      .insert({ id: 1, ...defaults })
      .select("daily_count,daily_minutes")
      .maybeSingle();
    if (insErr) throw new Error(insErr.message);
    return inserted
      ? {
          daily_count: Number(inserted.daily_count ?? defaults.daily_count) || defaults.daily_count,
          daily_minutes: Number(inserted.daily_minutes ?? defaults.daily_minutes) || defaults.daily_minutes,
        }
      : defaults;
  } catch {
    // A concurrent insert may have won the race, or the write may be blocked.
    // Either way the caller gets usable numbers, never a throw.
    return defaults;
  }
}

// GET /api/feed            -> { shortlist, saved, interests, prefs }
// GET /api/feed?offset=12  -> adds `page`, the next slice of the scrollable pool.
//
// The page is a SECOND, separate read rather than more of the shortlist: the
// shortlist is the day's six curated items, and the pool is everything else that
// cleared the same bar. Keeping them apart is what lets the tab say honestly
// "today's picks" and then keep going without pretending the rest are picks.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const wantsPage = sp.has("offset") || sp.has("page");
    const offset = Number(sp.get("offset") ?? 0) || 0;
    const limit = Number(sp.get("limit") ?? 12) || 12;

    const [shortlist, interests, prefs, page] = await Promise.all([
      wantsPage ? Promise.resolve(null) : buildShortlist(),
      getInterests(),
      loadPrefs(),
      wantsPage
        ? buildFeedPage({ offset, limit })
        : Promise.resolve(null),
    ]);

    if (wantsPage) {
      // A page-only request skips the shortlist and the saved list entirely: it is
      // the scroll asking for more, not the tab reloading.
      return NextResponse.json({ page });
    }
    if (!shortlist) {
      return NextResponse.json({ error: "No shortlist" }, { status: 500 });
    }

    // Every shortlist item carries the goal TITLE it is grouped under, resolved
    // through getGoals and safe when the goal row is missing.
    shortlist.items = await withGoalTitles(shortlist.items);

    // Saved items, newest first. The saved list is finite by design — no
    // counters, no scroll — so it is capped rather than paged.
    let saved: FeedItem[] = [];
    try {
      const db = createServiceClient();
      const { data, error } = await db
        .from("feed_items")
        .select(ITEM_COLS)
        .eq("status", "saved")
        .order("created_at", { ascending: false })
        .limit(SAVED_LIMIT);
      if (error) throw new Error(error.message);
      saved = (data ?? []) as FeedItem[];
    } catch {
      // An unreadable saved list must not blank the shortlist beside it.
      saved = [];
    }

    return NextResponse.json({ shortlist, saved, interests, prefs });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
