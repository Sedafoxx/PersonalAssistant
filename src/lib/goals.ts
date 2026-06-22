import { createServiceClient } from "./supabase";

export type GoalStatus = "active" | "done" | "archived";

const GOAL_COLS =
  "id,title,description,cadence,target,progress,status,created_at,updated_at";

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  cadence: string | null;
  target: number | null;
  progress: number;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  cadence?: string;
  target?: number;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string;
  cadence?: string;
  target?: number;
  progress?: number;
  status?: GoalStatus;
}

export async function getGoals(status?: GoalStatus): Promise<Goal[]> {
  const db = createServiceClient();
  let q = db.from("goals").select(GOAL_COLS);
  if (status) q = q.eq("status", status);
  else q = q.neq("status", "archived");
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Goal[];
}

export async function createGoal(input: CreateGoalInput): Promise<Goal> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("goals")
    .insert(input)
    .select(GOAL_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as Goal;
}

export async function updateGoal(
  id: string,
  input: UpdateGoalInput
): Promise<Goal> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("goals")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(GOAL_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No goal found with id "${id}"`);
  return data as Goal;
}

export async function deleteGoal(id: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from("goals").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Bump progress by `by` (default 1), auto-complete when target reached.
export async function incrementGoalProgress(
  id: string,
  by = 1
): Promise<Goal> {
  const db = createServiceClient();
  const { data: cur, error: e1 } = await db
    .from("goals")
    .select("progress,target,status")
    .eq("id", id)
    .maybeSingle();
  if (e1) throw new Error(e1.message);
  if (!cur) throw new Error(`No goal found with id "${id}"`);

  const progress = (cur.progress ?? 0) + by;
  const status: GoalStatus =
    cur.target != null && progress >= cur.target ? "done" : (cur.status as GoalStatus);

  return updateGoal(id, { progress, status });
}
