import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { getGoals, type Goal } from "./goals";
import { getJournalEntries } from "./journal";
import { getItems, createItem, type Item } from "./db";
import { getReflection, getReflectionStreak, type ChecklistItem } from "./reflection";
import { listUpcomingEvents, createEvent } from "./calendar";
import { getDay, getDayMetrics, listLeftovers } from "./day";
import { getMilestonesByGoal } from "./milestones";
import { logicalDay } from "./dates";
import { formatForContext, upsertFact, curateTopic } from "./memory";

// --- types ------------------------------------------------------------------

export type CheckinKind = "morning" | "evening";

export type ActionDomain =
  | "books"
  | "fitness"
  | "food"
  | "habits"
  | "reflection"
  | "social"
  | "work"
  | "money"
  | "fun"
  | "other";

export type CheckinStatus = "proposed" | "done" | "skipped" | "failed";

export const CHECKIN_COLS =
  "id,kind,day,mood,energy,focus,question,answer,went_well,could_improve,next_action,next_action_domain,next_action_goal,next_action_due,status,feedback,outcome,plan,created_at,updated_at";

export interface Checkin {
  id: string;
  kind: CheckinKind;
  day: string; // YYYY-MM-DD
  mood: number | null;
  energy: number | null;
  focus: string | null;
  question: string | null;
  answer: string | null;
  went_well: string | null;
  could_improve: string | null;
  next_action: string | null;
  next_action_domain: ActionDomain | null;
  next_action_goal: string | null;
  next_action_due: string | null;
  status: CheckinStatus;
  feedback: string | null;
  outcome: string | null;
  plan: DayPlan | null;
  created_at: string;
  updated_at: string;
}

// The user's local day, from the one shared definition in dates.ts.
//
// This used to compute the day from getTimezoneOffset(), which reports the
// SERVER's zone — on Vercel that is UTC. Between 22:00 and 24:00 UTC it
// therefore returned yesterday's date for a user in Vienna, so evening check-ins
// and the whole coach day key were filed a day early.
//
// It is logicalDay() now, not the calendar date: before 04:00 local this is the
// day that just ended, so a reflection written at 1am is still counted against
// the day it belongs to.
export function localDay(): string {
  return logicalDay();
}

// --- LLM (mirrors journal.ts reflect(): DeepSeek-safe, single user message) --

let _client: OpenAI | null = null;
function llm(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.LLM_BASE_URL || undefined,
    });
  }
  return _client;
}
const MODEL = process.env.LLM_MODEL ?? "gpt-4o";

const COACH_SYSTEM = `You are the user's proactive life coach — a warm, practical personal trainer for their whole life. Not a therapist, not a to-do app. You help ONE specific person make small, concrete progress toward their goals, one step at a time.

You see their active goals, recent journal moods/topics, past suggestions & feedback, and (sometimes) people they care about. You propose ONE small, specific, time-boxed next action — never a list.

Rules:
- Greet warmly and ask exactly ONE question that moves a goal forward.
- Then propose exactly ONE next action: small, concrete, doable today or this week, tied to one of their goals where possible.
- Respect their life: don't stack suggestions across every domain; pick ONE domain that fits their mood/recent energy. If mood is low, keep it tiny and kind.
- NEVER re-propose an action that appears in the "open past actions" list.
- If they have reflected "went well / could improve", reference it to adapt.
- Keep tone warm, human, concise (2-4 sentences total).

Return ONLY JSON:
{"reply": "your greeting + one question",
 "mood": null,
 "next_action": {"headline": "one concrete action", "domain": "books|fitness|food|habits|reflection|social|work|money|fun|other", "goal": "exact goal title or null", "due": "YYYY-MM-DD or null", "why": "one short sentence"}}`;

export interface CoachAction {
  headline: string;
  domain: ActionDomain;
  goal: string | null; // goal TITLE (resolved to id server-side)
  due: string | null;
  why: string;
}

export interface CoachReply {
  reply: string;
  next_action: CoachAction;
}

// Format one day-plan task as a compact line for the coach prompt, e.g.
// "- [P2, needed] 09:00 Task title" (done tasks are marked so the coach knows).
function formatDayLine(i: Item): string {
  const p = i.priority ?? 3;
  const req = i.required ? "needed" : "optional";
  const time = i.planned_time ? `${i.planned_time} ` : "";
  const done = i.status === "done" ? "[done] " : "";
  const goal = i.goal_id ? " (goal)" : "";
  return `- [P${p}, ${req}] ${time}${done}${i.title}${goal}`;
}

