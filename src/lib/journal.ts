import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { embed } from "./embeddings";
import { getGoals, incrementGoalProgress, type Goal } from "./goals";
import { STAT_KEYS, type StatKey, type Stats } from "./stats";

// Re-export so existing server-side imports of these from "@/lib/journal" keep
// working. The values themselves live in the client-safe ./stats module.
export { STAT_KEYS };
export type { StatKey, Stats };

// The journal brain uses the same OpenAI-compatible config as the chat brain
// (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL), so it follows the DeepSeek switch.
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

const JOURNAL_COLS =
  "id,raw_text,summary,mood,sentiment,topics,categories,stats,xp,created_at";

export interface JournalEntry {
  id: string;
  raw_text: string;
  summary: string | null;
  mood: string | null;
  sentiment: number | null;
  topics: string[];
  categories: string[];
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
  tasksXp: number; // XP earned from completed todos (subset of totalXp)
  tasksCompleted: number;
}

// --- life categories --------------------------------------------------------

export interface Category {
  id: string;
  name: string;
  description: string | null;
  is_auto: boolean;
}

export async function getCategories(): Promise<Category[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("journal_categories")
    .select("id,name,description,is_auto")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Category[];
}

export async function createCategory(
  name: string,
  description?: string
): Promise<Category> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("journal_categories")
    .insert({ name: name.trim(), description: description ?? null, is_auto: true })
    .select("id,name,description,is_auto")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Category;
}

// --- long-term memories -----------------------------------------------------

export interface Memory {
  id: string;
  text: string;
  category: string | null;
  created_at: string;
}

export async function getMemories(limit = 50): Promise<Memory[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("journal_memories")
    .select("id,text,category,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as Memory[];
}

export async function addMemory(text: string, category?: string | null): Promise<void> {
  const db = createServiceClient();
  const clean = text.trim();
  if (!clean) return;
  const { error } = await db
    .from("journal_memories")
    .insert({ text: clean, category: category ?? null });
  if (error) throw new Error(error.message);
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

// --- AI enrichment (summary, mood, stats, categories, memories) -------------

interface Enrichment {
  summary: string;
  mood: string;
  sentiment: number;
  topics: string[];
  stats: Stats;
  advancedGoals: string[]; // titles of goals this entry shows progress toward
  categories: string[]; // chosen from the provided category list
  suggestedNewCategory: string | null; // new category to auto-create if one is emerging
  memories: { text: string; category: string | null }[]; // long-term notes to save
}

const ENRICH_SYSTEM = `You analyze a personal journal entry and return structured JSON.
Return ONLY a JSON object with these keys:
- "summary": one or two sentence recap of the entry.
- "mood": a single short word for the emotional tone (e.g. "energized", "anxious", "content").
- "sentiment": a number from -1 (very negative) to 1 (very positive).
- "topics": array of 1-5 short lowercase topic tags.
- "stats": object scoring how much this entry reflects effort/progress in each life area, each 0-3 (0 = not mentioned). Keys: health, focus, social, creativity, discipline.
- "advanced_goals": array of goal titles (chosen ONLY from the provided active-goals list) that this entry shows concrete progress toward. Empty array if none clearly advanced. Match exact titles from the list.
- "categories": array of 1-3 category names chosen ONLY from the provided category list that best fit this entry.
- "suggested_new_category": if this entry keeps returning to a recurring theme that is NOT covered by the provided categories, suggest ONE short new category name (e.g. "Personal Projects"). Otherwise null.
- "memories": array of 0-3 short long-term memory notes worth remembering about this person's life (people, situations, patterns, decisions). Each object: {"text": "...", "category": <one of the provided categories, or null>}.
Be conservative — only award stat points, goal progress, and new categories when the entry clearly warrants it.`;

export async function enrich(
  text: string,
  goalTitles: string[] = [],
  categoryNames: string[] = [],
  memoryContext: string[] = []
): Promise<Enrichment> {
  const goalContext =
    goalTitles.length > 0
      ? `\n\nActive goals (use exact titles for advanced_goals):\n${goalTitles
          .map((t) => `- ${t}`)
          .join("\n")}`
      : "\n\nNo active goals — return [] for advanced_goals.";
  const catContext =
    categoryNames.length > 0
      ? `\n\nLife categories (choose categories ONLY from these): ${categoryNames.join(", ")}`
      : "\n\nNo categories yet — return [] for categories.";
  const memContext =
    memoryContext.length > 0
      ? `\n\nLong-term memories so far:\n${memoryContext.map((m) => `- ${m}`).join("\n")}`
      : "\n\nNo long-term memories yet.";

  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: ENRICH_SYSTEM + goalContext + catContext + memContext,
      },
      { role: "user", content: text.slice(0, 8000) },
    ],
  });
  const raw = res.choices[0].message.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<Enrichment> & {
    advanced_goals?: string[];
    suggested_new_category?: string | null;
  };
  const stats: Stats = {};
  for (const k of STAT_KEYS) {
    const v = Math.round(Number((parsed.stats ?? {})[k] ?? 0));
    if (v > 0) stats[k] = Math.min(3, Math.max(0, v));
  }
  const advancedGoals = Array.isArray(parsed.advanced_goals)
    ? parsed.advanced_goals.filter((t) => goalTitles.includes(t))
    : [];
  const categories = Array.isArray(parsed.categories)
    ? parsed.categories.filter((c) => categoryNames.includes(c)).slice(0, 3)
    : [];
  const suggestedNewCategory =
    typeof parsed.suggested_new_category === "string" &&
    parsed.suggested_new_category.trim().length > 0
      ? parsed.suggested_new_category.trim().slice(0, 60)
      : null;
  const memories = Array.isArray(parsed.memories)
    ? parsed.memories
        .slice(0, 3)
        .map((m) => ({
          text: String(m?.text ?? "").trim().slice(0, 500),
          category: m?.category && typeof m.category === "string" ? m.category : null,
        }))
        .filter((m) => m.text.length > 0)
    : [];
  return {
    summary: parsed.summary ?? "",
    mood: parsed.mood ?? "",
    sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment ?? 0))),
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 5) : [],
    stats,
    advancedGoals,
    categories,
    suggestedNewCategory,
    memories,
  };
}

