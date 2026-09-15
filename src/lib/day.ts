import { createServiceClient } from "./supabase";
import { createItem, updateItem, type Item } from "./db";
import { getGoals } from "./goals";
import { todayLocal } from "./dates";

// Day-window logic for the "Today" view. Deliberately self-contained: it owns
// a tiny local-day helper (Europe/Vienna) rather than importing coach.ts, to
// avoid an import cycle (coach.ts already imports db.ts, and this module is
// imported by the day API route and later by the coach planning flow).

// Today's date as YYYY-MM-DD in the user's local zone (Europe/Vienna), from the
// single shared definition in dates.ts. Formatting in the target zone rather
// than slicing a UTC string is what keeps the day boundary correct no matter
// where the server runs.
export function localDay(date: Date = new Date()): string {
  return todayLocal(date);
}

// A plain calendar-date string, validated so bad input never reaches the DB.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDayString(value: unknown): value is string {
  return typeof value === "string" && DAY_RE.test(value);
}

export interface DayView {
  date: string;
  today: Item[];
  due: Item[];
  backlog: Item[];
  counts: { total: number; done: number; open: number; requiredOpen: number };
}

const TODO_COLS =
  "id,type,title,content,priority,status,tags,due_date,notification_time,xp_awarded,planned_for,planned_time,day_order,required,goal_id,milestone_id,created_at,updated_at";

// Supabase builders are PromiseLike (not Promise) — never call .catch() on one;
// await inside a try/catch instead.
async function fetchTodos(): Promise<Item[]> {
  const db = createServiceClient();
  try {
    const { data, error } = await db
      .from("items")
      .select(TODO_COLS)
      .eq("type", "todo")
      .neq("status", "archived");
    if (error) throw new Error(error.message);
    return (data ?? []) as Item[];
  } catch {
    // An empty day (or missing table) must return empty arrays, never throw.
    return [];
  }
}

// Stable in-memory ordering for the "today" group:
//   open items first, by day_order (nulls last), then priority, then planned_time.
//   completed items afterwards, by updated_at desc.
function sortToday(items: Item[]): Item[] {
  const open = items.filter((i) => i.status !== "done");
  const done = items.filter((i) => i.status === "done");

  open.sort((a, b) => {
    const ao = a.day_order;
    const bo = b.day_order;
    if (ao == null && bo != null) return 1;
    if (ao != null && bo == null) return -1;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if ((a.priority ?? 3) !== (b.priority ?? 3)) return (a.priority ?? 3) - (b.priority ?? 3);
    const at = a.planned_time ?? "";
    const bt = b.planned_time ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });

  done.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

  return [...open, ...done];
}

export async function getDay(day?: string): Promise<DayView> {
  const date = isDayString(day) ? day : localDay();
  const all = await fetchTodos();

  const todayAll = all.filter((i) => i.planned_for === date);
  const inToday = new Set(todayAll.map((i) => i.id));
  const today = sortToday(todayAll);

  // Safety net: an active todo whose due_date has arrived (or passed) shows up
  // even if the user never planned it, so a deadline can't hide behind a
  // missing plan.
  const due = all
    .filter(
      (i) =>
        i.status === "active" &&
        i.due_date != null &&
        i.due_date <= date &&
        !inToday.has(i.id)
    )
    .sort((a, b) => {
      const ad = a.due_date ?? "";
      const bd = b.due_date ?? "";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return 0;
    });

  const backlog = all
    .filter((i) => i.status === "active" && i.planned_for == null)
    .sort((a, b) => {
      if ((a.priority ?? 3) !== (b.priority ?? 3)) return (a.priority ?? 3) - (b.priority ?? 3);
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    })
    .slice(0, 50);

  const total = today.length;
  const done = today.filter((i) => i.status === "done").length;
  const open = total - done;
  const requiredOpen = today.filter((i) => i.status !== "done" && i.required).length;

  return { date, today, due, backlog, counts: { total, done, open, requiredOpen } };
}