// Compact digest of who the user is right now (memory layer v1).
export async function buildCoachContext(): Promise<string> {
  const db = createServiceClient();
  const [goals, entries, goalState, people, open, memRes] = await Promise.all([
    getGoals("active"),
    getJournalEntries(30),
    db.from("coach_goal_state").select("goal_id,notes,last_action,last_outcome"),
    db.from("coach_people").select("name,relation,notes"),
    db
      .from("coach_checkins")
      .select(CHECKIN_COLS)
      .in("status", ["proposed"])
      .order("day", { ascending: false })
      .limit(10),
    db
      .from("coach_memory")
      .select("kind,text,created_at")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  const parts: string[] = [];

  if (goals.length) {
    parts.push(
      `## Active goals\n` +
        goals
          .map((g) => `- ${g.title}${g.description ? ` — ${g.description}` : ""} [${g.progress}${g.target ? `/${g.target}` : ""}]${g.cadence ? ` (${g.cadence})` : ""}`)
          .join("\n")
    );
  }

  // Today's plan / leftovers / due / milestones — all best-effort so a missing
  // table can never break the check-in or chat. Each source falls back to an
  // empty section.
  let dayTasks: Item[] = [];
  let dayDone = 0;
  let dayTotal = 0;
  let dayDue: Item[] = [];
  try {
    const day = await getDay();
    dayTasks = day.today.slice(0, 10);
    dayDone = day.counts.done;
    dayTotal = day.counts.total;
    dayDue = day.due.slice(0, 10);
  } catch {
    dayTasks = [];
    dayDue = [];
  }

  if (dayOutcomeHasTasks(dayTasks, dayTotal)) {
    parts.push(
      `## Today's plan\n` +
        `${dayDone}/${dayTotal} done\n` +
        dayTasks.map(formatDayLine).join("\n")
    );
  }

  try {
    const leftovers = (await listLeftovers()).slice(0, 10);
    if (leftovers.length) {
      const today = new Date(localDay() + "T00:00:00").getTime();
      parts.push(
        `## Leftovers from earlier days (raise these with the user — do NOT silently carry them)\n` +
          leftovers
            .map((i) => {
              const planned = i.planned_for ? new Date(i.planned_for + "T00:00:00").getTime() : today;
              const ageDays = Math.max(0, Math.round((today - planned) / 864e5));
              return `- [P${i.priority ?? 3}${i.required ? "" : ", optional"}] ${i.title}${
                i.planned_for ? ` (planned ${i.planned_for}, ${ageDays}d old)` : ""
              }`;
            })
            .join("\n")
      );
    }
  } catch {
    // no leftovers section
  }

  if (dayDue.length) {
    parts.push(
      `## Due / overdue\n` +
        dayDue
          .map((i) => `- ${i.title}${i.due_date ? ` (due ${i.due_date})` : ""}`)
          .join("\n")
    );
  }

  try {
    const byGoal = await getMilestonesByGoal(goals.map((g) => g.id));
    const msLines: string[] = [];
    for (const g of goals) {
      const ms = byGoal[g.id] ?? [];
      if (!ms.length) continue;
      msLines.push(
        `- ${g.title} [${g.progress}${g.target ? `/${g.target}` : ""}]:`,
        ...ms.slice(0, 10).map((m) => `  - [${m.done ? "x" : " "}] ${m.title}`)
      );
    }
    if (msLines.length) {
      parts.push(
        `## Milestones per goal (break these into small tasks)\n${msLines.join("\n")}`
      );
    }
  } catch {
    // no milestones section
  }

  if (entries.length) {
    const moodLine = entries
      .slice(0, 14)
      .map((e) => `[${e.mood ?? "?"}] ${(e.summary ?? e.raw_text).slice(0, 140)}`)
      .join("\n");
    parts.push(`## Recent journal (mood + summary, newest first)\n${moodLine}`);
  }

  const gs = (goalState.data ?? []) as { goal_id: string; notes: string | null }[];
  if (gs.length) {
    parts.push(
      `## Coach notes per goal\n` +
        gs.map((s) => `- ${s.goal_id}: ${s.notes ?? ""}`).join("\n")
    );
  }

  const peopleRows = (people.data ?? []) as { name: string; relation: string | null; notes: string | null }[];
  if (peopleRows.length) {
    parts.push(
      `## People the user cares about\n` +
        peopleRows.map((p) => `- ${p.name} (${p.relation ?? "?"}): ${p.notes ?? ""}`).join("\n")
    );
  }

  const openRows = (open.data ?? []) as Checkin[];
  if (openRows.length) {
    parts.push(
      `## Open past actions (do NOT re-propose)\n` +
        openRows.map((o) => `- ${o.next_action ?? ""} [${o.kind} ${o.day}]`).join("\n")
    );
  }

  const memRows = (memRes.data ?? []) as { kind: string; text: string }[];
  if (memRows.length) {
    parts.push(
      `## What you remember about the user (long-term)\n` +
        memRows.map((m) => `- [${m.kind}] ${m.text}`).join("\n")
    );
  }

  // Living memory: maintained (topic, key, value) facts — best-effort so a
  // missing table can never break the chat.
  try {
    const living = await formatForContext();
    if (living) parts.push(living);
  } catch {
    // no living-memory section
  }

  return parts.join("\n\n") || "New user — no data yet.";
}

// A "Today's plan" section is only useful when the day actually has tasks.
function dayOutcomeHasTasks(tasks: Item[], total: number): boolean {
  return total > 0 && tasks.length > 0;
}

// The coach "brain": given a kind + optional hints, returns a greeting/question
// + one proposed next action. Callers persist the result.
export async function coachReply(
  kind: CheckinKind,
  hints?: { mood?: number; energy?: number; focus?: string; yesterday?: string }
): Promise<CoachReply> {
  const context = await buildCoachContext();
  const dayPart = kind === "morning" ? "A MORNING check-in: help them set up today." : "An EVENING check-in: help them wrap up and pick one thing for tomorrow.";
  const hintPart =
    hints?.mood != null ? `\nUser mood today: ${hints.mood}/5.` : "";
  const hintPart2 =
    hints?.focus ? `\nUser focus today: ${hints.focus}` : "";
  const yPart = hints?.yesterday ? `\nYesterday they reflected: ${hints.yesterday}` : "";

  const userContent = `${dayPart}${hintPart}${hintPart2}${yPart}\n\n${context}\n\nNow ask your question and propose one next action (JSON).`;

  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: COACH_SYSTEM },
      { role: "user", content: userContent },
    ],
  });
  const raw = (res.choices[0].message.content ?? "").trim();
  try {
    const p = JSON.parse(raw) as {
      reply?: string;
      next_action?: Partial<CoachAction>;
    };
    const na = p.next_action ?? {};
    const domain = (["books","fitness","food","habits","reflection","social","work","money","fun","other"] as ActionDomain[]).includes(
      na.domain as ActionDomain
    )
      ? (na.domain as ActionDomain)
      : "other";
    return {
      reply: (p.reply ?? "").trim() || "How are things going today?",
      next_action: {
        headline: (na.headline ?? "").trim().slice(0, 300),
        domain,
        goal: na.goal && typeof na.goal === "string" ? na.goal : null,
        due: na.due && /^\d{4}-\d{2}-\d{2}$/.test(na.due) ? na.due : null,
        why: (na.why ?? "").trim().slice(0, 300),
      },
    };
  } catch {
    // Non-JSON fallback: greet and let the caller show a manual prompt.
    return {
      reply: raw.slice(0, 2000) || "How's your day going — what's one thing you want to move forward?",
      next_action: { headline: "", domain: "other", goal: null, due: null, why: "" },
    };
  }
}

