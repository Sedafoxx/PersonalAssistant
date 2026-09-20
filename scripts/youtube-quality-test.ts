// Checks for the YouTube quality layer (2026-09-20).
//
// The complaint that produced it: "those items in the feed have sometimes an
// interesting title but are very poor quality videos". Measured in the stored
// pool: a salary-negotiation video with 2,465 views had scored 5/5 — the TOP of
// the feed — while a video from a 464k-subscriber channel sat at 3.
//
// Everything here is PURE, so this runs in the cheap tier (no model call, no
// network). The samples are real strings from the stored rows, not invented ones:
// a parser tested only on text it likes is a parser that will fail on the day it
// matters.
//
// Run: npm run youtube:test  (or the cheap tier of npm run test:fast)
import { parseCount, parseYouTubeStats, iso8601Seconds, youTubeId } from "../src/lib/feed-sources";
import { qualityCap, compactCount } from "../src/lib/feed";

let failed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
}

/** A video row for the cap, with only the fields the cap reads. */
const vid = (view_count: number | null, channel_subs: number | null = null) => ({
  kind: "video" as const,
  view_count,
  channel_subs,
});

function main(): void {
  console.log("YouTube quality layer\n");

  // --- 1. the number parser -------------------------------------------------
  check("parseCount: '2,465' → 2465", parseCount("2,465") === 2465, String(parseCount("2,465")));
  check("parseCount: '1.2M' → 1200000", parseCount("1.2M") === 1200000, String(parseCount("1.2M")));
  check("parseCount: '478K' → 478000", parseCount("478K") === 478000, String(parseCount("478K")));
  check("parseCount: '1.5B' → 1500000000", parseCount("1.5B") === 1500000000, String(parseCount("1.5B")));
  check("parseCount: 'no digits' → null", parseCount("no digits here") === null);
  check("parseCount: a bare number is not a count", parseCount("2026-02-23") === null, String(parseCount("2026-02-23")));

  // --- 2. the page-text parser, on REAL stored snippets --------------------
  const salary = parseYouTubeStats(
    "Exact Salary Negotiation Script to Get a $10K+ Raise in 2026 | ### Description 2,465 views Posted: 2026-02-23"
  );
  check("page text: 2,465 views found (the item that scored 5)", salary.views === 2465, String(salary.views));

  const leader = parseYouTubeStats(
    "First-Time Leader? 5 Tips on How to Lead a Team Effectively | ce Lee 464000 subscribers 1344 likes 48110 views 10 Nov 2021"
  );
  check(
    "page text: subs, likes and views together",
    leader.subs === 464000 && leader.likes === 1344 && leader.views === 48110,
    `${leader.views} views / ${leader.likes} likes / ${leader.subs} subs`
  );

  const tiny = parseYouTubeStats("Read more books (consistently) in 2021 — 982 subscribers · 228 views");
  check("page text: a tiny channel is read as tiny", tiny.views === 228 && tiny.subs === 982, `${tiny.views}/${tiny.subs}`);

  const none = parseYouTubeStats("How to Read Better | [3:35] but this also means that you need to go slowly at first");
  check(
    "page text: no counts → UNKNOWN, never 0",
    none.views === null && none.likes === null && none.subs === null,
    `${none.views}/${none.likes}/${none.subs}`
  );

  // --- 3. ISO-8601 durations (the API's format) ---------------------------
  check("duration 'PT12M30S' → 750s", iso8601Seconds("PT12M30S") === 750, String(iso8601Seconds("PT12M30S")));
  check("duration 'PT1H2M3S' → 3723s", iso8601Seconds("PT1H2M3S") === 3723, String(iso8601Seconds("PT1H2M3S")));
  check("duration 'PT45S' → 45s", iso8601Seconds("PT45S") === 45, String(iso8601Seconds("PT45S")));
  check("duration garbage → null", iso8601Seconds("13:39") === null, String(iso8601Seconds("13:39")));

  // --- 4. ids -------------------------------------------------------------
  check(
    "youTubeId: read from a watch url",
    youTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === "dQw4w9WgXcQ",
    String(youTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
  );
  check("youTubeId: a channel url has none", youTubeId("https://youtube.com/@someone") === null);

  // --- 5. the cap: the rule the rubric cannot be trusted to apply ---------
  const complaint = qualityCap(vid(2465, null), 5);
  check("cap: 2,465 views, unknown channel → 2 (was 5)", complaint.score === 2, `→ ${complaint.score} (${complaint.why})`);
  check("cap: and it says why, in the reason", /2,?465 views/.test(complaint.why), complaint.why);
  check("cap: 228 views from 982 subs → 1", qualityCap(vid(228, 982), 3).score === 1);
  check("cap: 48,110 views from 464k subs → NOT capped", qualityCap(vid(48110, 464000), 3).score === 3);
  check("cap: 300k views, channel unknown → not capped", qualityCap(vid(300000, null), 4).score === 4);
  check("cap: UNKNOWN views → never capped (unmeasured is not bad)", qualityCap(vid(null, null), 5).score === 5);
  check("cap: a low score is left alone, never raised", qualityCap(vid(500, 100), 1).score === 1);
  check("cap: articles and podcasts are untouched", qualityCap({ kind: "article", view_count: 3, channel_subs: 3 }, 5).score === 5);
  check("cap: 4k views from a 5k channel → 2", qualityCap(vid(4000, 5000), 4).score === 2);
  check("cap: 4k views from a 900k channel → kept (a big channel's older video)", qualityCap(vid(4000, 900000), 4).score === 4);

  // --- 6. the compact form shown to the model ----------------------------
  check("compactCount: 2465 → 2.5k", compactCount(2465) === "2.5k", compactCount(2465));
  check("compactCount: 464000 → 464k", compactCount(464000) === "464k", compactCount(464000));
  check("compactCount: 1_200_000 → 1.2M", compactCount(1200000) === "1.2M", compactCount(1200000));
  check("compactCount: 950 stays 950", compactCount(950) === "950", compactCount(950));

  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
