import { createServiceClient } from "./supabase";

// Milestones are real, ordered steps inside a goal. When a goal has any
// milestones, its progress/target become DERIVED (progress = number done,
// target = total) and the journal-driven incrementGoalProgress() stops
// touching it — see syncGoalProgress() below.
//
// A milestone's own done state can ALSO be derived from the day tasks attached
// to it (items.milestone_id) — see syncMilestoneFromTasks() below.

export const GOAL_MILESTONE_COLS =
  "id,goal_id,title,target_date,position,done,done_at,created_at";

export interface Milestone {
  id: string;
  goal_id: string;
  title: string;
  target_date: string | null;
  position: number;
  done: boolean;
  done_at: string | null;
  created_at: string;
}

export interface CreateMilestoneInput {
  goal_id: string;
  title: string;
  target_date?: string | null;
  position?: number;
}

export interface UpdateMilestoneInput {
  title?: string;
  target_date?: string | null;
  position?: number;
}

export async function getMilestones(goalId?: string): Promise<Milestone[]> {
  const db = createServiceClient();
  let q = db.from("goal_milestones").select(GOAL_MILESTONE_COLS);
  if (goalId) q = q.eq("goal_id", goalId);
  q = q.order("position", { ascending: true }).order("created_at", { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Milestone[];
}

// Append at the end: position = current max + 1 unless the caller supplies one.
export async function createMilestone(
  input: CreateMilestoneInput
): Promise<Milestone> {
  const db = createServiceClient();

  let position = input.position;
  if (position === undefined) {
    const { data: last, error: maxErr } = await db
      .from("goal_milestones")
      .select("position")
      .eq("goal_id", input.goal_id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxErr) throw new Error(maxErr.message);
    position = ((last?.position as number | undefined) ?? -1) + 1;
  }

  const { data, error } = await db
    .from("goal_milestones")
    .insert({
      goal_id: input.goal_id,
      title: input.title,
      target_date: input.target_date ?? null,
      position,
    })
    .select(GOAL_MILESTONE_COLS)
    .single();
  if (error) throw new Error(error.message);

  // Adding the first milestone switches the goal to derived progress.
  await syncGoalProgress(input.goal_id);
  return data as Milestone;
}

export async function updateMilestone(
  id: string,
  input: UpdateMilestoneInput
): Promise<Milestone> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("goal_milestones")
    .update(input)
    .eq("id", id)
    .select(GOAL_MILESTONE_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No milestone found with id "${id}"`);
  return data as Milestone;
}

// Mark done/undone, keep done_at in sync, then re-derive the goal's progress.
export async function toggleMilestone(
  id: string,
  done: boolean
): Promise<Milestone> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("goal_milestones")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", id)
    .select(GOAL_MILESTONE_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No milestone found with id "${id}"`);
  const milestone = data as Milestone;
  await syncGoalProgress(milestone.goal_id);
  return milestone;
}

// Deleting a milestone can also remove the last one — syncGoalProgress then
// leaves the goal alone (journal-driven ownership resumes).
export async function deleteMilestone(id: string): Promise<void> {
  const db = createServiceClient();
  const { data: row, error: readErr } = await db
    .from("goal_milestones")
    .select("goal_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const { error } = await db.from("goal_milestones").delete().eq("id", id);
  if (error) throw new Error(error.message);

  if (row?.goal_id) await syncGoalProgress(row.goal_id as string);
}

// Write position from array index (0-based) for a goal's ordered milestone ids.
export async function reorderMilestones(
  goalId: string,
  orderedIds: string[]
): Promise<void> {
  const db = createServiceClient();
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await db
      .from("goal_milestones")
      .update({ position: i })
      .eq("id", orderedIds[i])
      .eq("goal_id", goalId);
    if (error) throw new Error(error.message);
  }
}

// The derived-progress rule: if the goal has milestones, progress/target are
// count(done)/count(all). If it has none, do nothing — the journal-driven
// incrementGoalProgress() keeps owning the goal. Never sets status = 'done';
// the user closes goals deliberately.
export async function syncGoalProgress(goalId: string): Promise<void> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("goal_milestones")
    .select("done")
    .eq("goal_id", goalId);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { done: boolean }[];
  if (rows.length === 0) return; // no milestones → leave the goal untouched

  const target = rows.length;
  const progress = rows.filter((r) => r.done).length;

  const { error: upErr } = await db
    .from("goals")
    .update({ progress, target, updated_at: new Date().toISOString() })
    .eq("id", goalId);
  if (upErr) throw new Error(upErr.message);
}