// Resolve a proposed action's goal title back to a goal id (matches exact title).
async function resolveGoal(title: string | null): Promise<string | null> {
  if (!title) return null;
  const goals = await getGoals("active");
  return goals.find((g) => g.title.toLowerCase() === title.toLowerCase())?.id ?? null;
}

// --- long-term memory ("backlog") ------------------------------------------

export type MemoryKind =
  | "fact"
  | "person"
  | "preference"
  | "decision"
  | "win"
  | "pattern"
  | "goal_note";

export interface CoachMemory {
  id: string;
  kind: MemoryKind;
  text: string;
  category: string | null;
  source: string | null;
  pinned: boolean;
  created_at: string;
}

const MEMORY_COLS = "id,kind,text,category,source,pinned,created_at";

export async function getCoachMemories(limit = 60): Promise<CoachMemory[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("coach_memory")
    .select(MEMORY_COLS)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as CoachMemory[];
}

export async function addCoachMemory(
  text: string,
  kind: MemoryKind = "fact",
  opts: { category?: string | null; source?: string | null; pinned?: boolean } = {}
): Promise<CoachMemory | null> {
  const clean = text.trim().slice(0, 500);
  if (!clean) return null;
  const db = createServiceClient();
  // de-dupe: skip if a near-identical memory already exists
  const { data: existing } = await db
    .from("coach_memory")
    .select("id,text")
    .ilike("text", clean)
    .limit(1);
  if (existing && existing.length) return null;
  const { data, error } = await db
    .from("coach_memory")
    .insert({
      text: clean,
      kind,
      category: opts.category ?? null,
      source: opts.source ?? "manual",
      pinned: opts.pinned ?? false,
    })
    .select(MEMORY_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CoachMemory) ?? null;
}

