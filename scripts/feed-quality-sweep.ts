// One-off sweep over the videos ALREADY in the pool: give them popularity
// numbers, then apply the quality cap to their stored scores.
//
// Why a sweep and not just the new discovery path: the complaint was about the
// feed he is looking at NOW. 81 videos were already stored and scored, and the
// salary-negotiation video was sitting at 5/5. Re-ranking them with a model would
// cost a real call per batch; the cap is deterministic, so it can be applied to
// the existing rows directly.
//
// Counts come from the same two sources as discovery: the Data API when
// YOUTUBE_API_KEY is set (all 81 at once, 2 quota units), else the page text
// Tavily stored as the summary (13 of 81 rows — measured).
//
// Nothing is deleted. A capped row keeps its original reason with the demotion
// appended, so a wrongly capped video can still be recognised as such.
//
// Run: npm run feed:quality            (dry run — prints what it would change)
//      npm run feed:quality -- --apply
import { createServiceClient } from "../src/lib/supabase";
import {
  parseYouTubeStats,
  youTubeId,
  youtubeVideoFacts,
  type YouTubeFacts,
} from "../src/lib/feed-sources";
import { qualityCap, compactCount } from "../src/lib/feed";

const APPLY = process.argv.includes("--apply");

interface Row {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  score: number | null;
  reason: string | null;
  view_count: number | null;
  channel_subs: number | null;
}

async function main(): Promise<void> {
  const db = createServiceClient();
  console.log(APPLY ? "APPLYING\n" : "DRY RUN (add --apply to write)\n");

  const { data, error } = await db
    .from("feed_items")
    .select("id,url,title,summary,score,reason,view_count,channel_subs")
    .eq("kind", "video");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  console.log(`videos in the pool: ${rows.length}`);

  // --- counts ----------------------------------------------------------------
  const ids = rows.map((r) => youTubeId(r.url)).filter((x): x is string => !!x);
  const facts: Record<string, YouTubeFacts> | null = await youtubeVideoFacts(ids);
  console.log(
    facts
      ? `YouTube Data API: exact counts for ${Object.keys(facts).length} of ${ids.length} id(s)`
      : "No YOUTUBE_API_KEY — falling back to the page text stored with each row.\n" +
        "      (A free key from Google Cloud → enable 'YouTube Data API v3' → API key gives\n" +
        "       exact counts for every video; set YOUTUBE_API_KEY in .env.local and Vercel.)"
  );

  let filled = 0;
  let capped = 0;
  const changes: string[] = [];

  for (const r of rows) {
    const id = youTubeId(r.url);
    const api = id && facts ? facts[id] : undefined;
    const fromText = parseYouTubeStats(`${r.title} ${r.summary ?? ""}`);
    const view_count = api?.views ?? fromText.views;
    const channel_subs = api?.subs ?? fromText.subs;

    const gained = view_count != null && r.view_count == null;
    if (gained) filled++;
    if (view_count !== r.view_count || channel_subs !== r.channel_subs) {
      if (APPLY) {
        await db
          .from("feed_items")
          .update({
            view_count,
            channel_subs,
            like_count: api?.likes ?? fromText.likes ?? null,
            comment_count: api?.comment_count ?? null,
            channel_name: api?.channel_name ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.id);
      }
    }

    if (r.score == null) continue;
    const cappedScore = qualityCap(
      {
        kind: "video",
        view_count: view_count ?? r.view_count,
        channel_subs: channel_subs ?? r.channel_subs,
      },
      r.score
    );
    if (cappedScore.why) {
      capped++;
      changes.push(
        `  ${r.score} → ${cappedScore.score}  ${compactCount(view_count ?? 0)} views` +
          `${channel_subs != null ? ` / ${compactCount(channel_subs)} subs` : ""}  "${r.title.slice(0, 60)}"`
      );
      if (APPLY) {
        const reason = String(r.reason ?? "").includes("demoted:")
          ? r.reason
          : `${r.reason ?? ""} [demoted: ${cappedScore.why}]`.trim();
        await db
          .from("feed_items")
          .update({ score: cappedScore.score, reason, updated_at: new Date().toISOString() })
          .eq("id", r.id);
      }
    }
  }

  console.log(`\ncounts: ${filled} row(s) gained a view count, ${Object.keys(facts ?? {}).length ? "from the API" : "from the page text"}`);
  console.log(`cap: ${capped} scored video(s) demoted below the 3+ bar${capped ? "" : " — nothing to demote"}`);
  if (changes.length) {
    console.log(capped > 12 ? "" : "\nwhat changes:");
    for (const c of changes.slice(0, 40)) console.log(c);
  }
  console.log(
    APPLY
      ? "\nDone. Capped items keep their original reason with the demotion appended, and nothing was deleted."
      : "\nNothing was written. Re-run with --apply."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
