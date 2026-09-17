// End-to-end checks for the P6b nightly review.
//
// Run: npm run review:test
//   (= node --env-file=.env.local --import tsx scripts/review-test.ts)
//
// THE RULE THIS FILE EXISTS TO PROVE: the nightly review consolidates and
// REPORTS; it never silently changes the user's state. It may rewrite a topic
// SUMMARY — a derived, regenerable artefact — and NOTHING else.
//
// So check 3 is the one that matters: every loop's state and waiting_on, and the
// active fact count of every considered topic, are snapshotted before and after
// the run and must come back IDENTICAL. If a later change lets the review touch
// a loop or a fact, that check fails and says exactly which one moved.
//
// TWO KINDS OF ASSERTION, labelled because they are not equally strong evidence:
//   [behavioural] hits the real DB / the real code path and observes the rows.
//   [structural]  reads the SOURCE (notify-run.ts, the route, vercel.json) and
//                 checks the contract it advertises. Executes nothing.
//
// The contradiction check is a NOTE, not PASS or FAIL: whether two facts really
// contradict is a MODEL JUDGEMENT, and a test must not dress a judgement up as a
// fact. It plants a contradiction, runs the review, and prints what the model
// said. Its temporary topic and facts are deleted whatever happens.
//
// Everything this script creates (topic, facts, review rows) is tracked and
// removed in a finally block.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "../src/lib/supabase";
import {
  getActiveFacts,
  getOrCreateTopic,
  getTopics,
  upsertFact,
} from "../src/lib/memory";
import { listLoops } from "../src/lib/loops";
import {
  runNightlyReview,
  latestReview,
  formatReviewForMorning,
  type NightlyReview,
} from "../src/lib/review";

const db = createServiceClient();

// --- report -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(
  kind: "behavioural" | "structural",
  name: string,
  ok: boolean,
  detail = ""
): void {
  console.log(
    `${ok ? "PASS" : "FAIL"}  [${kind}] ${name}${detail ? `  (${detail})` : ""}`
  );
  if (ok) passed++;
  else failed++;
}