// Extract durable memories from a conversation turn (best-effort, non-fatal).
const MEMORY_SYSTEM = `You extract DURABLE, personal memories worth keeping about a specific user from a coaching exchange. Keep only what stays useful weeks later: facts about their life, people, preferences, decisions, wins, recurring patterns, or goal context. Ignore small talk, one-off logistics, and anything mundane.

You ALSO maintain a small structured store of LIVING FACTS, each a (topic, key, value) triple: the topic is a broad area of their life ("Küche & Vorräte", "Ausstattung", "Vorlieben", "Ziele"), the key is the stable thing being talked about, short and generic ("tofu", "diet", "tv"), and the value is its CURRENT state ("in stock", "none left", "vegan").

Rules for facts — these matter:
- A key is a SLOT THAT IS UPDATED, never accumulated. Re-using an existing key with a new value is exactly how the store stays current.
- NEVER express a removal. The opposite of a fact is a new VALUE for the same key: "ich habe keinen Tofu mehr" is key "tofu" with value "none left" — not a deletion.
- Emit a fact only when the exchange genuinely states the value. Do not infer, and do not restate an unchanged value.

Return ONLY JSON:
{"memories":[{"text":"...","kind":"fact|person|preference|decision|win|pattern|goal_note","category":"short topic or null"}],
 "facts":[{"topic":"...","key":"...","value":"..."}]}
- 0-3 memories. Empty array if nothing durable was said.
- 0-6 facts, and an empty array when nothing concrete was stated.
- Each "text" is a compact self-contained sentence starting with "User ...".`;