// --- guided reflection ------------------------------------------------------

export interface ReflectOpts {
  categories: string[];
  memories: string[];
  goals: string[];
  history: { role: "user" | "assistant"; content: string }[];
  // Session opener context (the app asks first). When provided, the reflection
  // starts a FRESH daily session instead of re-processing a previous one.
  todayLabel?: string; // e.g. "Monday, 6 September"
  todayEntries?: string[]; // short summaries of what was logged today
}

// Fresh daily opener — used when a new reflection session starts (empty
// history). It greets for the current day and asks today's first question. The
// AI may use background memories/goals to "connect the dots", but it must NOT
// act like it is mid-conversation or re-litigate past sessions.
const REFLECT_OPEN_SYSTEM = `You are the user's warm, casual reflection partner in a journaling app — a thoughtful friend, not a therapist. Never clinical, never over-medicalizing.

A NEW daily reflection session is starting. Treat it as a fresh start for the day — do NOT continue any earlier conversation or re-ask about old entries. You still remember the user's life areas, goals, and long-term memories, and you may weave them in as background to make the reflection feel personal ("connect the dots"), but the focus is TODAY.

Rules:
- If the user has already journaled today, greet warmly and open today's reflection by lightly reflecting back on what they wrote today, then ask ONE short follow-up to go a little deeper.
- If they haven't journaled today yet, greet them for the day and ask ONE natural opening question to get the reflection going (e.g. how the day is going, what's on their mind right now, what they want to reflect on this evening).
- Keep each reply to 1-3 sentences. Warm, casual, real — like a good friend. Ask exactly ONE question.
- If the user shares something worth remembering long-term, capture it as a memory.

Return ONLY JSON: {"reply": "...", "memory": {"text": "...", "category": <category name or null>} | null}`;

// Continuation — used once the session already has messages. The transcript
// keeps the thread going within the same session.
const REFLECT_CONTINUE_SYSTEM = `You are the user's warm, casual reflection partner in a journaling app — a thoughtful friend, not a therapist. Never clinical, never over-medicalizing.

The user is in the middle of today's reflection session. Keep it going naturally, one question at a time, helping them fill out their "life status" across categories (Health, Work, Relationships, Money, Personal Growth, Fun & Leisure, and any that emerged).

Rules:
- Briefly reflect back in one sentence, then ask exactly ONE next question. Never ask more than one question per reply.
- Weave in their goals and what you remember about them when relevant.
- Keep each reply to 1-3 sentences. Warm, casual, real — like a good friend.
- If the user shares something worth remembering long-term, capture it as a memory.

Return ONLY JSON: {"reply": "...", "memory": {"text": "...", "category": <category name or null>} | null}`;

export interface ReflectResult {
  reply: string;
  memory: { text: string; category: string | null } | null;
}

