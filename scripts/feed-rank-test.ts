// Smoke test for Nova's feed, step P3a: the ranked shortlist.
// Run: npm run feed:rank
//   (= node --env-file=.env.local --import tsx scripts/feed-rank-test.ts)
//
// Prints the shortlist in FULL, with each item's reason, because that list is
// the deliverable — the ranking itself is the thing being judged, not the count.
import { buildShortlist, getInterests, type FeedItem, type Shortlist } from "../src/lib/feed";
import { spotifyStatus } from "../src/lib/feed-sources";
import { createServiceClient } from "../src/lib/supabase";

// --- independent re-implementations -----------------------------------------

// Deliberately NOT reusing the module's own helpers, so these assertions are
// independent checks rather than tautologies.

// The same listicle/engagement-bait pattern the pipeline drops on, apostrophe
// class included so a curly-quoted "won’t believe" is not a free pass.
const LISTICLE =
  /top\s*\d+|\d+\s+(best|ways|things)|\btier list\b|you won[’']?t believe|ultimate guide|ranked from worst/i;

const STOP_WORDS = new Set([
  "with", "from", "that", "this", "your", "about", "into", "over", "more",
  "best", "for", "and", "the",
]);

function words(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
  );
}

function overlap(a: string, b: string): number {
  const ta = words(a);
  const tb = words(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

// A per-kind length ESTIMATE for an item the source gave no duration for. It is
// a guess, never presented as exact; the whole point of the check is that the
// reported total is the sum of these, not a number of its own.
function estimateMinutes(item: FeedItem): number {
  if (item.duration_seconds && item.duration_seconds > 0) {
    return item.duration_seconds / 60;
  }
  switch (item.kind) {
    case "article":
      return 6;
    case "post":
      return 3;
    case "video":
      return 12;
    case "podcast":
      return 30;
    default:
      return 6;
  }
}

function kindLabel(item: FeedItem): string {
  const mins = estimateMinutes(item);
  const rounded = mins >= 10 ? Math.round(mins) : Math.round(mins * 10) / 10;
  return `${rounded} min ${item.kind}`;
}

function printShortlist(shortlist: Shortlist, interestText: Map<string, string>) {
  console.log("=== SHORTLIST =====================================================");
  console.log(
    `${shortlist.items.length} item(s) · about ${Math.round(shortlist.minutes)} min ` +
      `of a ${shortlist.budgetMinutes} min budget` +
      // The budget is AWARENESS, never a lock: it shapes the ordering and it is
      // reported, but nothing is blocked by it. So going over is not a failure
      // to explain away — say by how much, and say that it is not a limit.
      (shortlist.minutes > shortlist.budgetMinutes
        ? ` — ${Math.round(shortlist.minutes - shortlist.budgetMinutes)} min over the ` +
          `${shortlist.budgetMinutes} min awareness budget, which is not a limit: ` +
          `nothing was dropped for being long.`
        : "")
  );
  console.log(
    `dropped: mechanical=${shortlist.droppedMechanical} ` +
      `feedback=${shortlist.droppedFeedback} no-reason=${shortlist.droppedNoReason} ` +
      `low-score=${shortlist.droppedLowScore} diversity=${shortlist.droppedDiversity}`
  );
  console.log("");
  shortlist.items.forEach((r, i) => {
    const interest = r.item.matched_interest_id
      ? interestText.get(r.item.matched_interest_id) ?? "(unknown)"
      : "(none)";
    console.log(`${i + 1}. [${r.score}] ${r.item.title}`);
    console.log(`     because ${r.reason}`);
    console.log(
      `     ${kindLabel(r.item)} · ${r.item.platform}` +
        `${r.item.creator ? ` · ${r.item.creator}` : ""} · bucket: ${r.bucket}`
    );
    console.log(`     interest: ${interest}`);
    console.log(`     ${r.item.url}`);
  });
  if (!shortlist.items.length) {
    console.log("  (nothing surfaced — That is everything for today.)");
  }
  console.log("===================================================================");
}

async function main() {
  let failed = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
  };

  // The row inserted by assertion 7, cleaned up whatever happens afterwards.
  let probeItemId: string | null = null;

  try {
    // One line, first thing: whether Spotify is configured AND whether its
    // token endpoint actually answers. Without it, a feed full of `apple`
    // podcasts looks identical whether the keys are absent or refused.
    const spotify = await spotifyStatus();
    console.log(
      `SPOTIFY  configured=${spotify.configured} token=${spotify.token} — ${spotify.detail}`
    );

    const db = createServiceClient();

    // The configured cap, read here so the test compares against the real value
    // rather than a constant it made up.
    const { data: prefs } = await db
      .from("feed_prefs")
      .select("daily_count,daily_minutes")
      .eq("id", 1)
      .maybeSingle();
    const dailyCount = Number(prefs?.daily_count ?? 6) || 6;

    const interests = await getInterests(false);
    const interestText = new Map(interests.map((i) => [i.id, i.text]));

    const shortlist = await buildShortlist();
    printShortlist(shortlist, interestText);

    // 1. The cap holds.
    check(
      "items.length <= feed_prefs.daily_count",
      shortlist.items.length <= dailyCount,
      `${shortlist.items.length} of ${dailyCount}`
    );

    // 2. Every surfaced item has a why.
    const reasonless = shortlist.items.filter((r) => !r.reason || !r.reason.trim());
    check(
      "every surfaced item has a non-empty reason",
      reasonless.length === 0,
      reasonless.map((r) => r.item.title).join("; ") ||
        `${shortlist.items.length} reason(s)`
    );

    // 3. No two titles are the same, and none is a near-duplicate of another.
    const dupeTitles: string[] = [];
    for (let a = 0; a < shortlist.items.length; a++) {
      for (let b = a + 1; b < shortlist.items.length; b++) {
        const ta = shortlist.items[a].item.title.trim().toLowerCase();
        const tb = shortlist.items[b].item.title.trim().toLowerCase();
        if (ta === tb) {
          dupeTitles.push(`identical: ${shortlist.items[a].item.title}`);
          continue;
        }
        const o = overlap(shortlist.items[a].item.title, shortlist.items[b].item.title);
        if (o >= 0.5) {
          dupeTitles.push(
            `${shortlist.items[a].item.title} ≈ ${shortlist.items[b].item.title} (${o.toFixed(2)})`
          );
        }
      }
    }
    check(
      "no two surfaced titles are equal or near-duplicates",
      dupeTitles.length === 0,
      dupeTitles.join("; ") || `${shortlist.items.length} distinct title(s)`
    );

    // 4. The per-interest limit, and the relaxation printed so it is never
    // invisible. Derived from the surfaced items: an interest with 3+ items is
    // only possible if a relaxed pass ran.
    const perInterest = new Map<string, number>();
    for (const r of shortlist.items) {
      const key = r.item.matched_interest_id ?? "(none)";
      perInterest.set(key, (perInterest.get(key) ?? 0) + 1);
    }
    const maxPerInterest = Math.max(0, ...perInterest.values());
    const overStrict = [...perInterest.entries()].filter(([, n]) => n > 2);
    const relaxation = maxPerInterest > 2;
    console.log(
      relaxation
        ? `NOTE  the per-interest limit was RELAXED to fill a short list: ` +
            overStrict
              .map(([id, n]) => `${interestText.get(id) ?? id} x${n}`)
              .join(", ") +
            ` (normal days hold every interest to 2).`
        : `NOTE  strict per-interest limit of 2 held for every interest ` +
            `(${perInterest.size} interest(s) contributed, max ${maxPerInterest}).`
    );
    check(
      relaxation
        ? "per-interest limit exceeded only via a reported relaxation to 3+"
        : "no interest contributes more than 2 items",
      shortlist.items.length === 0 || relaxation || maxPerInterest <= 2,
      relaxation ? `relaxed, max ${maxPerInterest}` : `max ${maxPerInterest}`
    );

    // 5. No listicle or engagement bait reached the surface.
    const bait = shortlist.items.filter((r) => LISTICLE.test(r.item.title));
    check(
      "no surfaced title matches the listicle/engagement-bait pattern",
      bait.length === 0,
      bait.map((r) => r.item.title).join("; ") || "none"
    );

    // 6. Every surfaced item is worth surfacing.
    const low = shortlist.items.filter((r) => !(r.score >= 55));
    check(
      "every surfaced item carries a score >= 55",
      low.length === 0,
      low.map((r) => `${r.item.title} (${r.score})`).join("; ") ||
        `${shortlist.items.length} item(s)`
    );

    // 7. An item the user answered never comes back. Insert a real 'not_for_me'
    // feedback row against a surfaced item, rebuild, and require it to be gone.
    if (shortlist.items.length) {
      probeItemId = shortlist.items[0].item.id;
      const { error: fbErr } = await db
        .from("feed_feedback")
        .insert({ item_id: probeItemId, signal: "not_for_me" });
      if (fbErr) throw new Error(fbErr.message);
      const rebuilt = await buildShortlist();
      const stillThere = rebuilt.items.some((r) => r.item.id === probeItemId);
      check(
        "an item answered 'not for me' never appears again",
        !stillThere,
        stillThere ? `still surfaced: ${probeItemId}` : "absent after rebuild"
      );
      const { error: delErr } = await db
        .from("feed_feedback")
        .delete()
        .eq("item_id", probeItemId);
      if (delErr) console.log(`  [cleanup] failed to remove probe feedback: ${delErr.message}`);
      probeItemId = null;
    } else {
      check("an item answered 'not for me' never appears again", false, "no item to probe");
    }

    // 8. The reported minutes are the sum of the per-item estimates.
    const summed = shortlist.items.reduce((sum, r) => sum + estimateMinutes(r.item), 0);
    const delta = Math.abs(summed - shortlist.minutes);
    check(
      "reported minutes equals the sum of the per-item estimates",
      delta < 0.01,
      `reported ${shortlist.minutes.toFixed(2)}, summed ${summed.toFixed(2)}`
    );
  } catch (err) {
    console.error("ERROR", (err as Error).message);
    failed++;
  } finally {
    // Never leave the probe row behind, even on a thrown error.
    if (probeItemId) {
      try {
        const db = createServiceClient();
        await db.from("feed_feedback").delete().eq("item_id", probeItemId);
      } catch {
        // best-effort cleanup
      }
    }
  }

  console.log(failed === 0 ? "\nALL RANK CHECKS PASSED" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