export async function extractMemories(
  userText: string,
  assistantText: string
): Promise<CoachMemory[]> {
  const exchange = `User: ${userText}\n\nCoach: ${assistantText}`.slice(0, 4000);
  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: MEMORY_SYSTEM },
      { role: "user", content: exchange },
    ],
  });
  const raw = (res.choices[0].message.content ?? "").trim();
  let parsed: {
    memories?: { text?: string; kind?: string; category?: string | null }[];
    facts?: { topic?: string; key?: string; value?: string }[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const KINDS: MemoryKind[] = ["fact", "person", "preference", "decision", "win", "pattern", "goal_note"];
  const saved: CoachMemory[] = [];
  for (const m of (parsed.memories ?? []).slice(0, 3)) {
    const text = (m.text ?? "").trim();
    if (!text) continue;
    const kind = KINDS.includes(m.kind as MemoryKind) ? (m.kind as MemoryKind) : "fact";
    try {
      const row = await addCoachMemory(text, kind, {
        category: m.category ?? null,
        source: "chat",
      });
      if (row) saved.push(row);
    } catch {
      // non-fatal
    }
  }

  // Living memory: merge the structured (topic, key, value) facts. upsertFact
  // supersedes an existing key instead of adding a contradicting row, and it can
  // never delete — a "removed" thing is just a new value.
  //
  // Curation is bounded to the topics that ACTUALLY changed, and to at most 2
  // per turn, because rewriting a topic summary costs a model call each.
  const changedTopics = new Set<string>();
  for (const f of (parsed.facts ?? []).slice(0, 6)) {
    const topic = (f.topic ?? "").trim();
    const key = (f.key ?? "").trim();
    const value = (f.value ?? "").trim();
    if (!topic || !key || !value) continue;
    try {
      const result = await upsertFact({ topic, key, value, source: "chat" });
      if (result.changed && result.fact) changedTopics.add(result.fact.topic_id);
    } catch {
      // non-fatal
    }
  }
  let curated = 0;
  for (const topicId of changedTopics) {
    if (curated >= 2) break;
    curated++;
    try {
      await curateTopic(topicId);
    } catch {
      // non-fatal — a failed rewrite keeps the previous summary
    }
  }

  return saved;
}

// --- habit tracking + daily wins summary -----------------------------------

export interface DailyWins {
  day: string;
  habits_done: number;
  habits_total: number;
  reflection_completed: boolean;
  reflection_streak: number;
  action_status: string | null; // done | skipped | proposed | null
  todos_completed: number;
  planned: number;
  planned_done: number;
  planned_open: number;
  xp: number; // XP earned today from the tasks completed today
  journaled: boolean;
  mood: number | null;
  lines: string[]; // human-readable "wins" for the day
}

// A friendly end-of-day summary of what the user actually accomplished today.
export async function getDailyWins(day = localDay()): Promise<DailyWins> {
  const db = createServiceClient();
  const start = new Date(day + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const reflection = await getReflection(day).catch(() => null);
  const morning = await getCheckin("morning", day).catch(() => null);
  const streak = await getReflectionStreak().catch(() => 0);

  let todos: { title: string }[] = [];
  try {
    const r = await db
      .from("items")
      .select("title")
      .eq("type", "todo")
      .eq("status", "done")
      .gte("updated_at", startIso)
      .lt("updated_at", endIso);
    todos = (r.data ?? []) as { title: string }[];
  } catch {
    todos = [];
  }

  let journaled = false;
  try {
    const r = await db
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startIso)
      .lt("created_at", endIso);
    journaled = (r.count ?? 0) > 0;
  } catch {
    journaled = false;
  }

  // Planned-vs-done for the day. Sourced inside try/catch (never .catch() on a
  // Supabase builder) so a missing table can't break the wins card.
  let planned = 0;
  let plannedDone = 0;
  let plannedOpen = 0;
  let xp = 0;
  try {
    const metrics = await getDayMetrics(day);
    planned = metrics.planned;
    plannedDone = metrics.done;
    plannedOpen = metrics.requiredOpen + metrics.optionalOpen;
    xp = metrics.xpEarned;
  } catch {
    planned = 0;
    plannedDone = 0;
    plannedOpen = 0;
    xp = 0;
  }

  const checklist = reflection?.checklist ?? [];
  const habitsDone = checklist.filter((c: ChecklistItem) => c.done);
  const habitsTotal = checklist.length;

  const lines: string[] = [];
  if (journaled) lines.push("✍️ Journaled today");
  if (habitsDone.length) lines.push(`✅ Habits: ${habitsDone.map((c: ChecklistItem) => c.label).join(", ")}`);
  if (todos.length) lines.push(`📋 Completed ${todos.length} todo${todos.length > 1 ? "s" : ""}: ${todos.map((t) => t.title).slice(0, 4).join(", ")}`);
  if (morning?.status === "done" && morning.next_action) lines.push(`🎯 Coach action done: ${morning.next_action}`);
  if (reflection?.went_well) lines.push(`👍 ${reflection.went_well}`);
  if (streak > 1) lines.push(`🔥 ${streak}-day wake-up-reflection streak`);
  if (planned > 0) lines.push(`✅ Finished ${plannedDone} of ${planned} planned tasks`);

  return {
    day,
    habits_done: habitsDone.length,
    habits_total: habitsTotal,
    reflection_completed: !!reflection?.completed,
    reflection_streak: streak,
    action_status: morning?.status ?? null,
    todos_completed: todos.length,
    planned,
    planned_done: plannedDone,
    planned_open: plannedOpen,
    xp,
    journaled,
    mood: morning?.mood ?? null,
    lines,
  };
}

// --- goal review (for the weekly nudge) ------------------------------------

export interface GoalReview {
  goals: { title: string; progress: number; target: number | null; cadence: string | null }[];
  staleCount: number;
  prompt: string;
}

// Goals that haven't moved recently, packaged for a reflection prompt.
export async function getGoalReview(): Promise<GoalReview> {
  const goals = await getGoals("active").catch(() => [] as Goal[]);
  const db = createServiceClient();
  const { data: state } = await db.from("coach_goal_state").select("goal_id,last_action,updated_at");
  const stateByGoal = new Map(
    ((state ?? []) as { goal_id: string; updated_at: string }[]).map((s) => [s.goal_id, s])
  );
  const now = Date.now();

  const items = goals.map((g) => {
    const s = stateByGoal.get(g.id);
    const since = s?.updated_at ? Math.floor((now - new Date(s.updated_at).getTime()) / 864e5) : null;
    return {
      title: g.title,
      progress: g.progress,
      target: g.target,
      cadence: g.cadence,
      idleDays: since,
    };
  });
  const stale = items.filter((i) => i.progress === 0 || (i.idleDays != null && i.idleDays > 10));
  const named = (stale.length ? stale : items).slice(0, 3).map((i) => i.title);

  return {
    goals: items.map(({ title, progress, target, cadence }) => ({ title, progress, target, cadence })),
    staleCount: stale.length,
    prompt: named.length
      ? `Goal check-in: how are these going — ${named.join(", ")}? Which one deserves attention this week?`
      : "Goal check-in: which goal deserves your attention this week?",
  };
}

// --- db helpers -------------------------------------------------------------

export async function getCheckin(
  kind: CheckinKind,
  day: string
): Promise<Checkin | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("coach_checkins")
    .select(CHECKIN_COLS)
    .eq("kind", kind)
    .eq("day", day)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Checkin) ?? null;
}