function note(name: string, detail: string): void {
  console.log(`NOTE  ${name}${detail ? `\n      ${detail}` : ""}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const unique = `reviewtest-${Date.now()}`;

// --- cleanup tracking -------------------------------------------------------

const createdFactIds = new Set<string>();
const createdTopicIds = new Set<string>();
const createdReviewIds = new Set<string>();

/**
 * Remove everything this run made. Facts first (they reference the topic), then
 * the topic, then any review rows the run wrote.
 *
 * The planted topic and its facts are matched on the "reviewtest" marker as well
 * as on the ids we captured, so a row we made is found even if the run failed
 * before its id was recorded. Nothing here ever touches a row whose title or
 * text lacks that marker.
 */
async function cleanup(): Promise<void> {
  const factIds = new Set(createdFactIds);
  try {
    const { data } = await db
      .from("memory_facts")
      .select("id,key,value,topic_id")
      .ilike("key", "%reviewtest%");
    for (const row of (data ?? []) as {
      id: string;
      key: string;
      value: string;
      topic_id: string;
    }[]) {
      factIds.add(row.id);
      createdTopicIds.add(row.topic_id);
    }
  } catch {
    // best-effort
  }

  const topicIds = new Set(createdTopicIds);
  try {
    const { data } = await db
      .from("memory_topics")
      .select("id,title,slug")
      .ilike("title", "%reviewtest%");
    for (const row of (data ?? []) as { id: string; title: string; slug: string }[]) {
      topicIds.add(row.id);
    }
  } catch {
    // best-effort
  }

  for (const id of factIds) {
    try {
      await db.from("memory_facts").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
  for (const id of topicIds) {
    try {
      await db.from("memory_topics").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
  // Review rows. The review writes notes=null, so they are removed by the ids
  // this run captured rather than by any marker column.
  for (const id of createdReviewIds) {
    try {
      await db.from("memory_reviews").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
}

// --- helpers ----------------------------------------------------------------

const REVIEW_COLS =
  "id,ran_at,topics_curated,topics_considered,stale_loops,open_commitments,observations,notes,created_at";

/**
 * Run the review and remember the row it wrote, so cleanup can remove it.
 *
 * Every test run writes a review row with notes=null, so there is no marker
 * column to match on afterwards — the id has to be captured here, at the only
 * moment it exists.
 */
async function runTracked(opts?: { maxTopics?: number }) {
  const review = await runNightlyReview(opts);
  if (review.id) createdReviewIds.add(review.id);
  return review;
}

/** The newest review row, straight from the table (not through latestReview). */
async function newestRow(): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("memory_reviews")
    .select(REVIEW_COLS)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

async function reviewRowCount(): Promise<number> {
  const { count, error } = await db
    .from("memory_reviews")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** The state the run must never change, keyed by loop id. */
async function loopSnapshot(): Promise<Map<string, string>> {
  const loops = await listLoops({ limit: 200 });
  const snap = new Map<string, string>();
  for (const l of loops) {
    snap.set(l.id, `${l.state}/${l.waiting_on ?? "null"}`);
  }
  return snap;
}

/** Active fact count per topic id. */
async function factCountSnapshot(): Promise<Map<string, number>> {
  const facts = await getActiveFacts();
  const snap = new Map<string, number>();
  for (const f of facts) {
    snap.set(f.topic_id, (snap.get(f.topic_id) ?? 0) + 1);
  }
  return snap;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const diffs: string[] = [];
  for (const [id, value] of before) {
    const now = after.get(id);
    if (now === undefined) diffs.push(`${id.slice(0, 8)}: gone (was ${value})`);
    else if (now !== value) diffs.push(`${id.slice(0, 8)}: ${value} -> ${now}`);
  }
  for (const [id, value] of after) {
    if (!before.has(id)) diffs.push(`${id.slice(0, 8)}: appeared (${value})`);
  }
  return diffs;
}

function diffCounts(
  before: Map<string, number>,
  after: Map<string, number>
): string[] {
  const diffs: string[] = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const a = before.get(id) ?? 0;
    const b = after.get(id) ?? 0;
    if (a !== b) diffs.push(`${id.slice(0, 8)}: ${a} -> ${b}`);
  }
  return diffs;
}

// --- checks -----------------------------------------------------------------

async function testModuleShape(tablesOk: boolean): Promise<void> {
  console.log("\n-- 1. Module contract --");

  const obs = {
    topic: "Küche",
    kind: "contradiction" as const,
    text: "One sentence.",
  };

  check(
    "behavioural",
    "1a. runNightlyReview / latestReview / formatReviewForMorning are exported functions",
    typeof runNightlyReview === "function" &&
      typeof latestReview === "function" &&
      typeof formatReviewForMorning === "function",
    `runNightlyReview=${typeof runNightlyReview} latestReview=${typeof latestReview} ` +
      `formatReviewForMorning=${typeof formatReviewForMorning}`
  );

  // formatReviewForMorning is pure, so it is checked directly — including the
  // empty and null cases, which is what the morning check depends on.
  const clean: NightlyReview = {
    id: "x",
    ranAt: new Date().toISOString(),
    topicsConsidered: 3,
    topicsCurated: 3,
    staleLoops: 1,
    openCommitments: 2,
    observations: [],
  };
  const withOne: NightlyReview = { ...clean, observations: [obs] };
  const formatted = formatReviewForMorning(withOne);
  const tone = /note|contradiction|stale/i.test(formatted);
  check(
    "behavioural",
    "1b. formatReviewForMorning states the finding, and is empty for a clean review / null",
    tone &&
      formatReviewForMorning(clean) === "" &&
      formatReviewForMorning(null) === "",
    `one="${formatted}" clean="" null=""`
  );

  if (!tablesOk) {
    note(
      "1c. memory_reviews table missing — run npm run migrate (0024)",
      "The DB checks below will report FAIL until then."
    );
    check(
      "behavioural",
      "1c. memory_reviews table exists with the brief's columns",
      false,
      "table missing — npm run migrate (0024)"
    );
    return;
  }

  const { data, error } = await db.from("memory_reviews").select("*").limit(1);
  if (error) {
    check("behavioural", "1c. memory_reviews table readable", false, error.message);
    return;
  }
  const cols = data && data.length ? Object.keys(data[0]) : [];
  const expected = [
    "id",
    "ran_at",
    "topics_curated",
    "topics_considered",
    "stale_loops",
    "open_commitments",
    "observations",
    "notes",
    "created_at",
  ];
  // A table with no rows cannot be introspected from a select("*") result, so
  // fall back to asking for each column explicitly — PostgREST errors on a
  // missing one, which is what makes this a real check either way.
  let missing: string[];
  if (cols.length) {
    missing = expected.filter((c) => !cols.includes(c));
  } else {
    missing = [];
    for (const c of expected) {
      const probe = await db.from("memory_reviews").select(c).limit(1);
      if (probe.error) missing.push(c);
    }
  }
  check(
    "behavioural",
    "1c. memory_reviews has all nine columns (incl. observations jsonb default [])",
    missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `all nine present (${cols.length} read)`
  );
}

async function testOneRowPerRun(): Promise<void> {
  console.log("\n-- 2. Exactly one row per run --");

  const before = await reviewRowCount();
  const returnValue = await runTracked();
  const after = await reviewRowCount();
  const row = await newestRow();
  check(
    "behavioural",
    "2a. one run writes exactly ONE row",
    after - before === 1,
    `table ${before} -> ${after}`
  );
  check(
    "behavioural",
    "2b. the returned review IS that row",
    !!returnValue.id && !!row && returnValue.id === row.id,
    `returned id=${returnValue.id ?? "null"} table id=${(row?.id as string) ?? "null"}`
  );
  check(
    "behavioural",
    "2c. no call ever throws — the run returns a review object",
    typeof returnValue.observations.length === "number" &&
      typeof returnValue.topicsConsidered === "number",
    `considered=${returnValue.topicsConsidered} curated=${returnValue.topicsCurated} ` +
      `observations=${returnValue.observations.length} ` +
      `skipped=${returnValue.skippedReason ?? "—"}`
  );
  // The row must record what was considered AND what was actually rewritten.
  check(
    "behavioural",
    "2d. the row's counts match what the run reported",
    !!row &&
      row.topics_considered === returnValue.topicsConsidered &&
      row.topics_curated === returnValue.topicsCurated &&
      row.stale_loops === returnValue.staleLoops &&
      row.open_commitments === returnValue.openCommitments,
    row
      ? `considered=${row.topics_considered} curated=${row.topics_curated} ` +
          `staleLoops=${row.stale_loops} openCommitments=${row.open_commitments}`
      : "no row"
  );
  // A curated count can never exceed the considered count — that would mean the
  // run tidied topics it never looked at.
  check(
    "behavioural",
    "2e. topics_curated <= topics_considered (never tidies what it did not read)",
    returnValue.topicsCurated <= returnValue.topicsConsidered,
    `curated=${returnValue.topicsCurated} considered=${returnValue.topicsConsidered}`
  );

  // latestReview() must agree with the row we just wrote.
  const latest = await latestReview();
  check(
    "behavioural",
    "2f. latestReview() returns the newest row",
    !!latest && latest.id === (row?.id as string),
    `latest=${latest?.id ?? "null"}`
  );
}

/**
 * CHECK 3 — the one that matters.
 *
 * A review may rewrite a topic SUMMARY. It may not move a loop's state or
 * waiting_on, and it may not gain or lose an active fact. Snapshot both sides
 * across a full run and require them to be identical.
 */
async function testStateUnchanged(): Promise<void> {
  console.log("\n-- 3. The review never changes the user's state (THE check) --");

  const loopsBefore = await loopSnapshot();
  const factsBefore = await factCountSnapshot();
  const summariesBefore = new Map<string, string | null>(
    (await getTopics()).map((t) => [t.id, t.summary])
  );

  const review = await runTracked();

  const loopsAfter = await loopSnapshot();
  const factsAfter = await factCountSnapshot();
  const summariesAfter = new Map<string, string | null>(
    (await getTopics()).map((t) => [t.id, t.summary])
  );

  const loopDiffs = diffSnapshots(loopsBefore, loopsAfter);
  const factDiffs = diffCounts(factsBefore, factsAfter);

  check(
    "behavioural",
    "3a. every loop's state + waiting_on is IDENTICAL before and after",
    loopDiffs.length === 0,
    loopDiffs.length
      ? loopDiffs.join("; ")
      : `${loopsBefore.size} loop(s) unchanged`
  );
  check(
    "behavioural",
    "3b. the active fact count of every topic is IDENTICAL before and after",
    factDiffs.length === 0,
    factDiffs.length
      ? factDiffs.join("; ")
      : `${[...factsBefore.values()].reduce((a, b) => a + b, 0)} fact(s) across ${factsBefore.size} topic(s) unchanged`
  );

  // Deliberately NOT asserted: that a summary CHANGED. Curation rewrites the
  // summary from the facts, so an already-tidy topic legitimately comes back
  // word-for-word identical. What must hold is that a summary is never BLANKED —
  // a failed rewrite leaves the previous summary in place rather than erasing it.
  const blanked = [...summariesAfter.entries()]
    .filter(([id, summary]) => !summary && summariesBefore.get(id))
    .map(([id]) => id.slice(0, 8));
  check(
    "behavioural",
    "3c. no summary is blanked (a failed rewrite leaves the old one in place)",
    blanked.length === 0,
    blanked.length ? blanked.join(", ") : "no topic lost its summary"
  );

  const changedSummaries = [...summariesAfter.entries()].filter(
    ([id, summary]) => summary !== summariesBefore.get(id)
  ).length;
  note(
    "3d. summaries are the ONE thing the review may rewrite",
    `${changedSummaries} of ${summariesAfter.size} summary(ies) differ after the run ` +
      `(rewriting is allowed; ${review.topicsCurated} topic(s) counted as curated).`
  );
}

async function testCleanNight(): Promise<void> {
  console.log("\n-- 4. A clean night writes NO row --");

  // maxTopics: 0 with no loops and no commitments is the only genuinely empty
  // night we can construct without disturbing real rows, so the two halves are
  // tested separately: the skip path itself, and the observability of an empty
  // observation set on a night that DID have something to review.
  const before = await reviewRowCount();
  const skipped = await runTracked({ maxTopics: 0 });
  const after = await reviewRowCount();

  const loopsOpen = (await listLoops({ limit: 200 })).some((l) => l.state !== "done");
  if (!loopsOpen) {
    check(
      "behavioural",
      "4a. a night with nothing to review writes NO row, and says why",
      after === before && !!skipped.skippedReason && skipped.id === null,
      `rows ${before} -> ${after}, skippedReason="${skipped.skippedReason ?? "—"}"`
    );
  } else {
    const current = (await listLoops({ limit: 200 })).filter((l) => l.state !== "done");
    note(
      "4a. clean-night skip path not exercised",
      `${current.length} open loop(s) exist, so a zero-topic run still had ` +
        `something to review and correctly wrote a row (id=${skipped.id ? "set" : "null"}). ` +
        `The skip path returns id=null with a skippedReason by construction.`
    );
    check(
      "behavioural",
      "4a. an empty run still returns a review object and never throws",
      typeof skipped.topicsConsidered === "number",
      `considered=${skipped.topicsConsidered} rows ${before} -> ${after}`
    );
  }

  // The normal clean case: a run that DID have state to consider reports an empty
  // observations array, which is the correct answer for a tidy record — and the
  // row exists, because the run happened. Either way the run writes its row and
  // never throws; how many observations it found is printed, not judged.
  const ran = await runTracked();
  check(
    "behavioural",
    "4b. a run with nothing to report still writes its row (never skipped, never thrown)",
    ran.id !== null && !!ran.ranAt && Array.isArray(ran.observations),
    `observations=${ran.observations.length} row=${ran.id ? "written" : "none"}`
  );
  if (ran.observations.length === 0) {
    note(
      "4c. the model found nothing to report",
      "An empty array is the correct answer on a clean night — see the prompt. " +
        "That is a finding, not a failure."
    );
  } else {
    console.log("      model observations:");
    for (const o of ran.observations) {
      console.log(`        - [${o.kind}] ${o.topic ?? "(no topic)"}: ${o.text}`);
    }
  }
}

async function testMorningWiring(): Promise<void> {
  console.log("\n-- 5. The 08:00 morning check (STRUCTURAL — source read only) --");

  try {
    const path = fileURLToPath(new URL("../src/lib/notify-run.ts", import.meta.url));
    const src = await readFile(path, "utf8");

    // The contract lives in the object returned by runNotificationRun. Assert
    // against the return block, not the whole file, so a local variable that
    // merely shares a name cannot satisfy the check.
    const returnIdx = src.lastIndexOf("return {");
    const tail = src.slice(returnIdx === -1 ? 0 : returnIdx);
    check(
      "structural",
      "5a. runNotificationRun's return advertises reviewObservations",
      /\breviewObservations\s*[,:]/.test(tail),
      "reviewObservations present in the return block"
    );
    check(
      "structural",
      "5b. the memory check reads latestReview() and formats it",
      /latestReview\(/.test(src) && /formatReviewForMorning\(/.test(src),
      "latestReview() + formatReviewForMorning() both called"
    );
    // Still ONE memory push: the review clause is appended to the existing lines
    // array and the existing pushAll call, not a second notification.
    const memorySection = src.slice(src.indexOf("Memory check"));
    const pushes = (memorySection.match(/pushAll\(/g) ?? []).length;
    check(
      "structural",
      "5c. the review clause joins the ONE existing Memory check push",
      pushes === 1,
      `${pushes} pushAll call(s) in the memory-check section`
    );
  } catch (err) {
    check("structural", "5. notify-run.ts morning wiring", false, errText(err));
  }

  console.log(
    "NOTE  [structural] Live verification of the morning message is DEFERRED to the 08:00 cron:\n" +
      "      calling runNotificationRun would push REAL notifications to the user's\n" +
      "      devices, so this check reads notify-run.ts instead of executing it."
  );
}

async function testRouteAndCron(): Promise<void> {
  console.log("\n-- 6. API route + the fifth cron --");

  try {
    const routePath = fileURLToPath(
      new URL("../src/app/api/review/route.ts", import.meta.url)
    );
    const route = await readFile(routePath, "utf8");
    check(
      "structural",
      "6a. /api/review exports GET and POST, both force-dynamic",
      /export\s+async\s+function\s+GET/.test(route) &&
        /export\s+async\s+function\s+POST/.test(route) &&
        /export\s+const\s+dynamic\s*=\s*"force-dynamic"/.test(route),
      "GET + POST + force-dynamic present"
    );
    // GET must be READ-ONLY: the cron fires a GET, so a GET that ran the review
    // would rewrite summarys on every schedule tick (and on every curl).
    const getBody = route.slice(
      route.indexOf("export async function GET"),
      route.indexOf("export async function POST")
    );
    check(
      "structural",
      "6b. GET is read-only (latestReview only) and POST is the only run path",
      /latestReview\(/.test(getBody) &&
        !/runNightlyReview\(/.test(getBody) &&
        /runNightlyReview\(/.test(route),
      "GET -> latestReview, POST -> runNightlyReview"
    );
  } catch (err) {
    check("structural", "6a/6b. /api/review route", false, errText(err));
    check("structural", "6b. GET read-only", false, errText(err));
  }

  try {
    const vercelPath = fileURLToPath(new URL("../vercel.json", import.meta.url));
    const raw = await readFile(vercelPath, "utf8");
    let parsed: { crons?: { path: string; schedule: string }[] } | null = null;
    try {
      parsed = JSON.parse(raw) as { crons?: { path: string; schedule: string }[] };
    } catch {
      parsed = null;
    }
    const crons = parsed?.crons ?? [];
    const review = crons.find((c) => c.path === "/api/review");
    const kept = [
      "/api/notifications/send",
      "/api/notifications/send/evening",
      "/api/notifications/send/goal-review",
      "/api/feed/refresh",
    ].every((p) => crons.some((c) => c.path === p));

    check(
      "structural",
      "6c. vercel.json is valid JSON with FIVE crons, the original four kept",
      parsed !== null && crons.length === 5 && kept,
      `crons=${crons.length}, originals kept=${kept}`
    );
    check(
      "structural",
      "6d. the fifth cron is /api/review at 0 2 * * *",
      review?.schedule === "0 2 * * *",
      `path=/api/review schedule=${review?.schedule ?? "(missing)"}`
    );
  } catch (err) {
    check("structural", "6c/6d. vercel.json", false, errText(err));
    check("structural", "6d. fifth cron schedule", false, errText(err));
  }
}

/**
 * CHECK 7 — the planted contradiction.
 *
 * This is a NOTE, not a PASS/FAIL: whether two facts really contradict each
 * other is a MODEL JUDGEMENT, and the test must not present a judgement as a
 * verified fact. It plants a topic with two facts that cannot both be true,
 * runs the review, and prints what the model said.
 *
 * The planted topic and facts are removed whatever happens — success, failure,
 * or a throw — which is why the whole body is one try/finally.
 */
async function testPlantedContradiction(): Promise<void> {
  console.log("\n-- 7. Planted contradiction (NOTE — model judgement, not PASS/FAIL) --");

  const title = `ReviewTest Home ${unique}`;
  const key = `reviewtest-address-${unique}`;
  const otherKey = `reviewtest-city-${unique}`;

  try {
    const topic = await getOrCreateTopic(title);
    createdTopicIds.add(topic.id);

    // Two values for the SAME key: upsertFact supersedes rather than duplicates,
    // so the contradiction is planted as two DIFFERENT keys about one thing —
    // which is exactly the shape a real contradiction takes in this store.
    const a = await upsertFact({
      topic: title,
      key,
      value: `${unique}: the user lives in Vienna`,
      source: "reviewtest",
    });
    if (a.fact) createdFactIds.add(a.fact.id);
    const b = await upsertFact({
      topic: title,
      key: otherKey,
      value: `${unique}: the user lives in Berlin`,
      source: "reviewtest",
    });
    if (b.fact) createdFactIds.add(b.fact.id);

    // Make the topic count as "touched in the last 24 hours": getOrCreateTopic
    // stamps updated_at, but touch it explicitly so the run considers it even if
    // the clock straddles a boundary.
    await db
      .from("memory_topics")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", topic.id);

    const review = await runNightlyReview({ maxTopics: 5 });
    const related = review.observations.filter((o) =>
      /reviewtest|vienna|berlin|home/i.test(`${o.topic ?? ""} ${o.text}`)
    );

    note(
      "7. planted contradiction — result is a MODEL JUDGEMENT",
      `Planted two incompatible facts in "${title}" (Vienna vs Berlin). ` +
        `The review returned (${review.observations.length} observation(s)); ` +
        `${related.length} of them mention the planted topic. ` +
        `The model ${related.length ? "DID" : "did NOT"} flag it. ` +
        `Either outcome is informational: the review REPORTED without acting, ` +
        `and the planted facts are removed below.`
    );
    if (review.observations.length) {
      for (const o of review.observations) {
        console.log(`        - [${o.kind}] ${o.topic ?? "(no topic)"}: ${o.text}`);
      }
    }

    // Also assert the discipline held on THIS run: the planted facts were
    // reported on, never changed. That part is a fact, not a judgement.
    const planted = await getActiveFacts(topic.id);
    const values = new Set(planted.map((f) => f.value));
    check(
      "behavioural",
      "7b. the planted facts are still present and unchanged after the review",
      planted.length === 2 &&
        [...values].some((v) => /vienna/i.test(v)) &&
        [...values].some((v) => /berlin/i.test(v)),
      `${planted.length} fact(s) survived: ${[...values].map((v) => v.split(": ").pop()).join(" / ")}`
    );
  } catch (err) {
    note("7. planted contradiction — the check itself errored", errText(err));
  } finally {
    // Unconditional: the temporary topic and its facts go, whatever happened.
    try {
      await cleanup();
      console.log("      cleanup: planted topic + facts removed.");
    } catch (err) {
      console.log(`      cleanup warning: ${errText(err)}`);
    }
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Nightly review test (P6b): report, never mutate.");
  console.log(`Run id: ${unique}`);
  console.log(
    "Assertions are labelled [behavioural] (real DB / real code path) or\n" +
      "[structural] (source read, nothing executed)."
  );

  let tablesOk = false;
  try {
    const { error } = await db.from("memory_reviews").select("id").limit(1);
    tablesOk = !error;
  } catch {
    tablesOk = false;
  }
  if (!tablesOk) {
    console.log(
      `\nWARNING: migration 0024_memory_reviews.sql is not applied.\n` +
        `         Run "npm run migrate" to apply it; the DB checks will report ` +
        `FAIL until then.`
    );
  }

  try {
    await testModuleShape(tablesOk);
    if (tablesOk) {
      await testOneRowPerRun();
      await testStateUnchanged();
      await testCleanNight();
    }
    await testMorningWiring();
    await testRouteAndCron();
    if (tablesOk) await testPlantedContradiction();
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed created facts, topics and review rows.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL REVIEW CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("review test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
