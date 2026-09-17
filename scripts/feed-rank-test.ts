// Smoke test for Nova's feed, step P5a: the GOAL feed's ranked shortlist.
// Run: npm run feed:rank
//   (= node --env-file=.env.local --import tsx scripts/feed-rank-test.ts)
//
// Prints the shortlist GROUPED BY GOAL — that grouping IS the deliverable, so
// the "goal feed, not news feed" claim is visible rather than merely asserted.
//
// Two kinds of check run here, deliberately through ONE code path:
//   - the calibration cases (the plan's own test cases) and the junk titles that
//     defeated the old keyword gate are pushed through scoreCandidates() as
//     SYNTHETIC candidates — the same function buildShortlist() uses — so the
//     test judges the real ranker and not a copy of it, and so it works on a
//     database whose rows may since have been cleaned up;
//   - the invariants of the surfaced list are re-implemented INDEPENDENTLY below
//     (token overlap, per-kind minute estimates, the 1-5 range), so those
//     assertions are checks rather than tautologies that re-run the module's own
//     helpers and always agree with them.
import {
  buildShortlist,
  loadRankGoals,
  scoreCandidates,
  getInterests,
  type FeedItem,
  type Shortlist,
  type RankedItem,
} from "../src/lib/feed";
import { spotifyStatus } from "../src/lib/feed-sources";
import { createServiceClient } from "../src/lib/supabase";

// --- independent re-implementations -----------------------------------------

// The near-duplicate measure, re-derived here rather than imported: Jaccard
// overlap of lowercased non-stopword tokens of >= 4 characters. If the module
// changes its threshold or its stopword list, this check must NOT follow it.
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
// a guess, never presented as exact; the point of the check is that the reported
// total is the sum of these, not a number of its own.
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

// --- report -----------------------------------------------------------------

// The shortlist, grouped by the goal each item was attributed to. The goal is
// the unit of the feed now, so the printed list is keyed on it: an item whose
// goal were null could not be printed here at all, which is exactly why the
// assertion below requires one.
function printShortlist(shortlist: Shortlist, interestText: Map<string, string>) {
  console.log("=== SHORTLIST — grouped by goal ===================================");
  console.log(
    `${shortlist.items.length} item(s) · about ${Math.round(shortlist.minutes)} min ` +
      `of a ${shortlist.budgetMinutes} min awareness budget` +
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
      `no-goal/threshold not surfaced · low-score=${shortlist.droppedLowScore} ` +
      `diversity=${shortlist.droppedDiversity}`
  );
  console.log("");

  // Group by GOAL, preserving the order in which the best-scoring items appear
  // (items arrive score-descending), so the strongest goal leads.
  const byGoal = new Map<string, RankedItem[]>();
  for (const r of shortlist.items) {
    const key = r.goal || "(no goal — must not happen)";
    const list = byGoal.get(key) ?? [];
    list.push(r);
    byGoal.set(key, list);
  }

  let n = 0;
  for (const [goal, items] of byGoal) {
    const goalMinutes = items.reduce((sum, r) => sum + estimateMinutes(r.item), 0);
    console.log(`GOAL: ${goal}  (${items.length} item(s) · ~${Math.round(goalMinutes)} min)`);
    for (const r of items) {
      n++;
      const interest = r.item.matched_interest_id
        ? interestText.get(r.item.matched_interest_id) ?? "(unknown)"
        : "(none)";
      console.log(`  ${n}. [${r.score}] ${r.item.title}`);
      console.log(`       because ${r.reason}`);
      console.log(
        `       ${kindLabel(r.item)} · ${r.item.platform}` +
          `${r.item.creator ? ` · ${r.item.creator}` : ""} · bucket: ${r.bucket}`
      );
      console.log(`       interest: ${interest} · goal id: ${r.goalId ?? "(none)"}`);
      console.log(`       ${r.item.url}`);
    }
    console.log("");
  }
  if (!shortlist.items.length) {
    console.log("  (nothing surfaced — that is everything worth reading today.)");
    console.log("");
  }
  console.log("===================================================================");
}

// --- the calibration + junk probes ------------------------------------------