export async function reflect(
  entryText: string,
  opts: ReflectOpts
): Promise<ReflectResult> {
  const isOpener = opts.history.length === 0;

  const sharedCtx = [
    opts.categories.length
      ? `Life categories: ${opts.categories.join(", ")}`
      : "",
    opts.goals.length ? `Their active goals: ${opts.goals.join(", ")}` : "",
    opts.memories.length
      ? `What you remember about them:\n${opts.memories
          .map((m) => `- ${m}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let system = REFLECT_CONTINUE_SYSTEM;
  let userContent: string;

  if (isOpener) {
    system = REFLECT_OPEN_SYSTEM;
    const dayLine = opts.todayLabel ? `Today is ${opts.todayLabel}.` : "";
    const todayCtx =
      opts.todayEntries && opts.todayEntries.length > 0
        ? `What the user logged today:\n${opts.todayEntries
            .map((e) => `- ${e.slice(0, 500)}`)
            .join("\n")}`
        : "The user has not logged anything today yet.";
    userContent = [dayLine, todayCtx, sharedCtx].filter(Boolean).join("\n\n");
  } else {
    const historyCtx = `The user's latest journal entry:\n${entryText.slice(0, 4000)}`;
    // DeepSeek's json_object mode can return whitespace-only content when the
    // request ends on a user turn that directly follows an assistant turn. To
    // avoid that, embed the running conversation as a transcript inside the
    // single user context message instead of passing separate chat turns.
    const transcript = opts.history
      .map((h) =>
        h.role === "assistant" ? `You said: ${h.content}` : `The user said: ${h.content}`
      )
      .join("\n");
    userContent = `${historyCtx}\n\n${sharedCtx}\n\nConversation so far:\n${transcript}\n\nContinue the conversation — ask your next question in JSON.`;
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages,
  });
  const raw = (res.choices[0].message.content ?? "").trim();
  try {
    const parsed = JSON.parse(raw) as Partial<ReflectResult>;
    const reply = (parsed.reply ?? "").trim();
    const memory =
      parsed.memory && typeof parsed.memory === "object" && parsed.memory.text
        ? {
            text: String(parsed.memory.text).trim().slice(0, 500),
            category: parsed.memory.category && typeof parsed.memory.category === "string"
              ? parsed.memory.category
              : null,
          }
        : null;
    return { reply: reply || "Want to tell me more about that?", memory };
  } catch {
    // Non-JSON fallback: treat the whole output as the reply.
    return { reply: raw.slice(0, 2000) || "Tell me more?", memory: null };
  }
}

// --- db --------------------------------------------------------------------

export interface CreateEntryResult {
  entry: JournalEntry;
  advancedGoals: Goal[]; // goals whose progress was bumped by this entry
  newCategory?: Category; // category the AI auto-created, if any
}

export async function createJournalEntry(
  rawText: string
): Promise<CreateEntryResult> {
  const db = createServiceClient();

  const [activeGoals, categories, memories] = await Promise.all([
    getGoals("active"),
    getCategories(),
    getMemories(50),
  ]);
  const e = await enrich(
    rawText,
    activeGoals.map((g) => g.title),
    categories.map((c) => c.name),
    memories.map((m) => m.text)
  );
  const xp = xpForEntry(e.stats);
  const embedding = await embed(`${rawText}\n${e.summary}`);

  // Auto-create a new category if one is clearly emerging and not yet present.
  let newCategory: Category | undefined;
  let finalCategories = e.categories;
  if (e.suggestedNewCategory) {
    const name = e.suggestedNewCategory.trim();
    if (
      name &&
      !categories.some((c) => c.name.toLowerCase() === name.toLowerCase())
    ) {
      try {
        newCategory = await createCategory(name, "Auto-created by the journal AI");
        finalCategories = [...finalCategories, name];
      } catch {
        // category race / duplicate — non-fatal
      }
    }
  }

  const { data, error } = await db
    .from("journal_entries")
    .insert({
      raw_text: rawText,
      summary: e.summary,
      mood: e.mood,
      sentiment: e.sentiment,
      topics: e.topics,
      categories: finalCategories,
      stats: e.stats,
      xp,
      embedding,
    })
    .select(JOURNAL_COLS)
    .single();
  if (error) throw new Error(error.message);

  // Save long-term memories the AI surfaced from this entry.
  for (const m of e.memories) {
    try {
      await addMemory(m.text, m.category);
    } catch {
      // non-fatal
    }
  }

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

  return { entry: data as JournalEntry, advancedGoals, newCategory };
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

// Current journaling streak (consecutive days with an entry, ending today or
// yesterday). Used by the reflection tab to link the habit together.
export async function getJournalStreak(): Promise<number> {
  const db = createServiceClient();
  const { data, error } = await db.from("journal_entries").select("created_at");
  if (error) throw new Error(error.message);
  return computeStreak((data ?? []).map((r) => r.created_at));
}

export async function getLifeStats(): Promise<LifeStats> {
  const db = createServiceClient();
  const [journalRes, taskRes] = await Promise.all([
    db.from("journal_entries").select("xp,stats,created_at"),
    db.from("items").select("xp_awarded").gt("xp_awarded", 0),
  ]);
  if (journalRes.error) throw new Error(journalRes.error.message);
  if (taskRes.error) throw new Error(taskRes.error.message);

  const rows = (journalRes.data ?? []) as {
    xp: number;
    stats: Stats;
    created_at: string;
  }[];
  const taskRows = (taskRes.data ?? []) as { xp_awarded: number }[];

  const journalXp = rows.reduce((s, r) => s + (r.xp ?? 0), 0);
  const tasksXp = taskRows.reduce((s, r) => s + (r.xp_awarded ?? 0), 0);
  const totalXp = journalXp + tasksXp;

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
    tasksXp,
    tasksCompleted: taskRows.length,
  };
}