export interface SaveCheckinInput {
  kind: CheckinKind;
  day: string;
  mood?: number | null;
  energy?: number | null;
  focus?: string | null;
  question?: string | null;
  answer?: string | null;
  went_well?: string | null;
  could_improve?: string | null;
  next_action?: string | null;
  next_action_domain?: ActionDomain | null;
  next_action_goal?: string | null; // goal TITLE
  next_action_due?: string | null;
  status?: CheckinStatus;
  feedback?: string | null;
  outcome?: string | null;
}

// Upsert a check-in by (kind, day).
export async function saveCheckin(input: SaveCheckinInput): Promise<Checkin> {
  const db = createServiceClient();
  const row: Record<string, unknown> = {
    kind: input.kind,
    day: input.day,
    updated_at: new Date().toISOString(),
  };
  if (input.mood !== undefined) row.mood = input.mood;
  if (input.energy !== undefined) row.energy = input.energy;
  if (input.focus !== undefined) row.focus = input.focus || null;
  if (input.question !== undefined) row.question = input.question || null;
  if (input.answer !== undefined) row.answer = input.answer || null;
  if (input.went_well !== undefined) row.went_well = input.went_well || null;
  if (input.could_improve !== undefined) row.could_improve = input.could_improve || null;
  if (input.next_action !== undefined) row.next_action = input.next_action || null;
  if (input.next_action_domain !== undefined) row.next_action_domain = input.next_action_domain || null;
  if (input.next_action_goal !== undefined) {
    row.next_action_goal = await resolveGoal(input.next_action_goal || null);
  }
  if (input.next_action_due !== undefined) row.next_action_due = input.next_action_due || null;
  if (input.status !== undefined) row.status = input.status;
  if (input.feedback !== undefined) row.feedback = input.feedback || null;
  if (input.outcome !== undefined) row.outcome = input.outcome || null;

  const { data, error } = await db
    .from("coach_checkins")
    .upsert(row, { onConflict: "kind,day" })
    .select(CHECKIN_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Checkin;
}

// Last ~N days of mood (for the sparkline), oldest first.
export async function getMoodHistory(days = 14): Promise<{ day: string; mood: number | null }[]> {
  const db = createServiceClient();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const { data, error } = await db
    .from("coach_checkins")
    .select("day,mood")
    .not("mood", "is", null)
    .gte("day", cutoff.toISOString().slice(0, 10))
    .order("day", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as { day: string; mood: number | null }[];
}

// True if today's morning check-in is still open (proposed, no answer) — used
// by the notification cron to decide whether to nudge.
export async function hasOpenMorningCheckin(day = localDay()): Promise<boolean> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("coach_checkins")
    .select(CHECKIN_COLS)
    .eq("kind", "morning")
    .eq("day", day)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return true; // never started → nudge to do it
  const c = data as Checkin;
  return c.status === "proposed" && !c.answer && c.mood == null;
}

// Append a note to a goal's running state (coach reflection).
export async function updateGoalNote(
  goalId: string | null,
  note: string
): Promise<void> {
  if (!goalId) return;
  const db = createServiceClient();
  const now = new Date().toISOString();
  // read-modify-write so we don't clobber earlier notes
  const { data: cur } = await db
    .from("coach_goal_state")
    .select("notes")
    .eq("goal_id", goalId)
    .maybeSingle();
  const prev = (cur?.notes ?? "").trim();
  const next = prev ? `${prev}\n${note}` : note;
  const { error } = await db.from("coach_goal_state").upsert(
    { goal_id: goalId, notes: next.slice(-3000), updated_at: now },
    { onConflict: "goal_id" }
  );
  if (error) throw new Error(error.message);
}

// --- plan my day ------------------------------------------------------------

export type PlanBlockType = "focus" | "task" | "habit" | "break" | "event" | "social" | "admin";

export interface PlanBlock {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  title: string;
  type: PlanBlockType;
  goal: string | null; // goal title
  why: string;
  required?: boolean; // needed (true) vs optional (false)
  priority?: number; // 1–5, same scale as the rest of the app
}

export interface DayPlan {
  date: string; // YYYY-MM-DD
  headline: string;
  blocks: PlanBlock[];
  note: string; // coach's closing tip
  generated_at: string;
}

const PLAN_SYSTEM = `You are the user's practical day-planner coach. Build a REALISTIC time-blocked plan for TODAY from their calendar, active goals, open todos, and today's mood/focus. Respect existing calendar events as fixed anchors.

Rules:
- Cover the useful waking hours (usually 08:00–22:00). Include meals and at least one real break and downtime in the evening.
- Anchor around existing events (don't overlap them; leave travel/buffer around them).
- Prefer deriving tasks from the user's active-goal MILESTONES: break an open milestone into one small, doable block, and use the exact goal title.
- Tie most working/focus blocks to ONE of their active goals (use the exact goal title), so the day moves goals forward.
- Keep blocks 30–120 min. Max ~10 blocks. Be humane: no back-to-back grind; if mood is low, lighter and fewer.
- Include any urgent open todos as "task" blocks.
- Mark each block "required": true when it genuinely needs doing today (a commitment, a deadline, something the day depends on), and false when it is a nice-to-have. Default to true when unsure.
- Give each block a "priority" from 1 (most important) to 5 (least).
- Times are 24h "HH:MM" local (Europe/Vienna), end > start, non-overlapping, sorted.
- "why" is one short clause. Keep headline to one line.

Return ONLY JSON:
{"headline":"one-line theme for the day",
 "blocks":[{"start":"09:00","end":"10:00","title":"...","type":"focus|task|habit|break|event|social|admin","goal":"exact goal title or null","why":"...","required":true,"priority":2}],
 "note":"one-sentence coach tip"}`;

// Coerce an LLM-supplied priority into the app's 1–5 scale. Anything malformed
// falls back to the same default the old code used (focus → 2, else 3).
function coercePriority(value: unknown, type: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return type === "focus" ? 2 : 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// Build a realistic plan for the day and persist it on the day's morning check-in.
export async function planDay(day = localDay()): Promise<DayPlan> {
  const db = createServiceClient();

  // Gather context (all best-effort — never let one source break the plan).
  const [goals, todos, checkin, calRes] = await Promise.all([
    getGoals("active").catch(() => [] as Goal[]),
    getItems({ type: "todo", status: "active" })
      .then((items) => items.slice(0, 15))
      .catch(() => []),
    getCheckin("morning", day).catch(() => null),
    listUpcomingEvents({ daysAhead: 1, maxResults: 20 }).catch(() => []),
  ]);

  // Today's calendar events (local day).
  const events = calRes
    .filter((e) => (e.start ?? "").slice(0, 10) === day)
    .map((e) => {
      const s = e.start?.slice(11, 16) ?? "all-day";
      const en = e.end?.slice(11, 16) ?? "";
      return `- ${s}${en ? `–${en}` : ""} ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
    });

  const parts: string[] = [];
  parts.push(`Today: ${day} (${new Date(day + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })}).`);
  if (events.length) parts.push(`## Fixed calendar events today\n${events.join("\n")}`);
  else parts.push("## Fixed calendar events today\n(none)");
  if (goals.length)
    parts.push(
      `## Active goals\n${goals.map((g) => `- ${g.title} [${g.progress}${g.target ? `/${g.target}` : ""}]`).join("\n")}`
    );
  if (todos.length)
    parts.push(`## Open todos\n${todos.map((t) => `- ${t.title}`).join("\n")}`);
  if (checkin?.mood != null || checkin?.focus)
    parts.push(
      `## This morning\n${checkin?.mood != null ? `Mood ${checkin.mood}/5. ` : ""}${checkin?.focus ? `Focus they set: ${checkin.focus}` : ""}`.trim()
    );

  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: parts.join("\n\n") + "\n\nBuild today's plan (JSON)." },
    ],
  });
  const raw = (res.choices[0].message.content ?? "").trim();

  let headline = "Your day";
  let note = "";
  let blocks: PlanBlock[] = [];
  const TYPES = ["focus", "task", "habit", "break", "event", "social", "admin"];
  try {
    const p = JSON.parse(raw) as { headline?: string; note?: string; blocks?: Partial<PlanBlock>[] };
    headline = (p.headline ?? "Your day").trim();
    note = (p.note ?? "").trim();
    const hhmm = /^\d{2}:\d{2}$/;
    blocks = (p.blocks ?? [])
      .filter((b) => hhmm.test(String(b.start)) && hhmm.test(String(b.end)))
      .map((b) => ({
        start: String(b.start),
        end: String(b.end),
        title: (b.title ?? "").trim().slice(0, 160),
        type: (TYPES.includes(String(b.type)) ? b.type : "focus") as PlanBlockType,
        goal: typeof b.goal === "string" ? b.goal : null,
        why: (b.why ?? "").trim().slice(0, 200),
        // required defaults to true; only an explicit boolean is honoured.
        required: typeof b.required === "boolean" ? b.required : true,
        // priority is clamped to 1–5; a malformed value falls back to the type default.
        priority: coercePriority(b.priority, String(b.type)),
      }))
      .filter((b) => b.title.length > 0)
      .slice(0, 12);
  } catch {
    headline = raw.slice(0, 120) || "Your day";
  }

  const plan: DayPlan = { date: day, headline, blocks, note, generated_at: new Date().toISOString() };

  // Persist on the day's morning check-in (upsert by kind,day).
  try {
    const { error } = await db
      .from("coach_checkins")
      .upsert({ kind: "morning", day, plan, updated_at: new Date().toISOString() }, { onConflict: "kind,day" });
    if (error) throw new Error(error.message);
  } catch {
    // planning still returns even if persistence fails
  }

  return plan;
}

