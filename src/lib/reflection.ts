import { createServiceClient } from "./supabase";
import { todayLocal } from "./dates";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface DailyReflection {
  id: string;
  day: string; // YYYY-MM-DD
  checklist: ChecklistItem[];
  went_well: string | null;
  could_improve: string | null;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

export const REFLECTION_COLS =
  "id,day,checklist,went_well,could_improve,completed,created_at,updated_at";

// Default evening checklist — a light ritual before bed. The "journal" item is
// auto-synced with whether a journal entry exists for the day.
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { id: "journal", label: "Journaled today", done: false },
  { id: "plan", label: "Planned tomorrow's top 3", done: false },
  { id: "screens", label: "Screens away 1h before bed", done: false },
  { id: "move", label: "Moved my body", done: false },
  { id: "water", label: "Drank enough water", done: false },
  { id: "gratitude", label: "Noticed one good thing", done: false },
];

// Today's date as YYYY-MM-DD in the user's zone.
//
// This used to slice a UTC ISO string, which is a different day from the
// Europe/Vienna day between 22:00 and 24:00 UTC — so an evening reflection
// written after midnight in Vienna was filed under the previous day, against a
// Today window that had already rolled over. todayLocal() is the one shared
// definition, so every module agrees.
export function todayISO(): string {
  return todayLocal();
}

export async function getReflection(
  day: string
): Promise<DailyReflection | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("daily_reflections")
    .select(REFLECTION_COLS)
    .eq("day", day)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DailyReflection) ?? null;
}

export interface UpsertReflectionInput {
  day: string;
  checklist?: ChecklistItem[];
  went_well?: string | null;
  could_improve?: string | null;
  completed?: boolean;
}

export async function upsertReflection(
  input: UpsertReflectionInput
): Promise<DailyReflection> {
  const db = createServiceClient();
  const row: Record<string, unknown> = {
    day: input.day,
    updated_at: new Date().toISOString(),
  };
  if (input.checklist !== undefined) row.checklist = input.checklist;
  if (input.went_well !== undefined) row.went_well = input.went_well || null;
  if (input.could_improve !== undefined)
    row.could_improve = input.could_improve || null;
  if (input.completed !== undefined) row.completed = input.completed;

  const { data, error } = await db
    .from("daily_reflections")
    .upsert(row, { onConflict: "day" })
    .select(REFLECTION_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as DailyReflection;
}

// Most recent completed reflections (for the "recent" list).
export async function getReflectionHistory(limit = 20): Promise<DailyReflection[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("daily_reflections")
    .select(REFLECTION_COLS)
    .eq("completed", true)
    .order("day", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as DailyReflection[];
}

// Consecutive completed days ending today or yesterday.
export async function getReflectionStreak(): Promise<number> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("daily_reflections")
    .select("day")
    .eq("completed", true);
  if (error) throw new Error(error.message);

  const days = new Set((data ?? []).map((r) => r.day as string));
  if (days.size === 0) return 0;

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (!days.has(iso(today)) && !days.has(iso(yesterday))) return 0;

  let streak = 0;
  const cursor = new Date(today);
  if (!days.has(iso(today))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(iso(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// True if today's reflection has been completed (used by the evening nudge).
export async function hasReflectionToday(): Promise<boolean> {
  const r = await getReflection(todayISO());
  return !!r?.completed;
}
