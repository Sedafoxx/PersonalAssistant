import { NextResponse } from "next/server";
import {
  buildShortlist,
  getInterests,
  deriveInterests,
  discoverCandidates,
  saveCandidates,
  withGoalTitles,
  type DiscoveryStats,
} from "@/lib/feed";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// The daily refresh (P3b), and the fourth cron entry.
//
// GET and POST run the SAME thing: a Vercel cron can only issue a GET, so the
// schedule and a manual `curl` must not be two different code paths.
//
// Every stage is best-effort and independently recoverable, because this runs
// unattended at 07:00 and a thrown error would be a blank page rather than an
// old feed:
//   1. derive interests only when none are active — the derived set is stable
//      and re-deriving nightly would churn it for no gain;
//   2. discover for the day's rotating interests (discoverCandidates rotates by
//      day-of-year, so the same handful is not searched every morning);
//   3. save the validated candidates;
//   4. rebuild the shortlist;
//   5. stamp feed_prefs.last_refresh_at.
// A failure at any one of them still returns the shortlist that exists.

interface RefreshStage {
  ok: boolean;
  detail: string;
}

async function runRefresh() {
  const stages: Record<string, RefreshStage> = {};
  const stats: DiscoveryStats = {
    tavilyCalls: 0,
    found: 0,
    validated: 0,
    rejectedValidation: 0,
    rejectedRelevance: 0,
  };
  let inserted = 0;

  // 1. Interests. Derivation is the expensive model call, so it is skipped when
  // there is already something to search — an empty active set (first run, or
  // everything retired) is the only case that needs it.
  let interests = [] as Awaited<ReturnType<typeof getInterests>>;
  try {
    interests = await getInterests();
    if (!interests.some((i) => i.kind === "topic")) {
      const derived = await deriveInterests();
      interests = derived.interests;
      stages.derive = {
        ok: true,
        detail:
          `no active topic interests, so interests were derived: ` +
          `${derived.created} created, ${derived.updated} updated, ${derived.retired} retired`,
      };
    } else {
      stages.derive = {
        ok: true,
        detail: `${interests.length} active interest(s) already present — derivation skipped`,
      };
    }
  } catch (err) {
    stages.derive = { ok: false, detail: (err as Error).message };
  }

  // 2 + 3. Discovery, then persistence. The two share a stage because a save
  // without a discovery (or the reverse) is not a state worth reporting.
  try {
    if (!interests.length) throw new Error("no interests to search");
    const discovery = await discoverCandidates(interests);
    Object.assign(stats, discovery.stats);
    const saved = await saveCandidates(discovery.candidates, new Map(interests.map((i) => [i.id, i.id])));
    inserted = saved.inserted;
    stages.discover = {
      ok: true,
      detail:
        `${discovery.stats.validated}/${discovery.stats.found} candidate(s) validated, ` +
        `${saved.inserted} new row(s) stored`,
    };
  } catch (err) {
    stages.discover = { ok: false, detail: (err as Error).message };
  }

  // 4. The shortlist is rebuilt unconditionally: it re-ranks whatever is in the
  // table, so a failed discovery step strengthens the existing list rather than
  // withholding it.
  let shortlist = null as Awaited<ReturnType<typeof buildShortlist>> | null;
  try {
    shortlist = await buildShortlist();
    // The same goal-title resolution /api/feed does, through the same function.
    // The tab renders the refresh response DIRECTLY, so without this every item
    // would come back with goalTitle undefined and the goal headings — the whole
    // unit of the feed — would disappear until the page was reloaded.
    shortlist.items = await withGoalTitles(shortlist.items);
    stages.shortlist = { ok: true, detail: `${shortlist.items.length} item(s) surfaced` };
  } catch (err) {
    stages.shortlist = { ok: false, detail: (err as Error).message };
  }

  // 5. The timestamp is written last, so a partially failed refresh is not
  // advertised as complete. A failed stamp changes no outcome for the caller.
  try {
    const db = createServiceClient();
    const now = new Date().toISOString();
    const { error } = await db
      .from("feed_prefs")
      .update({ last_refresh_at: now })
      .eq("id", 1);
    if (error) throw new Error(error.message);
    stages.stamp = { ok: true, detail: now };
  } catch (err) {
    stages.stamp = { ok: false, detail: (err as Error).message };
  }

  // `ok` means the refresh was complete; the feed itself is returned either way,
  // so a discovery outage is visible in the report and never fatal to the page.
  const ok = Object.values(stages).every((s) => s.ok);
  return {
    ok,
    stages,
    interests: interests.map((i) => ({ id: i.id, text: i.text, kind: i.kind, weight: i.weight })),
    stats: { ...stats, inserted },
    shortlist,
  };
}

// GET /api/feed/refresh — the cron path.
export async function GET() {
  try {
    return NextResponse.json(await runRefresh());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/feed/refresh — the same refresh, for a manual trigger.
export async function POST() {
  return GET();
}
