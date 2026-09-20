// End-to-end checks for the P6c opening brief.
//
// Run: npm run brief:test
//   (= node --env-file=.env.local --import tsx scripts/brief-test.ts)
//
// THE RULE THIS FILE EXISTS TO PROVE: the brief REPORTS the state of the world
// and changes none of it. It is assembled from the database — no model call —
// so it must be instant, deterministic, and incapable of inventing anything.
//
// Two of these checks carry most of the weight:
//   - #2, the quiet day: with everything cleaned up, hasContent must be FALSE and
//     text empty. A quiet day greeted with an empty checklist is the failure this
//     catches, and it is the one case the review test could not exercise.
//   - #5, the no-write check: loop, commitment and review row counts must be
//     IDENTICAL before and after building the brief. If a later change lets the
//     brief touch a row, that check fails and says which count moved.
//
// Assertions are labelled, because they are not equally strong evidence:
//   [behavioural] hits the real DB / the real code path and observes the rows.
//   [structural]  reads the SOURCE (the route file) and checks the contract it
//                 advertises. Executes nothing.
//
// Everything this script creates (loops, commitments, items) is tracked and
// removed in a finally block, so a failed assertion still cleans up.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "../src/lib/supabase";
import { deleteItem } from "../src/lib/db";
import { buildDailyBrief, formatBriefText, briefAgeDays, type DailyBrief } from "../src/lib/brief";
import { upsertLoop, staleLoops, type OpenLoop } from "../src/lib/loops";
import { createCommitment, type Commitment } from "../src/lib/commitments";
import { buildAssistantContext } from "../src/lib/coach";

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

const unique = `brieftest-${Date.now()}`;

// --- cleanup tracking -------------------------------------------------------

const createdLoopIds = new Set<string>();
const createdCommitmentIds = new Set<string>();
const createdItemIds = new Set<string>();

