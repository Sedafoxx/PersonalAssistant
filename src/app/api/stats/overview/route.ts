import { NextResponse } from "next/server";
import { getLifeStats, getJournalStreak, type LifeStats } from "@/lib/journal";
import { getReflectionStreak } from "@/lib/reflection";
import { getGoals, type Goal } from "@/lib/goals";
import {
  getMilestonesByGoal,
  getMilestoneTaskCounts,
  type Milestone,
} from "@/lib/milestones";
import { getTaskTrend, getDayMetrics, getMovementToday, localDay } from "@/lib/day";
import { getMoodHistory } from "@/lib/coach";

export const dynamic = "force-dynamic";

// One call that returns everything the Stats tab needs, so the UI makes a
// single request. Every source is best-effort: one missing table can never
// blank the page, and every number is coerced to a finite value.

const EMPTY_LIFE: LifeStats = {
  totalXp: 0,
  level: 1,
  xpIntoLevel: 0,
  xpForNextLevel: 100,
  streak: 0,
  statTotals: { health: 0, focus: 0, social: 0, creativity: 0, discipline: 0 },
  entryCount: 0,
  tasksXp: 0,
  tasksCompleted: 0,
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function GET() {
  try {
    const life = await getLifeStats().catch(() => EMPTY_LIFE);
    const journalStreak = num(await getJournalStreak().catch(() => 0));
    const reflectionStreak = num(await getReflectionStreak().catch(() => 0));

    const activeGoals: Goal[] = await getGoals("active").catch(() => []);

    let goalsWithMilestones: (Goal & { milestones: Milestone[] })[] = [];
    let milestoneTasks: Record<string, { open: number; done: number }> = {};
    try {
      const grouped = await getMilestonesByGoal(activeGoals.map((g) => g.id));
      goalsWithMilestones = activeGoals.map((g) => ({
        ...g,
        milestones: grouped[g.id] ?? [],
      }));

      // Attached-task tallies so the Stats tab can show "2 open / 3 done".
      const milestoneIds = goalsWithMilestones.flatMap((g) =>
        g.milestones.map((m) => m.id)
      );
      milestoneTasks = await getMilestoneTaskCounts(milestoneIds);
    } catch {
      goalsWithMilestones = activeGoals.map((g) => ({ ...g, milestones: [] }));
      milestoneTasks = {};
    }

    const taskTrend = await getTaskTrend(14).catch(() => []);
    const mood = await getMoodHistory(14).catch(
      () => [] as { day: string; mood: number | null }[]
    );
    const metrics = await getDayMetrics().catch(() => ({
      planned: 0,
      done: 0,
      requiredOpen: 0,
      optionalOpen: 0,
      xpEarned: 0,
    }));
    // "Which parts of life moved today" — same best-effort treatment as every
    // other source, so one failure can never blank the page.
    const movementToday = await getMovementToday().catch(() => ({
      day: localDay(),
      goals: [],
      goalsMoved: 0,
      tasksDone: 0,
      milestonesDone: 0,
    }));

    return NextResponse.json({
      life: {
        ...life,
        totalXp: num(life.totalXp),
        level: num(life.level),
        xpIntoLevel: num(life.xpIntoLevel),
        xpForNextLevel: num(life.xpForNextLevel),
        streak: num(life.streak),
        entryCount: num(life.entryCount),
        tasksXp: num(life.tasksXp),
        tasksCompleted: num(life.tasksCompleted),
      },
      journalStreak,
      reflectionStreak,
      goals: goalsWithMilestones,
      milestoneTasks,
      taskTrend: taskTrend.map((t) => ({
        day: t.day,
        planned: num(t.planned),
        done: num(t.done),
      })),
      mood: mood.map((m) => ({ day: m.day, mood: m.mood == null ? null : num(m.mood) })),
      today: { planned: num(metrics.planned), done: num(metrics.done) },
      movementToday: {
        day: movementToday.day,
        goals: movementToday.goals.map((g) => ({
          goal_id: g.goal_id,
          goal_title: g.goal_title,
          tasks_done: num(g.tasks_done),
          tasks_open: num(g.tasks_open),
          milestones_done: num(g.milestones_done),
        })),
        goalsMoved: num(movementToday.goalsMoved),
        tasksDone: num(movementToday.tasksDone),
        milestonesDone: num(movementToday.milestonesDone),
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
