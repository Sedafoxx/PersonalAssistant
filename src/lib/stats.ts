// Client-safe life-stat constants + types. NO server deps (keeps the OpenAI
// SDK and the rest of journal.ts out of the client bundle). Keep in sync w/ UI.

// The five life-stats an entry can feed.
export const STAT_KEYS = [
  "health",
  "focus",
  "social",
  "creativity",
  "discipline",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Partial<Record<StatKey, number>>;

// XP earned for completing a todo, scaled by priority (1 = critical .. 5 = someday).
// p1:25, p2:20, p3:15, p4:10, p5:5 — comparable to a journal entry (10-25).
export function xpForTask(priority: number): number {
  const p = Math.min(5, Math.max(1, Math.round(priority || 3)));
  return 5 + (5 - p) * 5;
}