// Max day_order currently used on a given day (-1 when the day is empty).
async function maxDayOrder(day: string): Promise<number> {
  const db = createServiceClient();
  try {
    const { data, error } = await db
      .from("items")
      .select("day_order")
      .eq("type", "todo")
      .eq("planned_for", day)
      .order("day_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const v = (data as { day_order: number | null } | null)?.day_order;
    return v ?? -1;
  } catch {
    return -1;
  }
}

export interface AddDayTaskInput {
  title: string;
  priority?: number;
  required?: boolean;
  planned_time?: string;
  goal_id?: string;
  milestone_id?: string;
  planned_for?: string;
}

export async function addDayTask(input: AddDayTaskInput): Promise<Item> {
  const day = isDayString(input.planned_for) ? input.planned_for : localDay();
  const dayOrder = (await maxDayOrder(day)) + 1;

  // A real todo — the same row the user sees in the todo list.
  return createItem({
    type: "todo",
    title: input.title,
    priority: input.priority ?? 3,
    required: input.required ?? true,
    planned_for: day,
    planned_time: input.planned_time,
    goal_id: input.goal_id,
    milestone_id: input.milestone_id,
    day_order: dayOrder,
    tags: ["today"],
  });
}

export interface UpdateDayTaskInput {
  title?: string;
  planned_for?: string | null;
  planned_time?: string | null;
  day_order?: number | null;
  required?: boolean;
  priority?: number;
  goal_id?: string | null;
  milestone_id?: string | null;
  status?: "active" | "done" | "archived";
}

export async function updateDayTask(
  id: string,
  patch: UpdateDayTaskInput
): Promise<Item> {
  // Whitelist patchable keys so callers can never rewrite arbitrary columns.
  const clean: UpdateDayTaskInput = {};
  if (patch.title !== undefined) clean.title = patch.title;
  if (patch.planned_for !== undefined) clean.planned_for = patch.planned_for;
  if (patch.planned_time !== undefined) clean.planned_time = patch.planned_time;
  if (patch.day_order !== undefined) clean.day_order = patch.day_order;
  if (patch.required !== undefined) clean.required = patch.required;
  if (patch.priority !== undefined) clean.priority = patch.priority;
  if (patch.goal_id !== undefined) clean.goal_id = patch.goal_id;
  if (patch.milestone_id !== undefined) clean.milestone_id = patch.milestone_id;
  if (patch.status !== undefined) clean.status = patch.status;
  return updateItem(id, clean);
}

export async function reorderDay(day: string, orderedIds: string[]): Promise<void> {
  const db = createServiceClient();
  for (let i = 0; i < orderedIds.length; i++) {
    // Also pin planned_for so a reorder can never silently move an item off the
    // day.
    const { error } = await db
      .from("items")
      .update({ day_order: i, planned_for: day, updated_at: new Date().toISOString() })
      .eq("id", orderedIds[i]);
    if (error) throw new Error(error.message);
  }
}

export async function pullIntoDay(id: string, day?: string): Promise<Item> {
  const target = isDayString(day) ? day : localDay();
  const dayOrder = (await maxDayOrder(target)) + 1;
  return updateDayTask(id, { planned_for: target, day_order: dayOrder });
}

export async function pushOutOfDay(id: string): Promise<Item> {
  return updateDayTask(id, { planned_for: null, day_order: null });
}

export async function listLeftovers(beforeDay?: string): Promise<Item[]> {
  const before = isDayString(beforeDay) ? beforeDay : localDay();
  const db = createServiceClient();
  try {
    const { data, error } = await db
      .from("items")
      .select(TODO_COLS)
      .eq("type", "todo")
      .eq("status", "active")
      .not("planned_for", "is", null)
      .lt("planned_for", before)
      .order("planned_for", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as Item[];
  } catch {
    return [];
  }
}

// Morning triage convenience: move a leftover onto the day.
export async function carryOver(id: string, day?: string): Promise<Item> {
  return pullIntoDay(id, day);
}

// Never deletes — archiving hides it while preserving history/XP.
export async function dropTask(id: string): Promise<void> {
  await updateDayTask(id, { status: "archived" });
}

function shiftDay(day: string, deltaDays: number): string {
  // Noon avoids DST edge cases when adding calendar days.
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export async function getTaskTrend(
  days = 14
): Promise<{ day: string; planned: number; done: number }[]> {
  const span = Math.max(1, Math.floor(days));
  const today = localDay();
  const start = shiftDay(today, -(span - 1));

  const db = createServiceClient();
  const plannedMap = new Map<string, { planned: number; done: number }>();
  try {
    const { data, error } = await db
      .from("items")
      .select("planned_for,status")
      .eq("type", "todo")
      .not("planned_for", "is", null)
      .gte("planned_for", start)
      .lte("planned_for", today);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { planned_for: string | null; status: string }[]) {
      const key = row.planned_for as string;
      const bucket = plannedMap.get(key) ?? { planned: 0, done: 0 };
      bucket.planned += 1;
      if (row.status === "done") bucket.done += 1;
      plannedMap.set(key, bucket);
    }
  } catch {
    // fall through — zeros for every day
  }

  // Oldest first, every day present (including zero days and today).
  const out: { day: string; planned: number; done: number }[] = [];
  for (let i = 0; i < span; i++) {
    const day = shiftDay(start, i);
    const bucket = plannedMap.get(day) ?? { planned: 0, done: 0 };
    out.push({ day, planned: bucket.planned, done: bucket.done });
  }
  return out;
}

export async function getDayMetrics(day?: string): Promise<{
  planned: number;
  done: number;
  requiredOpen: number;
  optionalOpen: number;
  xpEarned: number;
}> {
  const date = isDayString(day) ? day : localDay();
  const db = createServiceClient();
  try {
    const { data, error } = await db
      .from("items")
      .select("status,required,xp_awarded")
      .eq("type", "todo")
      .eq("planned_for", date);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as {
      status: string;
      required: boolean;
      xp_awarded: number;
    }[];
    const planned = rows.length;
    const doneRows = rows.filter((r) => r.status === "done");
    const openRows = rows.filter((r) => r.status !== "done" && r.status !== "archived");
    const xpEarned = doneRows.reduce((sum, r) => sum + (r.xp_awarded ?? 0), 0);

    return {
      planned,
      done: doneRows.length,
      requiredOpen: openRows.filter((r) => r.required).length,
      optionalOpen: openRows.filter((r) => !r.required).length,
      xpEarned,
    };
  } catch {
    return { planned: 0, done: 0, requiredOpen: 0, optionalOpen: 0, xpEarned: 0 };
  }
}

// ---- "Moved forward today" across life dimensions -------------------------
//
// There is no formal life-dimension taxonomy, so each ACTIVE GOAL acts as a
// dimension (which is what the user's goals already are in practice). A goal
// "moved" today when work scheduled for `day` got done, or one of its
// milestones became done today.

export interface GoalMovement {
  goal_id: string;
  goal_title: string;
  tasks_done: number;
  tasks_open: number;
  milestones_done: number; // milestones that became done today
}

export interface DayMovement {
  day: string;
  goals: GoalMovement[]; // only goals with any activity, busiest first
  goalsMoved: number; // goals with at least one done task or milestone
  tasksDone: number;
  milestonesDone: number;
}

// Only work SCHEDULED for `day` counts: a task completed today but planned for
// another day is not "today's movement", which keeps the number honest.
export async function getMovementToday(day?: string): Promise<DayMovement> {
  const date = isDayString(day) ? day : localDay();
  const empty: DayMovement = {
    day: date,
    goals: [],
    goalsMoved: 0,
    tasksDone: 0,
    milestonesDone: 0,
  };

  const db = createServiceClient();
  try {
    const tasksByGoal = new Map<
      string,
      { tasks_done: number; tasks_open: number }
    >();
    const { data: taskData, error: taskErr } = await db
      .from("items")
      .select("goal_id,status")
      .eq("type", "todo")
      .eq("planned_for", date);
    if (taskErr) throw new Error(taskErr.message);

    for (const row of (taskData ?? []) as {
      goal_id: string | null;
      status: string;
    }[]) {
      // Tasks with no goal belong to no dimension — counting them would make
      // the dashboard lie. Archived tasks no longer count as activity.
      if (!row.goal_id || row.status === "archived") continue;
      const bucket =
        tasksByGoal.get(row.goal_id) ?? { tasks_done: 0, tasks_open: 0 };
      if (row.status === "done") bucket.tasks_done += 1;
      else bucket.tasks_open += 1;
      tasksByGoal.set(row.goal_id, bucket);
    }

    // Milestones that became done today, grouped by their goal.
    const milestonesByGoal = new Map<string, number>();
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${shiftDay(date, 1)}T00:00:00.000Z`;
    const { data: msData, error: msErr } = await db
      .from("goal_milestones")
      .select("goal_id,done_at")
      .not("done_at", "is", null)
      .gte("done_at", dayStart)
      .lt("done_at", dayEnd);
    if (msErr) throw new Error(msErr.message);

    for (const row of (msData ?? []) as {
      goal_id: string;
      done_at: string | null;
    }[]) {
      if (!row.goal_id) continue;
      milestonesByGoal.set(row.goal_id, (milestonesByGoal.get(row.goal_id) ?? 0) + 1);
    }

    // Resolve titles from the active goals; a goal that no longer exists is
    // skipped rather than shown with a placeholder.
    const activeGoals = await getGoals("active");
    const titles = new Map(activeGoals.map((g) => [g.id, g.title]));

    const goals: GoalMovement[] = [];
    const goalIds = new Set<string>([
      ...tasksByGoal.keys(),
      ...milestonesByGoal.keys(),
    ]);
    for (const goalId of goalIds) {
      const title = titles.get(goalId);
      if (title === undefined) continue;
      const t = tasksByGoal.get(goalId) ?? { tasks_done: 0, tasks_open: 0 };
      const milestones_done = milestonesByGoal.get(goalId) ?? 0;
      goals.push({
        goal_id: goalId,
        goal_title: title,
        tasks_done: t.tasks_done,
        tasks_open: t.tasks_open,
        milestones_done,
      });
    }

    // Busiest first, then title — a stable, glanceable order.
    goals.sort((a, b) => {
      const am = a.tasks_done + a.milestones_done;
      const bm = b.tasks_done + b.milestones_done;
      if (am !== bm) return bm - am;
      return a.goal_title.localeCompare(b.goal_title);
    });

    return {
      day: date,
      goals,
      goalsMoved: goals.filter((g) => g.tasks_done > 0 || g.milestones_done > 0).length,
      tasksDone: goals.reduce((s, g) => s + g.tasks_done, 0),
      milestonesDone: goals.reduce((s, g) => s + g.milestones_done, 0),
    };
  } catch {
    // Best-effort: a missing table can never blank the dashboard.
    return empty;
  }
}
