import { NextResponse } from "next/server";
import { buildShortlist, getInterests, type FeedItem } from "@/lib/feed";
import { getGoals } from "@/lib/goals";
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

// The heading a shortlist item is grouped under when its goal cannot be named:
// the goal row was deleted after the item was scored, or the read failed. A
// neutral heading is strictly better than a missing one — the UI groups BY goal,
// so an item with no title would otherwise sit under nothing or break the page.
const NO_GOAL_TITLE = "Everything else";

// Resolve each item's attributed goal TITLE (`goal`) alongside its id
// (`goalId`), because the UI groups the shortlist by goal heading and needs the
// name, not just the id.
//
// The title is read from `getGoals`, and the shortlist's own copy is only the
// fallback: a goal renamed since scoring shows its current name, while an item
// whose goal row is gone still renders under a neutral heading instead of
// breaking the page. Best-effort throughout — a failed goal read leaves every
// item on the fallback rather than blanking the feed.
async function withGoalTitles<T extends { goalId: string | null; goal: string }>(
  items: T[]
): Promise<(T & { goalTitle: string })[]> {
  const titleById = new Map<string, string>();
  try {
    // Any status, not just active: an item attributed to a goal that has since
    // been completed or archived still deserves its real name.
    const goals = await getGoals();
    for (const g of goals) titleById.set(g.id, g.title);
    // getGoals() hides archived rows; ask for those too so a goal that was
    // archived after scoring is still named rather than silently neutralised.
    const archived = await getGoals("archived");
    for (const g of archived) titleById.set(g.id, g.title);
  } catch {
    // No titles available: every item falls back below.
  }

  return items.map((r) => {
    const fromDb = r.goalId ? titleById.get(r.goalId) : undefined;
    const title = fromDb?.trim() || r.goal?.trim() || NO_GOAL_TITLE;
    return { ...r, goalTitle: title };
  });
}

// GET /api/feed -> { shortlist, saved, interests, prefs }
export async function GET() {
  try {
    const [shortlist, interests, prefs] = await Promise.all([
      buildShortlist(),
      getInterests(),
      loadPrefs(),
    ]);

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
