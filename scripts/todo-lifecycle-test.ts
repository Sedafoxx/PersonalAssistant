// End-to-end checks for todo RESOLUTION (the fixed To-Do-List bug).
//
// Run: npm run todos:test
//   (= node --env-file=.env.local --import tsx scripts/todo-lifecycle-test.ts)
//
// THE BUG THIS FILE EXISTS TO PREVENT, in the user's words: "when i do a task in
// my Today View i want this todo element to be resolved. currently the todo items
// are added to today, are crossed out, but they remain a todo. i have many
// finished todos now that need clean up." Measured before the fix: 113 todos, 45
// active, 57 done, 34 of the done ones still pinned to a day.
//
// THE RULE under test:
//   status = 'done'          → finished, still part of its day
//   resolved_at IS NULL      → live for planning (the list, the day, the backlog)
//   resolved_at IS NOT NULL  → finished AND its day is over → put away
// A finished task is resolved when the day it was planned for — or the day it was
// completed, when it was never planned — is over. Not before: the crossed-out row
// is the record of what the user did today.
//
// CHECKS 6 AND 7 ARE THE ONES THAT MATTER, because they are the reason resolution
// is a marker instead of status = 'archived'. status and planned_for are the
// history keys: getTaskTrend/getDayMetrics count a completed task by reading them,
// and syncMilestoneFromTasks ignores archived tasks entirely. Archiving a finished
// task therefore ERASES it from the trend and can flip a completed milestone back
// to open. Check 7 builds that exact situation — one task, one milestone, task
// done, milestone done — then resolves the task and asserts the milestone is still
// done. A naive archive implementation fails it, loudly.
//
// NOTE ON REAL DATA: the sweep is global by nature, so running this test also
// performs the one-off cleanup the user asked for — finished tasks whose day is
// over get resolved_at set. That is the intended end state, it is reversible
// (set resolved_at back to null), and it creates nothing that survives. The
// header of check 9 reports how many real rows it put away.
//
// Assertions are labelled: [behavioural] hits the real DB / the real code path,
// [structural] reads the SOURCE and checks the contract it advertises.

import { readFile } from "node:fs/promises";
import { createServiceClient } from "../src/lib/supabase";
import { createItem, getItems } from "../src/lib/db";
import {
  addDayTask,
  getDay,
  getTaskTrend,
  localDay,
  resolveFinishedTodos,
} from "../src/lib/day";
import { createGoal, deleteGoal } from "../src/lib/goals";
import { createMilestone, syncMilestoneFromTasks } from "../src/lib/milestones";

const db = createServiceClient();
const unique = `todotest-${Date.now()}`;

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

