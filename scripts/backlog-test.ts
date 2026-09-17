// End-to-end checks for the P7a backlog (the coach's ammunition).
//
// Run: npm run backlog:test
//   (= node --env-file=.env.local --import tsx scripts/backlog-test.ts)
//
// THE RULE THIS FILE EXISTS TO PROVE: the coach can SEE what has stalled and
// what is waiting. A milestone nothing has touched for two weeks, a todo the
// user captured but never put on a day, an idea never turned into a step — all
// of it must reach the model, in the context and through the tool.
//
// Two of these checks carry most of the weight:
//   - #1/#2 are a PAIR. A stalled milestone must appear; an identical milestone
//     that was touched yesterday must NOT. Asserting only the first would pass
//     for a "stalled" list that simply returns everything; the pair is what
//     makes the window real.
//   - #6 compares the TOOL's output to formatBacklogForContext on the SAME live
//     data, so the two can never drift into telling the model different things.
//
// Assertions are labelled, because they are not equally strong evidence:
//   [behavioural] hits the real DB / the real code path and observes the rows.
//   [structural]  reads the SOURCE (the registry) and checks the contract it
//                 advertises. Executes nothing.
//
// CHECK 7 is a NOTE, not PASS/FAIL. Plan quality is a MODEL JUDGEMENT, and a
// test must not dress a judgement up as a fact. It calls the real planner once,
// prints the full reply, and leaves the verdict to the reader — because a green
// check here would prove nothing but that formatting worked.
//
// Everything this script creates (a goal, milestones, items) is tracked and
// removed in a finally block, so a failed assertion still cleans up.

import { createServiceClient } from "../src/lib/supabase";
import { createGoal, deleteGoal } from "../src/lib/goals";
import { createItem } from "../src/lib/db";
import { createMilestone } from "../src/lib/milestones";
import { getBacklog, formatBacklogForContext, type Backlog } from "../src/lib/backlog";
import { buildCoachContext } from "../src/lib/coach";
import { TOOL_DEFINITIONS, executeTool } from "../src/lib/claude-tools";
import { runAssistant } from "../src/lib/chat";
import { localDay } from "../src/lib/day";

const db = createServiceClient();

// --- report -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(kind: "behavioural" | "structural", name: string, ok: boolean, detail = ""): void {
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

const unique = `backlogtest-${Date.now()}`;

// --- cleanup tracking -------------------------------------------------------

const createdItemIds = new Set<string>();
const createdMilestoneIds = new Set<string>();
const createdGoalIds = new Set<string>();

/**
 * Remove everything this run made. Items first (they reference the milestone),
 * then the milestones, then the goal. Rows are matched on the "backlogtest"
 * marker as well as the captured ids, so a row is still found if the run failed
 * before its id was recorded. Nothing here ever touches an unmarked row.
 */