// A synthetic candidate the source never stored, shaped like a stored row. The
// id is a marker only: nothing is written to feed_items for these.
function probeItem(title: string, kind: FeedItem["kind"], platform: string): FeedItem {
  return {
    id: `synthetic:${title}`,
    url: `https://example.invalid/${encodeURIComponent(title)}`,
    kind,
    platform,
    title,
    summary: null,
    creator: null,
    published_at: null,
    duration_seconds: null,
    image_url: null,
    validated: true,
    matched_interest_id: null,
    status: "new",
    surfaced_day: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  let failed = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
  };

  // The id of the feedback row the not-for-me assertion inserts, so it is the
  // PROBE that gets cleaned up and never any real feedback the user left on the
  // same item. Deleted whatever happens, including on a thrown error.
  let probeFeedbackRowId: string | null = null;

  try {
    // One line, first thing: whether Spotify is configured AND whether its
    // token endpoint actually answers. Without it, a feed full of `apple`
    // podcasts looks identical whether the keys are absent or refused.
    const spotify = await spotifyStatus();
    console.log(
      `SPOTIFY  configured=${spotify.configured} token=${spotify.token} — ${spotify.detail}`
    );

    const db = createServiceClient();

    // The configured cap and budget, read here so the test compares against the
    // real values rather than constants it made up.
    const { data: prefs } = await db
      .from("feed_prefs")
      .select("daily_count,daily_minutes")
      .eq("id", 1)
      .maybeSingle();
    const dailyCount = Number(prefs?.daily_count ?? 6) || 6;
    const dailyMinutes = Number(prefs?.daily_minutes ?? 45) || 45;

    const interests = await getInterests(false);
    const interestText = new Map(interests.map((i) => [i.id, i.text]));

    const shortlist = await buildShortlist();
    printShortlist(shortlist, interestText);

    // --- calibration: the plan's own two test cases -------------------------
    //
    // Pushed through scoreCandidates — the SAME function buildShortlist calls —
    // so this is the real ranker being judged, not a re-implementation of it.
    const goals = await loadRankGoals();
    const probeTitles = ["Basics of Vibe Coding Explained", "Best 6 Tennisballmaschinen"];
    const probes: FeedItem[] = [
      probeItem(probeTitles[0], "video", "youtube"),
      probeItem(probeTitles[1], "article", "web"),
    ];
    const probeResult = await scoreCandidates(probes, goals, { interestText });
    const byTitle = new Map(probeResult.scored.map((s) => [s.item.title, s]));

    console.log("");
    console.log("--- calibration cases (scored through scoreCandidates) ---");
    for (const title of probeTitles) {
      const s = byTitle.get(title);
      const goal = s?.goalId ? s.goal : "(no goal)";
      console.log(
        `${s ? `[${s.score}]` : "[omitted]"} ${title} · goal: ${goal}` +
          `${s?.reason ? ` · because ${s.reason}` : ""}`
      );
    }
    console.log("");

    // 1. 'Basics of Vibe Coding Explained' is BELOW his level: at most 2.
    const vibe = byTitle.get(probeTitles[0]);
    check(
      `calibration: "${probeTitles[0]}" scores <= 2`,
      !!vibe && vibe.score <= 2,
      vibe ? `score ${vibe.score}` : "omitted (counts as <= 2 only if truly dropped)"
    );

    // 2. 'Best 6 Tennisballmaschinen' is gear/top-N content: at most 2...
    const tennis = byTitle.get(probeTitles[1]);
    check(
      `calibration: "${probeTitles[1]}" scores <= 2`,
      !!tennis && tennis.score <= 2,
      tennis ? `score ${tennis.score}` : "omitted"
    );
    // ...and it never clears the threshold, so it cannot be surfaced. The
    // threshold is 3, applied here rather than imported, so this stays a check.
    const MIN_SURFACED_SCORE = 3;
    check(
      `calibration: "${probeTitles[1]}" is not surfaced (score < ${MIN_SURFACED_SCORE})`,
      !tennis || tennis.score < MIN_SURFACED_SCORE,
      tennis ? `score ${tennis.score}` : "omitted — never surfaced"
    );

    // --- the junk that survived the old lexical gate ------------------------
    //
    // These are the three REAL rows that used to defeat the keyword gate, and
    // they are written in here EXACTLY as they appeared in feed_items — verbatim
    // titles, including the German/French and the shouting. They are pushed
    // through the same scoreCandidates() as synthetic candidates rather than
    // read back from the table, because the point is what the ranker DOES with
    // this wording, not whether the row still happens to exist: the ingest no
    // longer filters, so a row that was rejected may well have been cleaned up,
    // and a title that scores <= 2 must fail here either way. A keyword list
    // cannot tell these from a genuine interest; meaning can.
    const junkProbes: { label: string; title: string; kind: FeedItem["kind"]; platform: string }[] = [
      {
        label: "pickleball episode (was let through by 'tennis')",
        title:
          "PKP Ep. 37 Skill Ratings, Tournament Pickleball, the IPTPA, Tips for Advanced Players",
        kind: "podcast",
        platform: "spotify",
      },
      {
        label: "TO CATCH A CHEATER (was let through by 'sport' bait)",
        title: "TO CATCH A CHEATER: Why Is Her Boyfriend Secretly Booking a Hotel Every Week?!",
        kind: "video",
        platform: "youtube",
      },
      {
        label: "French tennis video (was let through by 'tennis')",
        title: "Comment TROUVER des PARTENAIRES au TENNIS",
        kind: "video",
        platform: "youtube",
      },
    ];

    const junkItems = junkProbes.map((j) => probeItem(j.title, j.kind, j.platform));
    const junkScored = await scoreCandidates(junkItems, goals, { interestText });
    const junkById = new Map(junkScored.scored.map((s) => [s.item.id, s]));

    console.log("--- junk that survived the old lexical gate (synthetic, verbatim titles) ---");
    for (let i = 0; i < junkProbes.length; i++) {
      const { label, title } = junkProbes[i];
      const s = junkById.get(junkItems[i].id);
      const goal = s?.goalId ? s.goal : "(no goal)";
      console.log(
        `${s ? `[${s.score}]` : "[omitted]"} ${label}\n` +
          `     ${title} · goal: ${goal}` +
          `${s?.reason ? ` · because ${s.reason}` : ""}`
      );
    }
    console.log("");

    for (let i = 0; i < junkProbes.length; i++) {
      const label = junkProbes[i].label;
      const s = junkById.get(junkItems[i].id);
      check(
        `junk rejected on meaning: ${label} scores <= 2`,
        !s || s.score <= 2,
        s ? `score ${s.score}` : "omitted by the model (not surfaced)"
      );
    }

    // The stored row as it really is: score/reason are columns feed_items has and
    // the FeedItem type does not carry, so the raw shape is typed here rather
    // than forced back through the module's type. Read only for the legacy-scale
    // check at the end: the table is what the UI reads.
    type StoredRow = FeedItem & { score?: number | null };
    const { data: allItems, error: itemsErr } = await db
      .from("feed_items")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (itemsErr) throw new Error(itemsErr.message);
    const stored = (allItems ?? []) as StoredRow[];

    // --- the surfaced list's invariants -------------------------------------

    // 3. Every surfaced score is an INTEGER 1..5 — no legacy 0-100 value.
    //    Deliberately a literal range here rather than the module's constants.
    const badScale = shortlist.items.filter(
      (r) => !Number.isInteger(r.score) || r.score < 1 || r.score > 5
    );
    check(
      "every surfaced score is an integer in 1..5 (no legacy 0-100 value)",
      badScale.length === 0,
      badScale.map((r) => `${r.item.title} (${r.score})`).join("; ") ||
        `${shortlist.items.length} item(s) on the 1-5 scale`
    );

    // 4. Every surfaced item has a non-null goal it was attributed to.
    const goalless = shortlist.items.filter((r) => !r.goalId || !r.goal || !r.goal.trim());
    check(
      "every surfaced item has a non-null attributed goal",
      goalless.length === 0,
      goalless.map((r) => r.item.title).join("; ") ||
        `${new Set(shortlist.items.map((r) => r.goal)).size} distinct goal(s)`
    );

    // 5. Nothing below the threshold is surfaced.
    const belowThreshold = shortlist.items.filter((r) => r.score < MIN_SURFACED_SCORE);
    check(
      `every surfaced item scores >= ${MIN_SURFACED_SCORE} (nothing below is surfaced)`,
      belowThreshold.length === 0,
      belowThreshold.map((r) => `${r.item.title} (${r.score})`).join("; ") ||
        `min ${Math.min(5, ...shortlist.items.map((r) => r.score))}`
    );

    // 6. The list is groupable by goal: every surfaced item names a goal, and
    //    grouping loses nothing (every item lands in exactly one bucket).
    const grouped = new Map<string, number>();
    for (const r of shortlist.items) {
      grouped.set(r.goal, (grouped.get(r.goal) ?? 0) + 1);
    }
    const groupedTotal = [...grouped.values()].reduce((a, b) => a + b, 0);
    check(
      "the surfaced list is groupable by goal (every item lands in one group)",
      shortlist.items.length === 0 ||
        (grouped.size >= 1 && groupedTotal === shortlist.items.length &&
          shortlist.items.every((r) => !!r.goal)),
      `${grouped.size} group(s): ` +
        [...grouped.entries()].map(([g, n]) => `${g} x${n}`).join("; ")
    );

    // 7. The cap from feed_prefs holds.
    check(
      "items.length <= feed_prefs.daily_count",
      shortlist.items.length <= dailyCount,
      `${shortlist.items.length} of ${dailyCount}`
    );

    // 8. No two titles are the same, and none is a near-duplicate of another.
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

    // 9. Every surfaced item has a why.
    const reasonless = shortlist.items.filter((r) => !r.reason || !r.reason.trim());
    check(
      "every surfaced item has a non-empty reason",
      reasonless.length === 0,
      reasonless.map((r) => r.item.title).join("; ") ||
        `${shortlist.items.length} reason(s)`
    );

    // 10. The reported minutes are the sum of the per-kind estimates, and the
    //     budget is reported as AWARENESS, never as a limit.
    const summed = shortlist.items.reduce((sum, r) => sum + estimateMinutes(r.item), 0);
    const delta = Math.abs(summed - shortlist.minutes);
    check(
      "reported minutes equals the sum of the per-item estimates",
      delta < 0.01,
      `reported ${shortlist.minutes.toFixed(2)}, summed ${summed.toFixed(2)}`
    );
    check(
      "the budget is reported as awareness with nothing blocked by it",
      // The budget is the user's own preference and droppedBudget stays 0: no
      // item is ever dropped FOR BEING LONG.
      shortlist.budgetMinutes === dailyMinutes && shortlist.droppedBudget === 0,
      `budget ${shortlist.budgetMinutes} min (feed_prefs), droppedBudget ${shortlist.droppedBudget}` +
        (shortlist.minutes > shortlist.budgetMinutes
          ? `, over by ${Math.round(shortlist.minutes - shortlist.budgetMinutes)} min — awareness, not a lock`
          : "")
    );

    // 11. An item the user answered 'not for me' never comes back. Insert a real
    //     feedback row against a surfaced item, rebuild, and require it gone.
    //     Cleanup names the PROBE row by id — never every row for that item — so
    //     a real 'not for me' the user already left is not erased by the test.
    if (shortlist.items.length) {
      const probeItemId = shortlist.items[0].item.id;
      const { data: fbRow, error: fbErr } = await db
        .from("feed_feedback")
        .insert({ item_id: probeItemId, signal: "not_for_me" })
        .select("id")
        .maybeSingle();
      if (fbErr) throw new Error(fbErr.message);
      probeFeedbackRowId = (fbRow as { id: string } | null)?.id ?? null;
      const rebuilt = await buildShortlist();
      const stillThere = rebuilt.items.some((r) => r.item.id === probeItemId);
      check(
        "an item answered 'not for me' never appears again",
        !stillThere,
        stillThere ? `still surfaced: ${probeItemId}` : "absent after rebuild"
      );
      if (probeFeedbackRowId) {
        const { error: delErr } = await db
          .from("feed_feedback")
          .delete()
          .eq("id", probeFeedbackRowId);
        if (delErr) console.log(`  [cleanup] failed to remove probe feedback: ${delErr.message}`);
      }
      probeFeedbackRowId = null;
    } else {
      check("an item answered 'not for me' never appears again", false, "no item to probe");
    }

    // 12. A legacy 0-100 value anywhere in the SURFACED day would mean the two
    //     scales had mixed. Checked against the stored rows too, not just the
    //     in-memory list, because the table is what the UI reads.
    const legacy = stored.filter((it) => typeof it.score === "number" && it.score > 5);
    check(
      "no stored row carries a legacy 0-100 score",
      legacy.length === 0,
      legacy.length
        ? `${legacy.length} row(s), e.g. ${legacy[0].title} (${legacy[0].score})`
        : "none above 5"
    );
  } catch (err) {
    console.error("ERROR", (err as Error).message);
    failed++;
  } finally {
    // Never leave the probe feedback row behind, even on a thrown error.
    if (probeFeedbackRowId) {
      try {
        const db = createServiceClient();
        await db.from("feed_feedback").delete().eq("id", probeFeedbackRowId);
      } catch {
        // best-effort cleanup
      }
    }
  }

  console.log(failed === 0 ? "\nALL RANK CHECKS PASSED" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