function note(name: string, detail = ""): void {
  console.log(`NOTE  ${name}${detail ? `\n      ${detail}` : ""}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// --- seeding / cleanup ------------------------------------------------------

const createdItemIds = new Set<string>();
const createdGoalIds = new Set<string>();

interface Seed {
  id: string;
  title: string;
}

/**
 * A todo written straight to the DB, so no XP is awarded and no side effect
 * fires: the test controls status, day and timestamps exactly. created_at is
 * backdated so age-based behaviour is a fact rather than a race with the clock.
 */
async function seedTodo(opts: {
  label: string;
  plannedFor?: string | null;
  done?: boolean;
  ageDays?: number;
  milestoneId?: string;
}): Promise<Seed> {
  const title = `TodoTest ${opts.label} ${unique}`;
  const item = await createItem({
    type: "todo",
    title,
    priority: 1,
    planned_for: opts.plannedFor ?? undefined,
    milestone_id: opts.milestoneId,
  });
  createdItemIds.add(item.id);

  const age = opts.ageDays ?? 0;
  const stamp = new Date(Date.now() - age * 864e5).toISOString();
  const patch: Record<string, unknown> = { created_at: stamp, updated_at: stamp };
  if (opts.done) patch.status = "done";
  await db.from("items").update(patch).eq("id", item.id);

  return { id: item.id, title };
}

async function readRow(id: string): Promise<{
  status: string;
  planned_for: string | null;
  resolved_at: string | null;
} | null> {
  const { data } = await db
    .from("items")
    .select("status,planned_for,resolved_at")
    .eq("id", id)
    .maybeSingle();
  return (data as { status: string; planned_for: string | null; resolved_at: string | null }) ?? null;
}

/**
 * The REAL unfinished-business count: finished tasks still unresolved, excluding
 * anything this test planted. Without the exclusion the number moves on its own
 * during the run (the seeds are finished tasks too), and a report that counts its
 * own fixtures would be worthless.
 */
async function unresolvedDoneCount(): Promise<number> {
  const { data } = await db
    .from("items")
    .select("id,title")
    .eq("type", "todo")
    .eq("status", "done")
    .is("resolved_at", null);
  return ((data ?? []) as { title: string }[]).filter(
    (row) => !row.title.includes("TodoTest")
  ).length;
}

/** Remove everything this run made. Matched on the marker as well as by id. */
async function cleanup(): Promise<void> {
  try {
    const { data } = await db.from("items").select("id").ilike("title", "%TodoTest%");
    for (const row of (data ?? []) as { id: string }[]) createdItemIds.add(row.id);
  } catch {
    // best-effort
  }
  for (const id of createdItemIds) {
    try {
      await db.from("items").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
  try {
    const { data } = await db.from("goals").select("id,title").ilike("title", "%TodoTest%");
    for (const row of (data ?? []) as { id: string; title: string }[]) createdGoalIds.add(row.id);
  } catch {
    // best-effort
  }
  for (const id of createdGoalIds) {
    try {
      await deleteGoal(id);
    } catch {
      // best-effort
    }
  }
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const today = localDay();
  const yesterday = shiftDay(today, -1);

  console.log("Todo lifecycle test: a finished task is resolved, not erased.");
  console.log(`Run id: ${unique}   today=${today}`);
  console.log(
    "Assertions are labelled [behavioural] (real DB / real code path) or\n" +
      "[structural] (source read, nothing executed)."
  );

  const realDoneBefore = await unresolvedDoneCount();

  try {
    // --- 1-4. the rule -----------------------------------------------------
    console.log("\n-- 1-4. when a finished task is resolved, and when it is not --");

    const past = await seedTodo({ label: "past", plannedFor: yesterday, done: true });
    const todayTask = await seedTodo({ label: "today", plannedFor: today, done: true });
    const leftover = await seedTodo({ label: "leftover", plannedFor: yesterday });
    const unplanned = await seedTodo({ label: "unplanned", done: true, ageDays: 3 });

    const resolved = await resolveFinishedTodos();
    console.log(`      the sweep resolved ${resolved} row(s) in total`);

    const pastRow = await readRow(past.id);
    check(
      "behavioural",
      "1. a task planned for yesterday and finished IS resolved",
      !!pastRow?.resolved_at,
      pastRow?.resolved_at ? `resolved_at=${pastRow.resolved_at}` : "resolved_at is still null"
    );
    check(
      "behavioural",
      "1b. resolving keeps status=done (the Stats tab and the roll-up read it)",
      pastRow?.status === "done",
      `status=${pastRow?.status}`
    );
    check(
      "behavioural",
      "1c. resolving keeps planned_for (the day it belonged to is history)",
      pastRow?.planned_for === yesterday,
      `planned_for=${pastRow?.planned_for}`
    );

    const todayRow = await readRow(todayTask.id);
    check(
      "behavioural",
      "2. a task finished TODAY is NOT resolved — its day is still running",
      !!todayRow && todayRow.resolved_at === null,
      `resolved_at=${todayRow?.resolved_at ?? "null (correct)"}`
    );

    const leftoverRow = await readRow(leftover.id);
    check(
      "behavioural",
      "3. an UNFINISHED task planned yesterday is untouched (still a leftover to triage)",
      !!leftoverRow && leftoverRow.resolved_at === null && leftoverRow.status === "active",
      `status=${leftoverRow?.status} resolved_at=${leftoverRow?.resolved_at ?? "null"}`
    );

    const unplannedRow = await readRow(unplanned.id);
    check(
      "behavioural",
      "4. a task completed 3 days ago without ever being planned IS resolved",
      !!unplannedRow?.resolved_at,
      unplannedRow?.resolved_at ? "resolved from updated_at" : "still unresolved"
    );

    // --- 5. the day view, and that resolution is reversible -----------------
    console.log("\n-- 5. the day view drops a resolved item, and it can be put back --");

    // Manually resolve something planned for TODAY, because the sweep correctly
    // refuses to do it: this isolates the day-view filter from the timing rule.
    await db.from("items").update({ resolved_at: new Date().toISOString() }).eq("id", todayTask.id);
    const withoutIt = await getDay(today);
    check(
      "behavioural",
      "5a. a resolved item no longer appears in its day",
      !withoutIt.today.some((i) => i.id === todayTask.id),
      `today holds ${withoutIt.today.length} item(s)`
    );

    await db.from("items").update({ resolved_at: null }).eq("id", todayTask.id);
    const withIt = await getDay(today);
    check(
      "behavioural",
      "5b. clearing resolved_at puts it back (resolution is reversible)",
      withIt.today.some((i) => i.id === todayTask.id),
      `today holds ${withIt.today.length} item(s)`
    );

    // --- 6. history does not move ------------------------------------------
    console.log("\n-- 6. resolving a task does NOT change the stats history --");

    const trendBefore = await getTaskTrend(7);
    const doneBefore = trendBefore.find((d) => d.day === yesterday)?.done ?? 0;

    // Resolve it again through the real path and re-read the trend.
    await resolveFinishedTodos();
    const trendAfter = await getTaskTrend(7);
    const doneAfter = trendAfter.find((d) => d.day === yesterday)?.done ?? 0;

    check(
      "behavioural",
      `6. the done-count for ${yesterday} is unchanged by the sweep (${doneBefore} -> ${doneAfter})`,
      doneBefore === doneAfter && doneBefore > 0,
      doneBefore > 0
        ? "the finished task still counts on its day"
        : "the seed did not land in the trend window"
    );

    // --- 7. the milestone roll-up survives (the anti-regression check) ------
    console.log("\n-- 7. a completed MILESTONE stays completed after its task is resolved --");

    const goal = await createGoal({ title: `TodoTest goal ${unique}` });
    createdGoalIds.add(goal.id);
    const milestone = await createMilestone({
      goal_id: goal.id,
      title: `TodoTest milestone ${unique}`,
    });

    const attached = await seedTodo({
      label: "attached",
      plannedFor: yesterday,
      done: true,
      milestoneId: milestone.id,
    });

    await syncMilestoneFromTasks(milestone.id);
    const beforeRollup = await db
      .from("goal_milestones")
      .select("done")
      .eq("id", milestone.id)
      .maybeSingle();
    const doneBeforeResolve = (beforeRollup.data as { done: boolean } | null)?.done ?? false;

    await resolveFinishedTodos();

    await syncMilestoneFromTasks(milestone.id);
    const afterRollup = await db
      .from("goal_milestones")
      .select("done")
      .eq("id", milestone.id)
      .maybeSingle();
    const doneAfterResolve = (afterRollup.data as { done: boolean } | null)?.done ?? false;

    const attachedRow = await readRow(attached.id);
    check(
      "behavioural",
      "7. the milestone whose only task was resolved is STILL done",
      doneBeforeResolve && doneAfterResolve,
      `milestone done: ${doneBeforeResolve} -> ${doneAfterResolve}` +
        (doneAfterResolve ? "" : " — resolution erased the roll-up (the archive trap)")
    );
    check(
      "behavioural",
      "7b. the resolved task still reads as done to the roll-up query (status stays 'done')",
      attachedRow?.status === "done" && !!attachedRow?.resolved_at,
      `status=${attachedRow?.status} resolved_at=${attachedRow?.resolved_at ? "set" : "null"}`
    );

    // --- 8. the duplicate guard --------------------------------------------
    console.log("\n-- 8. the same task cannot be created twice on the same day --");

    const dupTitle = `TodoTest dup ${unique}`;
    const first = await addDayTask({ title: dupTitle, planned_for: today });
    const second = await addDayTask({ title: `  ${dupTitle.toUpperCase()}  `, planned_for: today });
    createdItemIds.add(first.id);

    const dupRows = await db
      .from("items")
      .select("id")
      .eq("type", "todo")
      .eq("planned_for", today)
      .ilike("title", `%${unique}%`)
      .ilike("title", "%dup%");
    const dupCount = (dupRows.data ?? []).length;

    check(
      "behavioural",
      "8a. a second add of the same title on the same day returns the EXISTING row",
      second.id === first.id,
      `first=${first.id.slice(0, 8)} second=${second.id.slice(0, 8)}`
    );
    check(
      "behavioural",
      "8b. and only ONE row exists for it (case and spacing differences included)",
      dupCount === 1,
      `${dupCount} row(s) matching the duplicate title`
    );

    const different = await addDayTask({ title: `TodoTest other ${unique}`, planned_for: today });
    createdItemIds.add(different.id);
    check(
      "behavioural",
      "8c. a genuinely different task is still created (the guard is not a blanket block)",
      different.id !== first.id,
      `id=${different.id.slice(0, 8)}`
    );

    // --- 9. the list contract ----------------------------------------------
    console.log("\n-- 9. the Todos list no longer offers finished work --");

    const routeSource = await readFile("src/app/api/items/route.ts", "utf8");
    check(
      "structural",
      "9a. with no status asked for, /api/items asks for UNRESOLVED rows",
      /unresolved:\s*statusParam === null/.test(routeSource),
      "the default view is 'not archived and not resolved', not a status list"
    );

    const defaultView = await getItems({ unresolved: true, type: "todo" });
    const doneHistory = await getItems({ status: "done", type: "todo" });
    check(
      "behavioural",
      "9b. a task resolved yesterday is GONE from the list but still in the done history",
      !defaultView.some((i) => i.id === past.id) && doneHistory.some((i) => i.id === past.id),
      `default=${defaultView.length} done=${doneHistory.length}`
    );
    check(
      "behavioural",
      "9c. a task finished TODAY is still listed, so a mis-tick stays undoable",
      defaultView.some((i) => i.id === todayTask.id),
      "today's finished task stays in the list until its day is over"
    );

    const realDoneAfter = await unresolvedDoneCount();
    note(
      "9d. the real finished pile, put away by this run",
      `${realDoneBefore} finished task(s) were still sitting in the list at the start, ` +
        `${realDoneAfter} now (the test's own rows excluded). Reversible: ` +
        `update items set resolved_at = null where type = 'todo' and status = 'done';`
    );
  } catch (err) {
    check("behavioural", "suite", false, errText(err));
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed the test's own items, goal and milestone.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL TODO LIFECYCLE CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("todo lifecycle test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
