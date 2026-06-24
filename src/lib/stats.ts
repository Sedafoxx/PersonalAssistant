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