// Roll a milestone's done state up from the tasks attached to it. Reads items
// with its own query (this module must not import db.ts — that would create an
// import cycle, since db.ts imports this module).
//
// Rule:
//   - no attached tasks (status != 'archived') → leave the milestone alone;
//     it stays manually managed and ticking it by hand keeps working.
//   - attached tasks exist → done when EVERY task is done, not done while any
//     task is still active.
// On any change, done_at is set/cleared and the goal progress is re-derived.
export async function syncMilestoneFromTasks(
  milestoneId: string
): Promise<void> {
  const db = createServiceClient();

  const { data: msData, error: msErr } = await db
    .from("goal_milestones")
    .select("id,goal_id,done")
    .eq("id", milestoneId)
    .maybeSingle();
  if (msErr) throw new Error(msErr.message);
  if (!msData) return; // milestone vanished → nothing to roll up

  const milestone = msData as { id: string; goal_id: string; done: boolean };

  const { data: taskData, error: taskErr } = await db
    .from("items")
    .select("status")
    .eq("type", "todo")
    .eq("milestone_id", milestoneId)
    .neq("status", "archived");
  if (taskErr) throw new Error(taskErr.message);

  const tasks = (taskData ?? []) as { status: string }[];
  // No attached tasks → manually managed; leave it completely alone.
  if (tasks.length === 0) return;

  const nextDone = tasks.every((t) => t.status === "done");
  if (nextDone === milestone.done) return; // already in the right state

  const { error: upErr } = await db
    .from("goal_milestones")
    .update({
      done: nextDone,
      done_at: nextDone ? new Date().toISOString() : null,
    })
    .eq("id", milestoneId);
  if (upErr) throw new Error(upErr.message);

  // Visible roll-up: the goal's progress/target follow the milestone change.
  await syncGoalProgress(milestone.goal_id);
}

export async function goalHasMilestones(goalId: string): Promise<boolean> {
  const db = createServiceClient();
  const { count, error } = await db
    .from("goal_milestones")
    .select("id", { count: "exact", head: true })
    .eq("goal_id", goalId);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

// One query, grouped by goal — for the Stats tab and coach context.
export async function getMilestonesByGoal(
  goalIds: string[]
): Promise<Record<string, Milestone[]>> {
  if (goalIds.length === 0) return {};
  const db = createServiceClient();
  const { data, error } = await db
    .from("goal_milestones")
    .select(GOAL_MILESTONE_COLS)
    .in("goal_id", goalIds)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const grouped: Record<string, Milestone[]> = {};
  for (const id of goalIds) grouped[id] = [];
  for (const m of (data ?? []) as Milestone[]) {
    (grouped[m.goal_id] ??= []).push(m);
  }
  return grouped;
}

// Per-milestone task tallies for the Stats tab: one query for all ids, grouped
// in memory. Archived tasks are ignored (they no longer count toward the
// roll-up). Every requested id is present in the result, zeroed by default.
export async function getMilestoneTaskCounts(
  milestoneIds: string[]
): Promise<Record<string, { open: number; done: number }>> {
  const out: Record<string, { open: number; done: number }> = {};
  if (milestoneIds.length === 0) return out;
  for (const id of milestoneIds) out[id] = { open: 0, done: 0 };

  const db = createServiceClient();
  const { data, error } = await db
    .from("items")
    .select("milestone_id,status")
    .eq("type", "todo")
    .in("milestone_id", milestoneIds)
    .neq("status", "archived");
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as {
    milestone_id: string | null;
    status: string;
  }[]) {
    if (!row.milestone_id) continue;
    const bucket = out[row.milestone_id];
    if (!bucket) continue;
    if (row.status === "done") bucket.done += 1;
    else bucket.open += 1;
  }
  return out;
}