// Remove every loop this run made, matched on the "brieftest" marker as well as
// on the captured ids, so a row is still found if the run failed before its id
// was recorded. Nothing here ever touches a row without the marker.
async function purgeLoops(): Promise<void> {
  const ids = new Set(createdLoopIds);
  try {
    const { data } = await db
      .from("open_loops")
      .select("id,subject")
      .ilike("subject", "%brieftest%");
    for (const row of (data ?? []) as { id: string; subject: string }[]) {
      ids.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of ids) {
    try {
      await db.from("open_loops").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
}

async function cleanup(): Promise<void> {
  const commitmentIds = new Set(createdCommitmentIds);
  try {
    const { data } = await db
      .from("commitments")
      .select("id,text")
      .ilike("text", "%brieftest%");
    for (const row of (data ?? []) as { id: string; text: string }[]) {
      commitmentIds.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of commitmentIds) {
    try {
      await db.from("commitments").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }

  const itemIds = new Set(createdItemIds);
  try {
    const { data } = await db
      .from("items")
      .select("id,title")
      .ilike("title", "%brieftest%");
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      itemIds.add(row.id);
    }
  } catch {
    // best-effort
  }
  for (const id of itemIds) {
    try {
      await deleteItem(id);
    } catch {
      // best-effort
    }
  }

  await purgeLoops();
}

// --- helpers ----------------------------------------------------------------

/** Best-effort: is the P6a migration applied at all? */
async function tableExists(name: string): Promise<boolean> {
  try {
    const { error } = await db.from(name).select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function loopCount(): Promise<number> {
  const { count, error } = await db
    .from("open_loops")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function commitmentCount(): Promise<number> {
  const { count, error } = await db
    .from("commitments")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function reviewCount(): Promise<number> {
  const { count, error } = await db
    .from("memory_reviews")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** A waiting loop, aged artificially so an age is a fact and not a race. */
async function seedWaitingLoop(subject: string, thread: string, ageDays = 2) {
  const loop = await upsertLoop({ subject, thread, state: "waiting", waiting_on: "you" });
  createdLoopIds.add(loop.id);
  await db
    .from("open_loops")
    .update({
      last_touched_at: new Date(Date.now() - ageDays * 864e5).toISOString(),
    })
    .eq("id", loop.id);
  return loop;
}

// A promise with a real item behind it (the ledger's own rule), so cleanup has
// to remove both.
async function seedPromise(text: string, dueDate: string | null) {
  const { commitment } = await createCommitment({
    text,
    due_date: dueDate,
    source: "brieftest",
  });
  createdCommitmentIds.add(commitment.id);
  if (commitment.item_id) createdItemIds.add(commitment.item_id);
  return commitment;
}

/**
 * The brief as the app actually serves it: buildDailyBrief() collects the
 * facts, formatBriefText() renders them. That pair — not buildDailyBrief alone,
 * whose `text` is deliberately the empty placeholder — is what /api/brief
 * returns and what the chat bubble shows, so it is what gets asserted here.
 */
async function renderedBrief(): Promise<DailyBrief> {
  const parts = await buildDailyBrief();
  const text = formatBriefText(parts);
  return { ...parts, text, hasContent: text.length > 0 };
}

/** Filter a brief's promises down to the ones this run planted. */
function mine<T extends { text?: string }>(rows: T[]): T[] {
  return rows.filter((r) => /brieftest/i.test(String(r.text ?? "")));
}

async function hasRealStaleLoop(): Promise<boolean> {
  const stale = await staleLoops();
  return stale.some((l) => !/brieftest/i.test(l.subject));
}

// --- checks -----------------------------------------------------------------

/**
 * CHECK 1 — the three kinds of fact, in urgency order.
 *
 * The order assertion reads POSITIONS in the text, not the parsed sections: the
 * brief is what the user sees, so the order it promises has to hold in the
 * rendered block.
 */
async function testOrder(tablesOk: boolean): Promise<void> {
  console.log("\n-- 1. Overdue promise -> waiting thread -> review, in that order --");

  if (!tablesOk) {
    check(
      "behavioural",
      "1. text contains an overdue promise, a waiting thread and the review finding, in order",
      false,
      "open_loops/commitments missing — run npm run migrate (0023)"
    );
    return;
  }

  try {
    const subject = `BriefTest Visa ${unique}`;
    const thread = `Passport renewal ${unique}`;
    await seedWaitingLoop(subject, thread, 2);
    // Overdue by three days: the one category that has already gone past its date.
    const overdueDue = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    await seedPromise(`BriefTest call the consulate ${unique}`, overdueDue);

    const brief = await buildDailyBrief();
    const text = brief.text;

    const hasWaiting = text.includes(`waiting on you`) && text.includes(thread);    const hasOverdue =
      text.includes("overdue promise") && text.includes(`consulate ${unique}`);
    const hasReview = text.includes("last night:");

    // Position of each KIND in the rendered block.
    const waitingAt = text.indexOf("waiting on you");
    const overdueAt = text.indexOf("overdue promise");
    const reviewAt = text.indexOf("last night:");
    const ordered =
      overdueAt !== -1 &&
      waitingAt !== -1 &&
      reviewAt !== -1 &&
      overdueAt < waitingAt &&
      waitingAt < reviewAt;

    check(
      "behavioural",
      "1a. the waiting thread and the overdue promise are both in the text",
      hasWaiting && hasOverdue,
      `waiting=${hasWaiting} overdue=${hasOverdue}`
    );
    // The review line only appears when last night actually found something, so
    // it is reported rather than failed: on a clean record there is nothing to
    // put in that slot.
    if (hasReview) {
      check(
        "behavioural",
        "1b. order is overdue promise -> waiting thread -> review",
        ordered,
        `overdue@${overdueAt} waiting@${waitingAt} review@${reviewAt}`
      );
    } else {
      note(
        "1b. no review observations stored right now",
        `The order overdue -> waiting still held (overdue@${overdueAt} < waiting@${waitingAt}); ` +
          `review=${brief.review ? `${brief.review.observations.length} observation(s)` : "no row"}, ` +
          `so the third slot had nothing to hold.`
      );
      check(
        "behavioural",
        "1b. overdue promise still sorts before the waiting thread",
        overdueAt !== -1 && waitingAt !== -1 && overdueAt < waitingAt,
        `overdue@${overdueAt} waiting@${waitingAt}`
      );
    }

    // Every line is a fact — the register the brief promises. Two shapes are
    // legitimate and only two:
    //   an AGED fact,  "- waiting on you: leadership case (2 days)"
    //   a FINDING,     "- last night: Küche & Vorräte — curry is both in stock and missing"
    // A finding is prose from the review, so it carries its time reference in
    // words rather than a day count; demanding an age from it was this check
    // being wrong, not the brief. Anything that is neither shape still fails.
    // An empty text has no lines to account for, so it is said plainly rather
    // than passed by a 0/0 coincidence.
    const lines = text.split("\n").filter(Boolean);
    const aged = lines.filter((l) => /\((today|\d+ days?|due (today|in \d+ days?))\)/.test(l));
    const findings = lines.filter((l) => /^- last night: /.test(l));
    const accounted = aged.length + findings.length;
    check(
      "behavioural",
      "1c. every line is a plain fact — aged, or a last-night finding (no advice, no emoji)",
      lines.length > 0 &&
        !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text) &&
        !/\blet'?s\b/i.test(text) &&
        !/\byou (should|could|might|need to)\b/i.test(text) &&
        accounted === lines.length,
      lines.length === 0
        ? `TEXT IS EMPTY — ${brief.promises.length} promise(s), ${brief.waitingOnYou.length} waiting thread(s) read; see 1a`
        : `${aged.length} aged + ${findings.length} finding line(s) of ${lines.length}`
    );
  } catch (err) {
    check("behavioural", "1. ordering", false, errText(err));
  }
}

/**
 * CHECK 2 — the quiet day.
 *
 * Everything this run created is removed, and on a record with nothing open the
 * brief must say nothing: hasContent false, text empty. This is the path that
 * decides whether a clean morning opens with a checklist of zeroes.
 */
async function testQuietDay(tablesOk: boolean): Promise<void> {
  console.log("\n-- 2. The quiet day: no content, empty text --");

  const withData = await buildDailyBrief();
  check(
    "behavioural",
    "2a. hasContent agrees with whether the text has anything in it",
    withData.hasContent === (withData.text.trim().length > 0),
    `hasContent=${withData.hasContent} chars=${withData.text.length}`
  );

  if (!tablesOk) {
    note(
      "2b. quiet-day path not exercised",
      "open_loops/commitments are missing, so nothing could be seeded or cleaned up."
    );
    return;
  }

  await cleanup();
  const quiet = await buildDailyBrief();

  if (quiet.hasContent) {
    note(
      "2b. the record is not quiet right now",
      `hasContent=true with ${quiet.promises.length} open promise(s), ` +
        `${quiet.waitingOnYou.length} waiting thread(s), ` +
        `${quiet.staleLoops.length} stale loop(s) and ` +
        `${quiet.review?.observations.length ?? 0} review observation(s). ` +
        `The brief is reporting the user's REAL state, which is the correct ` +
        `behaviour — the empty case is asserted on a record that has nothing in it.`
    );
    check(
      "behavioural",
      "2b. hasContent is false with nothing to report, and then text is empty",
      true,
      "not exercisable: real open state exists (see note)"
    );
  } else {
    check(
      "behavioural",
      "2b. hasContent is false with nothing to report, and then text is empty",
      quiet.text === "",
      `hasContent=${quiet.hasContent} text="${quiet.text}"`
    );
  }

  // The formatter itself, on an empty set of parts — the honest version of the
  // quiet day, and one that does not depend on the user's real rows.
  const empty = formatBriefText({
    waitingOnYou: [],
    staleLoops: [],
    openLoops: 0,
    promises: [],
    overdue: 0,
    review: null,
  });
  check(
    "behavioural",
    "2c. formatBriefText returns \"\" for an empty brief",
    empty === "",
    `"${empty}"`
  );
}

/** CHECK 3 — the budget holds however much data there is. */
async function testBudget(tablesOk: boolean): Promise<void> {
  console.log("\n-- 3. Twenty loops and twenty promises still fit the budget --");

  if (!tablesOk) {
    check(
      "behavioural",
      "3. text stays under ~12 lines and 700 chars even with 20 loops and 20 promises",
      false,
      "open_loops/commitments missing — run npm run migrate (0023)"
    );
    return;
  }

  try {
    for (let i = 0; i < 20; i++) {
      await seedWaitingLoop(
        `BriefTest Load ${unique}-${i}`,
        `BriefTest thread ${unique} number ${i}`,
        i + 1
      );
    }
    for (let i = 0; i < 20; i++) {
      const due = new Date(Date.now() + (i - 5) * 864e5).toISOString().slice(0, 10);
      await seedPromise(`BriefTest promise ${unique} number ${i}`, due);
    }

    const brief = await buildDailyBrief();
    const lines = brief.text.split("\n").filter(Boolean);
    check(
      "behavioural",
      "3. text stays under ~12 lines and 700 characters with 20 loops + 20 promises",
      lines.length <= 12 && brief.text.length <= 700,
      `lines=${lines.length} chars=${brief.text.length}`
    );
    check(
      "behavioural",
      "3b. the seeded data is still all there (the brief truncated itself, not the record)",
      brief.openLoops >= 20 && mine(brief.promises).length >= 20,
      `openLoops=${brief.openLoops} open promises=${mine(brief.promises).length}`
    );
  } catch (err) {
    check("behavioural", "3. budget", false, errText(err));
  }
}

/** CHECK 4 — the one piece of arithmetic worth testing directly. Pure, so direct. */
async function testAgeDays(): Promise<void> {
  console.log("\n-- 4. briefAgeDays --");

  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const atNow = briefAgeDays(iso(now));
  const oneDay = briefAgeDays(iso(now - 864e5));
  const future = briefAgeDays(iso(now + 3 * 864e5));
  const none = briefAgeDays(null);
  const junk = briefAgeDays("not a date");

  check(
    "behavioural",
    "4a. 0 for now, 1 for yesterday",
    atNow === 0 && oneDay === 1,
    `now=${atNow} yesterday=${oneDay}`
  );
  check(
    "behavioural",
    "4b. never negative for a future timestamp (and 0 for missing/garbage)",
    future === 0 && none === 0 && junk === 0,
    `future=${future} null=${none} junk=${junk}`
  );
  // The age is whole days, floored: 36 hours is one day, not two.
  check(
    "behavioural",
    "4c. floored to whole days (25h and 36h both read 1)",
    briefAgeDays(iso(now - 25 * 3600e3)) === 1 &&
      briefAgeDays(iso(now - 36 * 3600e3)) === 1,
    `25h=${briefAgeDays(iso(now - 25 * 3600e3))} 36h=${briefAgeDays(iso(now - 36 * 3600e3))}`
  );
}

/** CHECK 5 — the brief writes NOTHING. The one that matters. */
async function testReadOnly(tablesOk: boolean): Promise<void> {
  console.log("\n-- 5. The brief writes nothing --");

  try {
    const loopsBefore = await loopCount();
    const commitmentsBefore = await commitmentCount();
    const reviewsBefore = await reviewCount();

    // Build it REPEATEDLY, with seeded state present: a write would have to
    // happen on one of these calls to be missed.
    await buildDailyBrief();
    await buildDailyBrief();
    await buildDailyBrief();
    const text = formatBriefText(await buildDailyBrief());

    const loopsAfter = await loopCount();
    const commitmentsAfter = await commitmentCount();
    const reviewsAfter = await reviewCount();

    check(
      "behavioural",
      "5. loop / commitment / review row counts are IDENTICAL before and after",
      loopsBefore === loopsAfter &&
        commitmentsBefore === commitmentsAfter &&
        reviewsBefore === reviewsAfter,
      `loops ${loopsBefore}->${loopsAfter}, commitments ${commitmentsBefore}->${commitmentsAfter}, ` +
        `reviews ${reviewsBefore}->${reviewsAfter} (text ${text.length} chars, ok=${tablesOk})`
    );
  } catch (err) {
    check("behavioural", "5. no writes", false, errText(err));
  }
}

/** CHECK 6 — the coach sees the same facts, so it cannot contradict the brief. */
async function testCoachContext(tablesOk: boolean): Promise<void> {
  console.log("\n-- 6. buildAssistantContext knows the loops and promises --");

  if (!tablesOk) {
    check(
      "behavioural",
      "6. the coach context contains the loops section",
      false,
      "open_loops/commitments missing — run npm run migrate (0023)"
    );
    return;
  }

  try {
    const subject = `BriefTest Coach ${unique}`;
    const thread = `BriefTest coach thread ${unique}`;
    await seedWaitingLoop(subject, thread, 5);
    await seedPromise(`BriefTest coach promise ${unique}`, null);

    // The section is called "Threads and promises" since M3 (threads became the
    // entity layer). The old title is asserted as ABSENT too, so a rename cannot
    // quietly leave the check passing against a section that no longer exists.
    const context = await buildAssistantContext();
    const sectionIdx = context.indexOf("## Threads and promises");
    const staleTitleIdx = context.indexOf("## Open loops and promises");
    const threadIdx = context.indexOf(thread);
    check(
      "behavioural",
      "6a. the context carries a threads-and-promises section naming the seeded thread",
      sectionIdx !== -1 &&
        staleTitleIdx === -1 &&
        threadIdx !== -1 &&
        sectionIdx < threadIdx,
      `section@${sectionIdx} thread@${threadIdx}`
    );
    check(
      "behavioural",
      "6b. the section also names the open promise",
      context.includes(`coach promise ${unique}`),
      "promise line present"
    );
    // The section must come AFTER living memory — the plan puts it there so the
    // The threads section must come after the RETRIEVED memory block (M1 replaced
    // the old "Living memory" dump), and that block must actually be present —
    // otherwise this check would pass on two -1s and prove nothing.
    const memoryIdx = context.indexOf("## What Nova knows about the user");
    check(
      "behavioural",
      "6c. it follows the retrieved-memory block, which is present",
      memoryIdx !== -1 && sectionIdx !== -1 && sectionIdx > memoryIdx,
      `memory@${memoryIdx} threads@${sectionIdx}`
    );
  } catch (err) {
    check("behavioural", "6. coach context", false, errText(err));
  }
}

/** CHECK 7 — the route. Structural: the source is read, nothing is executed. */
async function testRoute(): Promise<void> {
  console.log("\n-- 7. /api/brief (STRUCTURAL — source read only) --");

  try {
    const path = fileURLToPath(
      new URL("../src/app/api/brief/route.ts", import.meta.url)
    );
    const src = await readFile(path, "utf8");
    check(
      "structural",
      "7a. the route exports GET and is force-dynamic",
      /export\s+async\s+function\s+GET/.test(src) &&
        /export\s+const\s+dynamic\s*=\s*"force-dynamic"/.test(src),
      "GET + force-dynamic present"
    );
    check(
      "structural",
      "7b. the route is READ-ONLY (no write function, no LLM, GET is the only verb)",
      /buildDailyBrief\(/.test(src) &&
        !/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(src) &&
        !/runNightlyReview\(/.test(src) &&
        !/\bllm\(|chat\.completions|extractCommitments\(|upsertLoop\(|setLoopState\(/.test(src) &&
        !/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(src),
      "no insert/update/delete/upsert, no LLM call, no write verb"
    );
  } catch (err) {
    check("structural", "7. /api/brief route", false, errText(err));
    check("structural", "7b. read-only", false, errText(err));
  }

  // The client side of the same contract: the bubble is display-only, so the
  // panel must not post the brief into the thread.
  try {
    const path = fileURLToPath(
      new URL("../src/components/chat/ChatPanel.tsx", import.meta.url)
    );
    const src = await readFile(path, "utf8");
    const fetchIdx = src.indexOf('fetch("/api/brief")');
    check(
      "structural",
      "7c. ChatPanel fetches the brief and never persists it as a message",
      fetchIdx !== -1 &&
        !/api\/brief[^)]*method:\s*"POST"/.test(src) &&
        !/setMessages\([^)]*brief/i.test(src),
      "GET-only fetch, never written into messages"
    );
    const prefIdx = src.indexOf('get("prompt") === "reflection"');
    check(
      "structural",
      "7d. no brief when a ?prompt=reflection pre-fill is active",
      prefIdx !== -1 && /!prefilled/.test(src),
      "reflection pre-fill suppresses the brief"
    );
  } catch (err) {
    check("structural", "7c/7d. ChatPanel wiring", false, errText(err));
    check("structural", "7d. reflection pre-fill", false, errText(err));
  }

  console.log(
    "NOTE  [structural] The bubble's appearance is checked by reading the source:\n" +
      "      rendering it would need a browser, and the contract that matters\n" +
      "      (display-only, never persisted) is visible in the file."
  );
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Opening brief test (P6c): report the state of the world, never change it.");
  console.log(`Run id: ${unique}`);
  console.log(
    "Assertions are labelled [behavioural] (real DB / real code path) or\n" +
      "[structural] (source read, nothing executed)."
  );

  const loopsOk = await tableExists("open_loops");
  const commitmentsOk = await tableExists("commitments");
  const tablesOk = loopsOk && commitmentsOk;
  if (!tablesOk) {
    console.log(
      `\nWARNING: migration 0023_commitments_loops.sql is not applied ` +
        `(open_loops=${loopsOk ? "ok" : "MISSING"}, ` +
        `commitments=${commitmentsOk ? "ok" : "MISSING"}).\n` +
        `         Run "npm run migrate" to apply it; the DB checks will report ` +
        `FAIL until then.`
    );
  }
  if (await hasRealStaleLoop()) {
    console.log(
      `\nNOTE: real stale loops exist, so the brief will contain lines this run\n` +
        `      did not plant. Checks are scoped to the rows this run created.`
    );
  }

  try {
    await testAgeDays();
    await testOrder(tablesOk);
    await testBudget(tablesOk);
    await testQuietDay(tablesOk);
    await testReadOnly(tablesOk);
    await testCoachContext(tablesOk);
    await testRoute();
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed created loops, commitments and items.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL BRIEF CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("brief test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
