import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { embed } from "./embeddings";
import { getGoals, incrementGoalProgress, type Goal } from "./goals";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The five life-stats an entry can feed. Keep in sync with the UI.
export const STAT_KEYS = [
  "health",
  "focus",
  "social",
  "creativity",
  "discipline",
] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type Stats = Partial<Record<StatKey, number>>;

const JOURNAL_COLS =
  "id,raw_text,summary,mood,sentiment,topics,stats,xp,created_at";

export interface JournalEntry {
  id: string;
  raw_text: string;
  summary: string | null;
  mood: string | null;
  sentiment: number | null;
  topics: string[];
  stats: Stats;
  xp: number;
  created_at: string;
}

export interface LifeStats {
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  streak: number; // consecutive days ending today (or yesterday) with an entry
  statTotals: Record<StatKey, number>;
  entryCount: number;
}

// --- gamification math -----------------------------------------------------

// 100 XP per level, flat. Simple + predictable.
const XP_PER_LEVEL = 100;

export function levelFor(totalXp: number): {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
} {
  const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;
  const xpIntoLevel = totalXp % XP_PER_LEVEL;
  return { level, xpIntoLevel, xpForNextLevel: XP_PER_LEVEL };
}

// XP awarded for one entry: base + 5 per stat point earned.
export function xpForEntry(stats: Stats): number {
  const statPoints = STAT_KEYS.reduce((sum, k) => sum + (stats[k] ?? 0), 0);
  return 10 + statPoints * 5;
}

// Count back from today: a streak is unbroken if there's an entry today or
// yesterday, then each prior consecutive day.
export function computeStreak(dates: string[]): number {
  const days = new Set(dates.map((d) => d.slice(0, 10))); // YYYY-MM-DD
  if (days.size === 0) return 0;

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  // Streak only counts if logged today or yesterday.
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (!days.has(iso(today)) && !days.has(iso(yesterday))) return 0;

  let streak = 0;
  const cursor = new Date(today);
  if (!days.has(iso(today))) cursor.setDate(cursor.getDate() - 1); // start at yesterday
  while (days.has(iso(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// --- GPT enrichment --------------------------------------------------------

interface Enrichment {
  summary: string;
  mood: string;
  sentiment: number;
  topics: string[];
  stats: Stats;
  advancedGoals: string[]; // titles of goals this entry shows progress toward
}

const ENRICH_SYSTEM = `You analyze a personal journal entry and return structured JSON.
Return ONLY a JSON object with these keys:
- "summary": one or two sentence recap of the entry.
- "mood": a single short word for the emotional tone (e.g. "energized", "anxious", "content").
- "sentiment": a number from -1 (very negative) to 1 (very positive).
- "topics": array of 1-5 short lowercase topic tags.
- "stats": object scoring how much this entry reflects effort/progress in each life area, each 0-3 (0 = not mentioned). Keys: health, focus, social, creativity, discipline.
- "advanced_goals": array of goal titles (chosen ONLY from the provided active-goals list) that this entry shows concrete progress toward. Empty array if none clearly advanced. Match exact titles from the list.
Be conservative — only award stat points and goal progress when the entry clearly shows activity.`;

export async function enrich(
  text: string,
  goalTitles: string[] = []
): Promise<Enrichment> {
  const goalContext =
    goalTitles.length > 0
      ? `\n\nActive goals (use exact titles for advanced_goals):\n${goalTitles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "\n\nNo active goals — return [] for advanced_goals.";

  const res = await client.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ENRICH_SYSTEM + goalContext },
      { role: "user", content: text.slice(0, 8000) },
    ],
  });
  const raw = res.choices[0].message.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<Enrichment> & {
    advanced_goals?: string[];
  };
  const stats: Stats = {};
  for (const k of STAT_KEYS) {
    const v = Math.round(Number((parsed.stats ?? {})[k] ?? 0));
    if (v > 0) stats[k] = Math.min(3, Math.max(0, v));
  }
  const advancedGoals = Array.isArray(parsed.advanced_goals)
    ? parsed.advanced_goals.filter((t) => goalTitles.includes(t))
    : [];
  return {
    summary: parsed.summary ?? "",
    mood: parsed.mood ?? "",
    sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment ?? 0))),
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 5) : [],
    stats,
    advancedGoals,
  };
}

// --- db --------------------------------------------------------------------

export interface CreateEntryResult {
  entry: JournalEntry;
  advancedGoals: Goal[]; // goals whose progress was bumped by this entry
}

export async function createJournalEntry(
  rawText: string
): Promise<CreateEntryResult> {
  const db = createServiceClient();

  const activeGoals = await getGoals("active");
  const e = await enrich(
    rawText,
    activeGoals.map((g) => g.title)
  );
  const xp = xpForEntry(e.stats);
  const embedding = await embed(`${rawText}\n${e.summary}`);

  const { data, error } = await db
    .from("journal_entries")
    .insert({
      raw_text: rawText,
      summary: e.summary,
      mood: e.mood,
      sentiment: e.sentiment,
      topics: e.topics,
      stats: e.stats,
      xp,
      embedding,
    })
    .select(JOURNAL_COLS)
    .single();
  if (error) throw new Error(error.message);

  // Bump progress on any goal the entry advanced.
  const advancedGoals: Goal[] = [];
  for (const title of e.advancedGoals) {
    const goal = activeGoals.find((g) => g.title === title);
    if (!goal) continue;
    try {
      advancedGoals.push(await incrementGoalProgress(goal.id));
    } catch {
      // non-fatal — entry already saved
    }
  }

  return { entry: data as JournalEntry, advancedGoals };
}

export async function getJournalEntries(limit = 50): Promise<JournalEntry[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("journal_entries")
    .select(JOURNAL_COLS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as JournalEntry[];
}

// True if at least one entry exists for today (server-local UTC date).
export async function hasEntryToday(): Promise<boolean> {
  const db = createServiceClient();
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from("journal_entries")
    .select("id", { count: "exact", head: true })
    .gte("created_at", start.toISOString());
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export async function getLifeStats(): Promise<LifeStats> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("journal_entries")
    .select("xp,stats,created_at");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { xp: number; stats: Stats; created_at: string }[];
  const totalXp = rows.reduce((s, r) => s + (r.xp ?? 0), 0);
  const statTotals = Object.fromEntries(
    STAT_KEYS.map((k) => [k, 0])
  ) as Record<StatKey, number>;
  for (const r of rows) {
    for (const k of STAT_KEYS) statTotals[k] += r.stats?.[k] ?? 0;
  }
  const { level, xpIntoLevel, xpForNextLevel } = levelFor(totalXp);
  return {
    totalXp,
    level,
    xpIntoLevel,
    xpForNextLevel,
    streak: computeStreak(rows.map((r) => r.created_at)),
    statTotals,
    entryCount: rows.length,
  };
}