export interface ApplyPlanInput {
  day: string;
  blocks: PlanBlock[]; // the selected blocks to apply
  asCalendar?: boolean; // create calendar events
  asTodos?: boolean; // create todos for focus/task/habit blocks
}

// Turn selected plan blocks into real calendar events and/or todos.
export async function applyPlan(input: ApplyPlanInput): Promise<{ events: number; todos: number }> {
  let events = 0;
  let todos = 0;

  for (let i = 0; i < input.blocks.length; i++) {
    const b = input.blocks[i];
    if (input.asCalendar) {
      try {
        await createEvent({
          title: b.title,
          start: `${input.day}T${b.start}:00`,
          end: `${input.day}T${b.end}:00`,
          description: [b.goal ? `Goal: ${b.goal}` : "", b.why].filter(Boolean).join(" — "),
        });
        events++;
      } catch {
        // skip on failure (e.g. calendar not connected)
      }
    }
    if (input.asTodos && b.type !== "break") {
      try {
        // Resolve the block's goal TITLE to an id so the todo is tied to the
        // goal; stays null when the title does not match an active goal.
        const goalId = await resolveGoal(b.goal);
        await createItem({
          type: "todo",
          title: b.title,
          content: [b.goal ? `Goal: ${b.goal}` : "", b.why].filter(Boolean).join(" — ") || undefined,
          priority: b.priority ?? (b.type === "focus" ? 2 : 3),
          due_date: input.day,
          tags: ["dayplan", b.type],
          // A confirmed plan *is* the Today list — stamp the day window.
          planned_for: input.day,
          planned_time: b.start,
          day_order: i,
          required: b.required ?? true,
          goal_id: goalId ?? undefined,
        });
        todos++;
      } catch {
        // skip
      }
    }
  }

  return { events, todos };
}
