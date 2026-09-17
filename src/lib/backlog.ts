import { createServiceClient } from "./supabase";

// --- the backlog ------------------------------------------------------------
//
// The ammunition the coach was missing. Three reads, each answering a different
// shape of neglect:
//
//   stalled     — a MILESTONE that is not done and has had nothing attached to
//                 it (no item created or completed) for two weeks. This is the
//                 one that matters most: a stalled milestone is a goal with no
//                 next step, which is precisely what the coach could not see.
//   unscheduled — active todos the user captured but never put on a day
//                 (planned_for is null). The backlog in the ordinary sense.
//   ideas       — ideas captured and never turned into a step.
//
// Two rules shape the whole module.
//
// 1. Best-effort, always. Every read is wrapped so a missing table or a failed
//    query yields an EMPTY GROUP rather than an error. A broken milestones
//    table must not cost the user his backlog as well.
//
// 2. The block is silent when there is nothing to say. With all three groups
//    empty, formatBacklogForContext returns "" — no heading, no zero-count line
//    — so an empty backlog never reaches the model as a section it feels
//    obliged to fill.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The window after which a milestone with no activity counts as stalled. */
export const STALLED_DAYS = 14;

/** Milestones we will show. The oldest matter most, so this is a hard cap. */
const MAX_STALLED = 6;
/** Unscheduled todos we will show, highest priority / oldest first. */
const MAX_UNSCHEDULED = 10;
/** Ideas have the weakest claim on a line, so only the oldest three. */
const MAX_IDEAS = 3;

/** A milestone nothing has touched in STALLED_DAYS. */
export interface StalledMilestone {
  id: string;
  title: string;
  /** The goal the milestone belongs to — the reason the stall matters. */
  goal: string;
  /** Whole days since the last related activity (or since the milestone began). */
  daysSince: number;
  /** The title of the most recent related item, if any ever existed. */
  lastTaskTitle: string | null;
}

/** An active todo the user never put on a day. */
export interface UnscheduledTodo {
  id: string;
  title: string;
  ageDays: number;
  priority: number;
  goal: string | null;
  due_date: string | null;
}

/** An idea captured and never turned into a step. */
export interface BacklogIdea {
  id: string;
  title: string;
  ageDays: number;
}

export interface Backlog {
  stalled: StalledMilestone[];
  unscheduled: UnscheduledTodo[];
  ideas: BacklogIdea[];
  /** True when all three groups are empty — the block must then render as "". */
  empty: boolean;
}

// --- arithmetic -------------------------------------------------------------

/**
 * Whole elapsed days since an ISO timestamp, floored and NEVER negative — a
 * timestamp in the future reads 0 rather than "-2 days". 0 for a missing or
 * unparseable value too: an unknown age is not worth losing a line over.
 */
function ageDaysFrom(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

// --- reads ------------------------------------------------------------------

interface MilestoneRow {
  id: string;
  goal_id: string;
  title: string;
  done: boolean;
  created_at: string;
}

/** Every not-done milestone, with its goal's title. [] on any failure. */
async function readOpenMilestones(): Promise<
  { milestone: MilestoneRow; goal: string }[]
> {
  try {
    const db = createServiceClient();
    const [{ data: msData, error: msErr }, { data: goalData, error: goalErr }] =
      await Promise.all([
        db
          .from("goal_milestones")
          .select("id,goal_id,title,done,created_at")
          .eq("done", false),
        db.from("goals").select("id,title"),
      ]);
    if (msErr) throw new Error(msErr.message);
    if (goalErr) throw new Error(goalErr.message);

    const goalTitle = new Map<string, string>();
    for (const g of (goalData ?? []) as { id: string; title: string }[]) {
      goalTitle.set(g.id, g.title);
    }
    return ((msData ?? []) as MilestoneRow[]).map((milestone) => ({
      milestone,
      goal: goalTitle.get(milestone.goal_id) ?? "(unknown goal)",
    }));
  } catch {
    return [];
  }
}

/**
 * The most recent activity on each milestone: the newest item referencing it,
 * whether the reference came from the item being CREATED or COMPLETED.
 *
 * There is no completed_at column, so "completed" is read as an item whose
 * status is done — whose updated_at is when it was finished. A live item's
 * meaningful timestamp is when it was created. The later of the two is the last
 * time anyone touched the milestone.
 */
async function readMilestoneActivity(): Promise<
  Map<string, { lastAt: string; lastTaskTitle: string }>
> {
  const out = new Map<string, { lastAt: string; lastTaskTitle: string }>();
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("items")
      .select("milestone_id,title,status,created_at,updated_at")
      .not("milestone_id", "is", null);
    if (error) throw new Error(error.message);

    for (const row of (data ?? []) as {
      milestone_id: string | null;
      title: string;
      status: string;
      created_at: string;
      updated_at: string;
    }[]) {
      const id = row.milestone_id;
      if (!id) continue;
      // A done item was COMPLETED at updated_at; a live one was CREATED at
      // created_at. Take whichever is the more recent touch.
      const at = row.status === "done" ? row.updated_at : row.created_at;
      const stamp = Date.parse(at);
      if (Number.isNaN(stamp)) continue;
      const prev = out.get(id);
      if (!prev || stamp > Date.parse(prev.lastAt)) {
        out.set(id, { lastAt: at, lastTaskTitle: row.title });
      }
    }
  } catch {
    return out;
  }
  return out;
}

