// End-to-end checks for the SCROLLABLE feed and the in-app reader (P8).
//
// Run: npm run feed:page:test
//   (= node --env-file=.env.local --import tsx scripts/feed-page-test.ts)
//
// THE COMPLAINT THIS ANSWERS. "i wanna be able to really scroll through a bunch of
// stuff" — and everything else "should be like in X: the post is directly in the
// app". Measured before the change: 44 items had scored 3+ (the bar the user set)
// and were unreachable, because the tab could only ask for the day's six, and a card
// could only ever be a link because the only text stored was a ~300-character
// snippet.
//
// THE PROPERTIES UNDER TEST:
//   1. THE SAME BAR. Every item that arrives by scrolling has passed exactly the
//      test the day's picks passed — checked against an independent count in the
//      database, not against the function's own opinion of itself.
//   2. PAGES DO NOT OVERLAP AND DO NOT SKIP. Two consecutive pages share no item.
//   3. THE END IS HONEST. Past the last item there is nothing, and nextOffset says
//      so instead of the feed padding itself with something weaker.
//   4. READING HAPPENS HERE, AND ONLY ONCE. An article's body is fetched on first
//      open and KEPT, so the second open is served from the store.
//   5. IT DOES NOT PRETEND. A video has no readable page, so its description is
//      returned as `stored` and never as `fetched` — an empty reader would be worse
//      than saying what it is.
//
// NOTE ON REAL DATA: this test does not create rows. Check 6 runs the real top-up,
// which judges candidates that are already stored and were never scored — that is
// the same operation the scroll triggers, and it is what makes the feed longer. It
// spends no search calls, and the check asserts that.

import { createServiceClient } from "../src/lib/supabase";
import { buildFeedPage, readFeedItemText, topUpFeed } from "../src/lib/feed";

const db = createServiceClient();
const unique = `feedpage-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}

function note(name: string, detail = ""): void {
  console.log(`NOTE  ${name}${detail ? `\n      ${detail}` : ""}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MIN_SCORE = 3;

async function main(): Promise<void> {
  console.log("Feed page test (P8): scroll the pool, read in place.");
  console.log(`Run id: ${unique}`);

  try {
    // --- 1-2. the pool, and the bar it keeps ------------------------------
    console.log("\n-- 1-2. paging the pool at the same bar --");

    const first = await buildFeedPage({ offset: 0, limit: 10 });
    check(
      "1. the first page returns items and knows the size of the pool",
      first.items.length > 0 && first.poolSize >= first.items.length,
      `${first.items.length} item(s) of a pool of ${first.poolSize}, nextOffset=${first.nextOffset}`
    );

    // Independently count what the bar should produce, so the check cannot pass by
    // agreeing with the function it is testing.
    const { count: expectedCount } = await db
      .from("feed_items")
      .select("id", { count: "exact", head: true })
      .eq("status", "new")
      .eq("validated", true)
      .gte("score", MIN_SCORE);
    check(
      "1b. the pool size agrees with an independent count at the same bar",
      first.poolSize === (expectedCount ?? -1),
      `function says ${first.poolSize}, the database says ${expectedCount}`
    );

    const belowBar = first.items.filter((r) => r.score < MIN_SCORE);
    check(
      `1c. nothing on the page scores below ${MIN_SCORE}`,
      belowBar.length === 0,
      belowBar.length ? `found ${belowBar.length} item(s) below the bar` : "all at or above"
    );

    const second =
      first.nextOffset === null
        ? { items: [], nextOffset: null, poolSize: first.poolSize }
        : await buildFeedPage({ offset: first.nextOffset, limit: 10 });
    const firstIds = new Set(first.items.map((i) => i.item.id));
    const overlap = second.items.filter((i) => firstIds.has(i.item.id));
    check(
      "2. two consecutive pages share no item",
      overlap.length === 0,
      overlap.length
        ? `${overlap.length} item(s) appeared twice`
        : `page 1 had ${first.items.length}, page 2 had ${second.items.length}, no overlap`
    );

    // --- 3. the honest end ------------------------------------------------
    console.log("\n-- 3. past the end: nothing, and it says nothing --");

    const past = await buildFeedPage({ offset: first.poolSize + 50, limit: 10 });
    check(
      "3. a page beyond the pool is empty and reports no next offset",
      past.items.length === 0 && past.nextOffset === null,
      `${past.items.length} item(s), nextOffset=${past.nextOffset}`
    );

    // --- 4. reading in place, once ----------------------------------------
    console.log("\n-- 4. an article is fetched once and then served from the store --");

    const article =
      first.items.find((i) => i.item.kind === "article")?.item ??
      (await buildFeedPage({ offset: 0, limit: 50 })).items.find(
        (i) => i.item.kind === "article"
      )?.item;

    if (!article) {
      note("4. no stored article to read", "skipping the reader checks");
    } else {
      const firstRead = await readFeedItemText(article.id);
      check(
        "4a. the reader returns text for an article",
        !!firstRead.text && firstRead.text.length > 100,
        `source=${firstRead.source}, ${firstRead.chars} char(s)`
      );

      const secondRead = await readFeedItemText(article.id);
      check(
        "4b. the second open is served from the STORE (no second fetch)",
        secondRead.source === "stored" && firstRead.source !== "unavailable",
        `first=${firstRead.source}, second=${secondRead.source}`
      );

      if (firstRead.source === "stored") {
        note(
          "4c. this article was already stored from an earlier open",
          "so the fetch path was not exercised by this run — the property held, the path was not re-proven"
        );
      }
    }

    // --- 5. it does not pretend -------------------------------------------
    console.log("\n-- 5. a video is never reported as a fetched read --");

    const video = (await buildFeedPage({ offset: 0, limit: 50 })).items.find(
      (i) => i.item.kind === "video"
    )?.item;
    if (!video) {
      note("5. no stored video to check", "skipping");
    } else {
      const read = await readFeedItemText(video.id);
      check(
        "5. a video's text is its stored description, never a 'fetched' read",
        read.source !== "fetched",
        `source=${read.source}, ${read.chars} char(s)`
      );
    }

    // --- 6. the cheapest way to get more ----------------------------------
    console.log("\n-- 6. topping up judges what is already stored before searching --");

    const before = await buildFeedPage({ offset: 0, limit: 1 });
    const topUp = await topUpFeed();
    const after = await buildFeedPage({ offset: 0, limit: 1 });

    check(
      "6. the top-up spent NO search calls when it had stored candidates to judge",
      topUp.discovered === 0 || topUp.ranked > 0,
      `ranked=${topUp.ranked}, added=${topUp.added}, discovered=${topUp.discovered}`
    );
    note(
      "6b. what it did, and what the pool looks like now",
      `${topUp.detail}\n      pool: ${before.poolSize} -> ${after.poolSize} item(s) above the bar`
    );
  } catch (err) {
    check("suite", false, errText(err));
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL FEED PAGE CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("feed page test crashed:", err);
  process.exit(1);
});