async function cleanup(): Promise<void> {
  const itemIds = new Set(createdItemIds);
  try {
    const { data } = await db
      .from("items")
      .select("id,title")
      .ilike("title", "%backlogtest%");
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      itemIds.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of itemIds) {
    try {
      await db.from("items").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }

  const msIds = new Set(createdMilestoneIds);
  try {
    const { data } = await db
      .from("goal_milestones")
      .select("id,title")
      .ilike("title", "%backlogtest%");
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      msIds.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of msIds) {
    try {
      await db.from("goal_milestones").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }

  const goalIds = new Set(createdGoalIds);
  try {
    const { data } = await db
      .from("goals")
      .select("id,title")
      .ilike("title", "%backlogtest%");
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      goalIds.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of goalIds) {
    try {
      await deleteGoal(id);
    } catch {
      // best-effort
    }
  }
}

// --- seeding ----------------------------------------------------------------

interface Seeded {
  goalId: string;
  goalTitle: string;
}

/**
 * A goal carrying one milestone, with the milestone's created_at backdated so
 * "nothing has touched this in N days" is a fact rather than a race against the
 * clock. Returns the ids so the assertions can name exactly what they seeded.
 */
async function seedMilestone(
  label: string,
  ageDays: number
): Promise<Seeded & { milestoneId: string; milestoneTitle: string }> {
  const goalTitle = `BacklogTest ${label} goal ${unique}`;
  const goal = await createGoal({ title: goalTitle });
  createdGoalIds.add(goal.id);

  const milestoneTitle = `BacklogTest ${label} milestone ${unique}`;
  const milestone = await createMilestone({ goal_id: goal.id, title: milestoneTitle });
  createdMilestoneIds.add(milestone.id);

  // Backdate the milestone itself: with no item ever referencing it, its own
  // creation is the last moment anything happened on it.
  await db
    .from("goal_milestones")
    .update({ created_at: new Date(Date.now() - ageDays * 864e5).toISOString() })
    .eq("id", milestone.id);

  return { goalId: goal.id, goalTitle, milestoneId: milestone.id, milestoneTitle };
}

/**
 * An active todo with (optionally) a planned_for day and a backdated creation.
 *
 * Priority 1 on purpose: unscheduled is capped at ten rows and ordered by
 * priority first, so a default-priority seed on a busy record would be pushed
 * off the end by the user's real rows. A test that fails because the account is
 * full is testing the account, not the code.
 */
async function seedTodo(
  label: string,
  ageDays: number,
  plannedFor: string | null,
  goalId: string | null
): Promise<string> {
  const item = await createItem({
    type: "todo",
    title: `BacklogTest ${label} todo ${unique}`,
    priority: 1,
    goal_id: goalId ?? undefined,
    planned_for: plannedFor ?? undefined,
  });
  createdItemIds.add(item.id);
  if (ageDays > 0) {
    await db
      .from("items")
      .update({ created_at: new Date(Date.now() - ageDays * 864e5).toISOString() })
      .eq("id", item.id);
  }
  return item.id;
}

// --- checks -----------------------------------------------------------------

interface StalledPair {
  staleId: string;
  staleTitle: string;
  staleGoal: string;
  freshId: string;
  freshTitle: string;
  overdueTodoId: string;
  todayTodoId: string;
}

/**
 * CHECKS 1+2 — the stall window, as a pair.
 *
 * A milestone with no related activity for 20 days must be IN the stalled list
 * with daysSince >= 14; an identical milestone whose item was created today must
 * be OUT of it. The assertions name the seeded ids, so a false positive that
 * came from other data in the table is visible rather than silently counted.
 */
async function testStalledPair(): Promise<StalledPair> {
  console.log("\n-- 1+2. A stalled milestone is in; a fresh one is out --");

  const stale = await seedMilestone("stale", 20);
  const fresh = await seedMilestone("fresh", 20);

  // The fresh milestone is kept fresh by an item created NOW that references it.
  const freshItem = await createItem({
    type: "todo",
    title: `BacklogTest fresh touch ${unique}`,
    milestone_id: fresh.milestoneId,
  });
  createdItemIds.add(freshItem.id);

  // A genuinely overdue unscheduled todo and one planned for today, for check 3.
  const overdueTodoId = await seedTodo("old", 25, null, stale.goalId);
  const todayTodoId = await seedTodo("planned", 25, localDay(), stale.goalId);

  const backlog = await getBacklog();

  const staleRow = backlog.stalled.find((m) => m.id === stale.milestoneId);
  check(
    "behavioural",
    `1. the 20-day-old milestone ${stale.milestoneId.slice(0, 8)} is stalled, daysSince >= 14`,
    !!staleRow && staleRow.daysSince >= 14,
    staleRow
      ? `seeded id=${staleRow.id.slice(0, 8)} daysSince=${staleRow.daysSince} goal="${staleRow.goal}"`
      : `seeded id=${stale.milestoneId.slice(0, 8)} NOT FOUND in ${backlog.stalled.length} stalled row(s)`
  );
  check(
    "behavioural",
    "1b. the stalled row names the goal it belongs to",
    !!staleRow && staleRow.goal === stale.goalTitle,
    staleRow ? `goal="${staleRow.goal}"` : "row missing"
  );
  check(
    "behavioural",
    "1c. the stalled row reports no last task (nothing was ever attached)",
    !!staleRow && staleRow.lastTaskTitle === null,
    staleRow ? `lastTaskTitle=${JSON.stringify(staleRow.lastTaskTitle)}` : "row missing"
  );

  const freshRow = backlog.stalled.find((m) => m.id === fresh.milestoneId);
  check(
    "behavioural",
    `2. the fresh milestone ${fresh.milestoneId.slice(0, 8)} (item created today) is NOT stalled`,
    !freshRow,
    freshRow
      ? `FALSE POSITIVE: reported as stalled with daysSince=${freshRow.daysSince}`
      : `absent from ${backlog.stalled.length} stalled row(s)`
  );

  return {
    staleId: stale.milestoneId,
    staleTitle: stale.milestoneTitle,
    staleGoal: stale.goalTitle,
    freshId: fresh.milestoneId,
    freshTitle: fresh.milestoneTitle,
    overdueTodoId,
    todayTodoId,
  };
}

/** CHECK 3 — unscheduled is active todos with no planned_for, and only those. */
async function testUnscheduled(seed: StalledPair): Promise<void> {
  console.log("\n-- 3. Unscheduled means active, no planned_for --");

  const backlog = await getBacklog();
  const overdue = backlog.unscheduled.find((t) => t.id === seed.overdueTodoId);
  const today = backlog.unscheduled.find((t) => t.id === seed.todayTodoId);

  check(
    "behavioural",
    `3a. the undated todo ${seed.overdueTodoId.slice(0, 8)} is in unscheduled, with its age`,
    !!overdue && overdue.ageDays >= 24,
    overdue
      ? `ageDays=${overdue.ageDays} priority=P${overdue.priority} goal="${overdue.goal}"`
      : "row missing"
  );
  check(
    "behavioural",
    "3b. the undated todo carries its goal link",
    !!overdue && overdue.goal === seed.staleGoal,
    overdue ? `goal="${overdue.goal}"` : "row missing"
  );
  check(
    "behavioural",
    `3c. the todo planned for today (${localDay()}) is NOT unscheduled`,
    !today,
    today ? `FALSE POSITIVE: shown with ageDays=${today.ageDays}` : "absent"
  );
}

/** CHECK 4 — the empty case, and no empty headings. */
async function testFormatting(): Promise<void> {
  console.log("\n-- 4. formatBacklogForContext: silent when empty, no empty headings --");

  const empty: Backlog = { stalled: [], unscheduled: [], ideas: [], empty: true };
  const emptyText = formatBacklogForContext(empty);
  check(
    "behavioural",
    '4a. an empty backlog renders as "" (no heading ever reaches the model)',
    emptyText === "",
    `"${emptyText}"`
  );

  // Live data: if there is any content, every heading must have a row under it,
  // and the block must stay inside its ~15-line budget.
  const live = await getBacklog();
  const text = formatBacklogForContext(live);
  const lines = text.split("\n").filter(Boolean);
  const headingAt = (needle: string) => {
    const i = lines.findIndex((l) => l.startsWith(needle));
    if (i === -1) return null;
    return i + 1 < lines.length && lines[i + 1].startsWith("- ") ? i : -1;
  };
  const headings = [
    "Stalled (",
    "Unscheduled (",
    "Ideas captured",
  ].filter((h) => lines.some((l) => l.startsWith(h)));
  const orphaned = headings.filter((h) => headingAt(h) === -1);

  check(
    "behavioural",
    "4b. no group heading appears without at least one row under it",
    orphaned.length === 0,
    orphaned.length
      ? `orphaned: ${orphaned.join(", ")}`
      : `${headings.length} heading(s), all populated`
  );
  check(
    "behavioural",
    "4c. the block stays within ~15 lines",
    lines.length <= 15,
    `lines=${lines.length}`
  );
  check(
    "behavioural",
    "4d. empty flag agrees with the rendered text",
    live.empty === (text === ""),
    `empty=${live.empty} chars=${text.length}`
  );

  if (text) {
    console.log("      the block the model receives:");
    for (const l of lines) console.log(`        ${l}`);
  } else {
    note("4. the backlog is empty right now", "Nothing stalled, waiting or captured.");
  }
}

/** CHECK 5 — the ammunition actually reaches the coach context. */
async function testCoachContext(seed: StalledPair): Promise<void> {
  console.log("\n-- 5. buildCoachContext carries the stalled milestone --");

  const context = await buildCoachContext();
  const sectionIdx = context.indexOf("## What has stalled and what is waiting in the backlog");
  // The milestone ALSO appears in the earlier "Milestones per goal" list, so the
  // title has to be found INSIDE the backlog section, not merely somewhere in
  // the context — otherwise this check would pass on the old context alone.
  const titleIdx = sectionIdx === -1 ? -1 : context.indexOf(seed.staleTitle, sectionIdx);
  const milestoneIdx = context.indexOf("## Milestones per goal");

  check(
    "behavioural",
    "5a. the context has a stalled-and-waiting section naming the seeded milestone",
    sectionIdx !== -1 && titleIdx !== -1 && sectionIdx < titleIdx,
    `section@${sectionIdx} milestone-in-section@${titleIdx}`
  );
  check(
    "behavioural",
    "5b. it names the goal the stalled milestone serves",
    context.includes(seed.staleGoal),
    "goal title present in context"
  );
  check(
    "behavioural",
    "5c. it follows the milestones section",
    milestoneIdx === -1 || sectionIdx > milestoneIdx,
    `milestones@${milestoneIdx} backlog@${sectionIdx}`
  );
}

/** CHECK 6 — the tool exists and agrees with the formatter on the same data. */
async function testTool(): Promise<void> {
  console.log("\n-- 6. list_backlog is registered and reuses the formatter --");

  const def = TOOL_DEFINITIONS.find(
    (t) => t.type === "function" && t.function.name === "list_backlog"
  );
  check(
    "structural",
    "6a. list_backlog is in the tool definitions",
    !!def,
    def ? "present" : "MISSING"
  );
  if (def && def.type === "function") {
    const props = (def.function.parameters as { properties?: Record<string, unknown> })
      .properties;
    const group = props?.group as { enum?: string[] } | undefined;
    check(
      "structural",
      "6b. it takes an optional group of stalled / unscheduled / ideas",
      Array.isArray(group?.enum) &&
        ["stalled", "unscheduled", "ideas"].every((g) => group.enum!.includes(g)),
      `enum=${JSON.stringify(group?.enum ?? null)}`
    );
  } else {
    check("structural", "6b. it takes an optional group", false, "definition missing");
  }

  try {
    // The SAME live data through both paths must produce the SAME text — that
    // equality is what stops the tool and the context drifting apart.
    const expected = formatBacklogForContext(await getBacklog());
    const viaTool = await executeTool("list_backlog", {});
    check(
      "behavioural",
      "6c. the handler returns exactly what formatBacklogForContext produces",
      viaTool === expected,
      expected === ""
        ? `both empty (tool="${viaTool.slice(0, 40)}")`
        : `identical=${viaTool === expected} (${viaTool.length} chars)`
    );

    const stalledOnly = await executeTool("list_backlog", { group: "stalled" });
    check(
      "behavioural",
      "6d. a group filter returns only that group",
      !stalledOnly.includes("Unscheduled (") && !stalledOnly.includes("Ideas captured"),
      stalledOnly === "" ? "no stalled rows right now" : stalledOnly.split("\n")[0]
    );
  } catch (err) {
    check("behavioural", "6c. the handler reuses the formatter", false, errText(err));
  }
}

/**
 * CHECK 7 — REPORT, do not assert.
 *
 * The real planner is called once with a planning prompt and its FULL reply is
 * printed. Whether it brainstormed, recommended, and pulled backlog items is a
 * MODEL JUDGEMENT; a check that scored it would only be grading prose, and a
 * green light here would prove nothing. So this is a NOTE.
 */
async function testPlanJudgement(): Promise<void> {
  console.log("\n-- 7. The real planner, with a planning prompt (NOTE — model judgement) --");

  try {
    const context = await buildCoachContext();
    const reply = await runAssistant(
      [
        {
          role: "user",
          content:
            "Good morning. Help me plan my day with me — what should I actually move " +
            "today? Walk me through it. Don't add anything yet.",
        },
      ],
      { mode: "coach", userContext: context }
    );

    // 7b MEASURES the mechanism; it does not grade the prose. This is the check
    // that would have caught the real bug: runAssistant used to return ONLY the
    // question when the model called ask_choice, so a plan that reasoned for half
    // a page arrived as "What should I add to today?" and four buttons — and the
    // old check printed that reply and said PASS. Whatever the model thinks, its
    // reasoning must not be deletable by a button.
    const marker = reply.indexOf("[[CHOICES]]");
    const prose = (marker === -1 ? reply : reply.slice(0, marker)).trim();
    const proseLines = prose.split("\n").filter((l) => l.trim()).length;
    check(
      "behavioural",
      marker === -1
        ? "7b. the planning reply is prose (no buttons to hide the reasoning behind)"
        : "7b. the reply offers buttons but does not hide its reasoning behind them",
      prose.length >= 120 && proseLines >= 3,
      `prose=${prose.length} chars over ${proseLines} line(s)` +
        (marker === -1 ? ", no buttons" : ", then buttons") +
        (prose.length >= 120 && proseLines >= 3
          ? ""
          : " — TOO THIN: a bare question with buttons is the clerk the user complained about")
    );

    note(
      "7. the planner's FULL reply, printed rather than scored",
      "The prose below is a MODEL JUDGEMENT and is shown, not scored: whether it " +
        "named what needs movement, brainstormed genuinely different options, " +
        "recommended one with a reason, pulled backlog items (or said none fit), " +
        "linked tasks to goals, and asked at most one question. Only 7b is asserted, " +
        "and only about the mechanism."
    );
    console.log("      ----- BEGIN PLANNER REPLY -----");
    for (const line of reply.split("\n")) console.log(`      ${line}`);
    console.log("      ----- END PLANNER REPLY -----");
  } catch (err) {
    note("7. the planner call errored", errText(err));
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Backlog test (P7a): the coach's ammunition.");
  console.log(`Run id: ${unique}`);
  console.log(
    "Assertions are labelled [behavioural] (real DB / real code path) or\n" +
      "[structural] (source read, nothing executed)."
  );

  let seed: StalledPair | null = null;
  try {
    seed = await testStalledPair();
    await testUnscheduled(seed);
    await testFormatting();
    await testCoachContext(seed);
    await testTool();

    // Clean up BEFORE the planner is called. The seeded rows are visible in the
    // coach context, and check 7 prints a real plan for the user to read — a plan
    // that argues about "BacklogTest stale goal backlogtest-…" would be evidence
    // of nothing. The finally block still runs cleanup again; it is idempotent.
    await cleanup();
    console.log(
      "\nCleanup: removed created goals, milestones and items (before the planner run)."
    );

    await testPlanJudgement();
  } catch (err) {
    check("behavioural", "suite", false, errText(err));
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed created goals, milestones and items.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL BACKLOG CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("backlog test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