async function readUnscheduled(): Promise<UnscheduledTodo[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("items")
      .select("id,title,priority,goal_id,due_date,created_at")
      .eq("type", "todo")
      .eq("status", "active")
      .is("planned_for", null)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(MAX_UNSCHEDULED);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as {
      id: string;
      title: string;
      priority: number | null;
      goal_id: string | null;
      due_date: string | null;
      created_at: string;
    }[];

    const goalTitle = await readGoalTitles(rows.map((r) => r.goal_id));
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      ageDays: ageDaysFrom(r.created_at, now),
      priority: r.priority ?? 3,
      goal: r.goal_id ? (goalTitle.get(r.goal_id) ?? null) : null,
      due_date: r.due_date,
    }));
  } catch {
    return [];
  }
}

async function readIdeas(): Promise<BacklogIdea[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("items")
      .select("id,title,created_at")
      .eq("type", "idea")
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(MAX_IDEAS);
    if (error) throw new Error(error.message);

    const now = Date.now();
    return ((data ?? []) as { id: string; title: string; created_at: string }[]).map(
      (r) => ({ id: r.id, title: r.title, ageDays: ageDaysFrom(r.created_at, now) })
    );
  } catch {
    return [];
  }
}

/** Goal titles for the given ids, best-effort — [] on any failure. */
async function readGoalTitles(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  try {
    const db = createServiceClient();
    const { data, error } = await db.from("goals").select("id,title").in("id", wanted);
    if (error) throw new Error(error.message);
    for (const g of (data ?? []) as { id: string; title: string }[]) {
      out.set(g.id, g.title);
    }
  } catch {
    return out;
  }
  return out;
}

// --- assembly ---------------------------------------------------------------

/**
 * The backlog. Never throws: a failed read yields an empty group, and a failure
 * of all three yields `empty: true`.
 */
export async function getBacklog(): Promise<Backlog> {
  const now = Date.now();

  const openMilestones = await readOpenMilestones();
  const activity = await readMilestoneActivity();
  const cutoff = now - STALLED_DAYS * MS_PER_DAY;

  const stalled: StalledMilestone[] = [];
  for (const { milestone, goal } of openMilestones) {
    const last = activity.get(milestone.id);
    // No item ever referenced it → the milestone's own creation is the last
    // moment anything happened on it.
    const lastAt = last?.lastAt ?? milestone.created_at;
    const stamp = Date.parse(lastAt);
    if (Number.isNaN(stamp)) continue;
    if (stamp >= cutoff) continue; // something moved it recently → not stalled

    stalled.push({
      id: milestone.id,
      title: milestone.title,
      goal,
      daysSince: ageDaysFrom(lastAt, now),
      lastTaskTitle: last?.lastTaskTitle ?? null,
    });
  }
  stalled.sort((a, b) => b.daysSince - a.daysSince);

  const [unscheduled, ideas] = await Promise.all([readUnscheduled(), readIdeas()]);

  const cappedStalled = stalled.slice(0, MAX_STALLED);
  return {
    stalled: cappedStalled,
    unscheduled,
    ideas,
    empty: cappedStalled.length === 0 && unscheduled.length === 0 && ideas.length === 0,
  };
}

// --- formatting -------------------------------------------------------------

/** About fifteen lines is the budget; past that it is a report, not ammunition. */
const MAX_LINES = 15;

// One backlog line must never become two lines of screen.
function oneLine(value: string): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function ageLabel(days: number): string {
  if (days <= 0) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Render the backlog as a SHORT plain block, phrased so the model can see the
 * SHAPE of the neglect:
 *
 *   - stalled 23 days: Gehalts- und Rollengespraech (goal: Move toward a leadership role)
 *
 * "" when all three groups are empty — a heading with nothing under it invites
 * the model to fill it. Pure: same backlog in, same text out.
 */
export function formatBacklogForContext(backlog: Backlog): string {
  const lines: string[] = [];

  if (backlog.stalled.length) {
    lines.push("Stalled (a goal with no next step in two weeks):");
    for (const m of backlog.stalled) {
      const lastTask = m.lastTaskTitle
        ? `, last touch: ${oneLine(m.lastTaskTitle)}`
        : ", nothing ever attached";
      lines.push(
        `- stalled ${ageLabel(m.daysSince)}: ${oneLine(m.title)} (goal: ${oneLine(m.goal)}${lastTask})`
      );
    }
  }

  if (backlog.unscheduled.length) {
    lines.push("Unscheduled (active, never put on a day):");
    for (const t of backlog.unscheduled) {
      const goal = t.goal ? ` (goal: ${oneLine(t.goal)})` : "";
      const due = t.due_date ? ` [due ${t.due_date}]` : "";
      lines.push(
        `- waiting ${ageLabel(t.ageDays)}, P${t.priority}: ${oneLine(t.title)}${goal}${due}`
      );
    }
  }

  if (backlog.ideas.length) {
    lines.push("Ideas captured but never turned into a step:");
    for (const i of backlog.ideas) {
      lines.push(`- ${ageLabel(i.ageDays)} old: ${oneLine(i.title)}`);
    }
  }

  return lines.slice(0, MAX_LINES).join("\n");
}
