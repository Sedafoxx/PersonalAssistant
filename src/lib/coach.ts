// Nova's CONTEXT and her daily rituals: the builder that assembles what she
// knows right now (buildAssistantContext), the morning/evening check-in, the day
// plan, mood history, and the memory extraction that runs after a turn.
//
// The file is still named "coach" because these were the Coach tab's features.
// That tab is gone, and the name is now only a label on a bag of features, not a
// second identity: there is ONE assistant, ONE prompt (src/lib/chat.ts) and ONE
// memory store (src/lib/memory.ts). Read "coach" here as "the morning/evening
// ritual", never as "the other agent".
import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { getGoals, type Goal } from "./goals";
import { getJournalEntries } from "./journal";
import { getItems, createItem, type Item } from "./db";
import { getReflection, getReflectionStreak, type ChecklistItem } from "./reflection";
import { listUpcomingEvents, createEvent } from "./calendar";
import { getDay, getDayMetrics, listLeftovers, findDayTaskByTitle } from "./day";
import { getMilestonesByGoal, type Milestone } from "./milestones";
import { logicalDay } from "./dates";
import {
  retrieveMemory,
  upsertFact,
  curateTopic,
  factText,
  type MemoryFact,
  type FactKind,
} from "./memory";
import { embedMany } from "./embeddings";
import { listLoops, staleLoops, type OpenLoop } from "./loops";
import { listCommitments } from "./commitments";
import { getBacklog, formatBacklogForContext } from "./backlog";

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

/** What memory is retrieved against when no message says otherwise. */
export const DEFAULT_MEMORY_INTENT =
  "planning the user's day, moving their goals forward, and what is happening in their life";

/**
 * One thread, in the form a coach can act on: what it is about, where it stands,
 * when it was last touched, and the next concrete move.
 *
 * `kind` and `next_step` exist because a thread with a state but no next step is a
 * note — and a note is not something you can put in a day. Missing a next step is
 * stated explicitly rather than left blank, so the absence is visible and the coach
 * is nudged to propose one instead of only re-reading the thread.
 */
function formatThread(l: OpenLoop): string {
  const kind = l.kind && l.kind !== "topic" ? `${l.kind} ` : "";
  const next = l.next_step ? ` — next: ${l.next_step}` : " — no next step yet";
  return `- ${kind}${l.subject}: ${l.thread} (${l.last_touched_at.slice(0, 10)})${next}`;
}

// Compact digest of who the user is right now (memory layer v1).
/**
 * Build the live context digest.
 *
 * `intent` is what the memory layer retrieves against — normally the user's own
 * message, so the facts that reach the prompt are the ones relevant to what they
 * actually asked. Without it, memory is selected for a generic planning moment.
 */
export async function buildAssistantContext(
  opts: { intent?: string } = {}
): Promise<string> {
  const db = createServiceClient();
  const [goals, entries, goalState, people, open] = await Promise.all([
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

  // The backlog: what has stalled and what is waiting. This is the ammunition
  // that lets the coach see a goal with no next step, rather than only the
  // goals that are already moving. Best-effort like every other section, and
  // silent when there is nothing to say (formatBacklogForContext returns "").
  try {
    const backlog = await getBacklog();
    const block = formatBacklogForContext(backlog);
    if (block) {
      parts.push(
        `## What has stalled and what is waiting in the backlog\n${block}`
      );
    }
  } catch {
    // no backlog section
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

  // Memory: RETRIEVED for this moment, not dumped (M1).
  //
  // This replaces two wholesale blocks — 40 rows of free-text memory plus every
  // living fact — which together were 8,470 of a 16,870-character prompt. Facts
  // now arrive because they are relevant to the intent, with a floor of pinned
  // and newest facts so something learned a minute ago is never invisible.
  try {
    const memory = await retrieveMemory(
      opts.intent?.trim() || DEFAULT_MEMORY_INTENT
    );
    if (memory.block) parts.push(memory.block);
  } catch {
    // no memory section — retrieveMemory already degrades to the full dump
  }

  // Loops and promises, as facts rather than as a tool call. These are the SAME
  // reads the opening brief is built from, so the assistant knows them without
  // asking and cannot contradict the brief it just displayed. Compact on
  // purpose, and best-effort like every other section.
  try {
    // ALL live threads — not only the ones waiting on the user.
    //
    // Before this, the context carried "waiting on you" and "gone quiet" and
    // nothing else, so a thread waiting on SOMEONE ELSE reached the model through
    // no group at all. That is precisely the "I am blocked on Theresa's answer"
    // case, which is the thing a coach should have in front of it when planning.
    // (The M3 test caught this: a thread waiting on someone else, touched a second
    // earlier, appeared nowhere.)
    const [threads, stale, openPromises] = await Promise.all([
      listLoops({ limit: 50 }),
      staleLoops(),
      listCommitments({ status: "open", limit: 20 }),
    ]);
    const live = threads.filter((l) => l.state !== "done");
    const staleIds = new Set(stale.map((s) => s.id));
    const waitingOnUser = live.filter(
      (l) => l.state === "waiting" && l.waiting_on === "you"
    );
    const waitingOnThem = live.filter(
      (l) => l.state === "waiting" && l.waiting_on === "them"
    );
    const openThreads = live.filter((l) => l.state === "open" && !staleIds.has(l.id));

    const group = (
      label: string,
      rows: typeof live,
      max = 8
    ): string[] =>
      rows.length
        ? [`${label}\n` + rows.slice(0, max).map(formatThread).join("\n")]
        : [];

    const section: string[] = [
      ...group("Waiting on the user:", waitingOnUser),
      ...group(
        "Waiting on someone else (you are blocked - keep the next step ready):",
        waitingOnThem
      ),
      ...group("Open threads you own:", openThreads),
      ...group("Gone quiet (not touched in 14+ days):", stale),
    ];
    if (openPromises.length) {
      section.push(
        `Promises the user made and has not closed:\n` +
          openPromises
            .map((c) => `- ${c.text}${c.due_date ? ` (due ${c.due_date})` : ""}`)
            .join("\n")
      );
    }
    if (section.length) {
      parts.push(
        `## Threads and promises (people and projects — never re-ask these)\n` +
          `A thread with a state but no next step is a note; a thread with a next step is something you can put in a day.\n` +
          section.join("\n\n")
      );
    }
  } catch {
    // no loops section
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
  const context = await buildAssistantContext();
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

// --- the SECOND memory store is gone ---------------------------------------
//
// Here used to live getCoachMemories() / addCoachMemory() and the MemoryKind
// union: readers and writers for `coach_memory`, the older free-text store (up
// to three uncorrectable prose notes per chat turn, which is how 552 of them
// accumulated). Since the memory refactor, a turn writes FACTS only
// (src/lib/memory.ts), and the consolidation pass moved those notes in. The only
// remaining caller of these two functions was /api/coach/memory, an endpoint
// with no UI, no cron and no test behind it — so it is deleted too.
//
// ONE memory store now. The `coach_memory` TABLE stays exactly as it is: it is
// still read by the consolidation pass as source material, and it is history no
// code may silently drop.

// Extract durable memory from a conversation turn (best-effort, non-fatal).
//
// M2: this writes FACTS ONLY. It used to also append free-text notes to a second
// store that had no update path — which is how 552 prose sentences accumulated
// alongside 270 correctable facts, saying overlapping things in different
// versions. One notebook means one write path.
const MEMORY_SYSTEM = `You maintain the LONG-TERM MEMORY of a personal assistant from ONE coaching exchange. You write (topic, key, value) FACTS, and nothing else.

- topic: a broad area of the user's life in THEIR language ("Küche & Vorräte", "Ziele", "Arbeit", "Beziehung"). Reuse an existing topic when one fits.
- key: the stable thing being talked about, short and generic ("tofu", "diet", "salary_target"). A key is a SLOT THAT IS UPDATED, never accumulated.
- value: its CURRENT state, present tense, stated plainly.
- kind: "durable" (true for weeks: preferences, people, patterns, goals), "state" (reality will move it: pantry, what they are reading, where they are), "derived" (an insight you are concluding, not something they said).

Rules — these matter:
- Re-use an existing key with a new value instead of inventing a near-duplicate: that is exactly how the store stays current.
- ONE CONCEPT, ONE KEY, ONE TOPIC. "vegan" is ONE fact. Do not file it again under a second key ("diet", "ernährung", "ernährungsweise") or in a second topic: cross-topic duplicates are how a single truth ends up saying four slightly different things, of which only one gets retrieved.
- NEVER express a removal. "ich habe keinen Tofu mehr" is key "tofu" with value "none left" — not a deletion.
- Emit a fact ONLY when the exchange genuinely states it. Never infer, and never restate a value that has not changed.
- KITCHEN, SUPPLIES, STOCK, AND WHAT WAS COOKED ARE ALWAYS kind "state" — never "durable", however settled they sound. "Verräte aktuell", "Gekochtes heute" and "Fehlende Gewürze" are snapshots. (Measured reason, 2026-09-20: a five-day-old pantry snapshot stored as durable got no verify date, so it was read back as today's kitchen — and the assistant told a vegan he had no garlic and proposed chicken.)
- A CONSTRAINT IS PINNED. Diet, allergies, medical limits and "I never/always X" are not preferences: they filter everything the assistant may suggest. Store those with pinned=true so they can never fall out of its context, key "diet" (or the constraint's own name), kind "durable".
- Keep the user's language for values they wrote in German.

Return ONLY JSON:
{"facts":[{"topic":"...","key":"...","value":"...","kind":"durable|state|derived","pinned":false}]}
- 0-6 facts. An empty array is the correct answer for small talk or pure logistics.
- "pinned" is optional and true ONLY for a hard constraint.`;

export async function extractMemories(
  userText: string,
  assistantText: string,
  opts: { sourceRef?: string | null } = {}
): Promise<MemoryFact[]> {
  const exchange = `User: ${userText}\n\nCoach: ${assistantText}`.slice(0, 4000);
  const res = await llm().chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    // temperature 0: extraction is parsing, not writing. The same sentence should
    // produce the same fact, or the store churns ("twice a week" one turn, "two
    // times per week" the next) and de-duplication by key has nothing stable to
    // match on.
    temperature: 0,
    messages: [
      { role: "system", content: MEMORY_SYSTEM },
      { role: "user", content: exchange },
    ],
  });
  const raw = (res.choices[0].message.content ?? "").trim();
  let parsed: {
    facts?: {
      topic?: string;
      key?: string;
      value?: string;
      kind?: string;
      pinned?: boolean;
    }[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  // Merge (topic, key, value) facts. upsertFact supersedes an existing key rather
  // than adding a contradicting row, and it can never delete — a "removed" thing
  // is just a new value. Curation is bounded to the topics that ACTUALLY changed,
  // and to at most 2 per turn, because rewriting a summary costs a model call.
  const changedTopics = new Set<string>();
  const KINDS: FactKind[] = ["durable", "state", "derived"];
  const candidates = (parsed.facts ?? [])
    .slice(0, 6)
    .map((f) => ({
      topic: (f.topic ?? "").trim(),
      key: (f.key ?? "").trim(),
      value: (f.value ?? "").trim(),
      kind: (KINDS.includes(f.kind as FactKind) ? f.kind : "durable") as FactKind,
      // The extractor may PIN a fact but never unpin one: only `true` is passed
      // through, so a bad extraction can never quietly loosen a constraint the
      // user (or an earlier turn) deliberately pinned.
      pinned: f.pinned === true,
    }))
    .filter((f) => f.topic.length > 0 && f.key.length > 0 && f.value.length > 0);

  // ONE embeddings request per turn, not one per fact: a turn can write six facts
  // and a request each would add latency for nothing. A failed batch is not
  // fatal — facts are still written without a vector and the backfill picks them
  // up — but then each upsert embeds its own, so nothing stays unsearchable.
  let vectors: (number[] | null)[] = [];
  try {
    vectors = await embedMany(candidates.map((f) => factText(f.topic, f.key, f.value)));
  } catch {
    vectors = [];
  }

  const written: MemoryFact[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    try {
      const result = await upsertFact({
        topic: f.topic,
        key: f.key,
        value: f.value,
        kind: f.kind,
        ...(f.pinned ? { pinned: true } : {}),
        source: "chat",
        // Provenance: the id of the user message this came from, so "nothing
        // lost" can be audited back to the sentence that produced it.
        source_ref: opts.sourceRef ?? null,
        embedding: vectors[i] ?? undefined,
      });
      if (result.fact) written.push(result.fact);
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

  return written;
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

/** A backlog item the plan deliberately pulled in, and why today suits it. */
export interface PlanBacklogUse {
  title: string;
  reason: string;
}

export interface DayPlan {
  date: string; // YYYY-MM-DD
  headline: string;
  blocks: PlanBlock[];
  note: string; // coach's closing tip
  generated_at: string;
  /**
   * The WHY of the plan, in prose: what needs movement and the evidence for it,
   * the ways considered and their trade-off, and the one chosen. Optional
   * because a plan stored before P7b has none — the UI then shows nothing
   * rather than an empty box.
   */
  strategy?: string;
  /** The backlog items the plan pulled, each with the reason today suits it. */
  backlogUsed?: PlanBacklogUse[];
}

const PLAN_SYSTEM = `You are the user's practical day-planner COACH. You decide what actually needs movement today and then build a REALISTIC time-blocked plan for TODAY from their calendar, active goals, open milestones, open todos, the backlog, and today's mood/focus. Respect existing calendar events as fixed anchors.

DECIDE BEFORE YOU SCHEDULE. Filling time slots is a clerk's job; your job is to make the next real step visible and to say why it is that one.
- Name AT MOST TWO things that need movement, chosen by EVIDENCE in the context below: a stalled milestone (and how long it has stalled), a goal whose progress has not moved, a due date, or a promise said and not yet done. Quote the evidence instead of asserting that something needs attention.
- Weigh TWO OR THREE genuinely different ways to move it — not three sizes of the same task. Different angles: a conversation to have, a small experiment, something to prepare, a decision to make, something to STOP doing. Note the trade-off (fast vs thorough, alone vs with someone, today vs later), then say which you chose and why, tied to the milestone it moves.
- PULL AT MOST THREE items from the backlog that genuinely fit today, each with the reason today suits it. An empty list is honest: "nothing in the backlog fits today" is a complete answer, and inventing work to look thorough is worse than a short list.

Scheduling rules:
- Cover the useful waking hours (usually 08:00–22:00). Include meals and at least one real break and downtime in the evening.
- Anchor around existing events (don't overlap them; leave travel/buffer around them).
- Derive tasks from the user's active-goal MILESTONES: break an open milestone into one small, doable block, and use the exact goal title.
- Tie most working/focus blocks to ONE of their active goals (use the exact goal title), so the day moves goals forward. If a block serves no goal, say so honestly in "why" — habits, meals, rest and genuine admin are allowed to serve none.
- Do NOT pad the day. Do not fill hours because hours exist, and do not make every block the same kind of small chore: at most one admin/errand block unless something is genuinely urgent today. A shorter honest day beats a full-looking one.
- Keep blocks 30–120 min. AT MOST 10 blocks — count them before you return, and cut the weakest rather than exceeding it. Be humane: no back-to-back grind; if mood is low, lighter and fewer.
- Include any urgent open todos as "task" blocks.
- Mark each block "required": true when it genuinely needs doing today (a commitment, a deadline, something the day depends on), and false when it is a nice-to-have. Default to true when unsure.
- Give each block a "priority" from 1 (most important) to 5 (least).
- Times are 24h "HH:MM" local (Europe/Vienna), end > start, non-overlapping, sorted.
- "why" is one short clause. Keep headline to one line.

Return ONLY JSON:
{"headline":"one-line theme for the day",
 "strategy":"2-4 sentences of plain prose written TO the user: what needs movement and the evidence, the two or three ways you weighed and their trade-off, and the one you chose and why. Never restate the schedule here — this is the thinking, not the timetable.",
 "backlog_used":[{"title":"exact title of a backlog item you scheduled","reason":"one clause: why today is a reasonable day for it"}],
 "blocks":[{"start":"09:00","end":"10:00","title":"...","type":"focus|task|habit|break|event|social|admin","goal":"exact goal title or null","why":"...","required":true,"priority":2}],
 "note":"one-sentence coach tip"}`;

// Coerce an LLM-supplied priority into the app's 1–5 scale. Anything malformed
// falls back to the same default the old code used (focus → 2, else 3).
function coercePriority(value: unknown, type: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return type === "focus" ? 2 : 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// Trim prose to a whole thought: at most `max` characters, cut at the last
// sentence end, and failing that at a word boundary. A plain slice() on a
// model-written paragraph lands mid-word ("... heute ist der Tag, an"), which
// reads as a bug to the person looking at it rather than as a length limit.
function trimProse(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );
  if (lastStop > max * 0.6) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()} …`;
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

  // The open milestones and the backlog. The prompt asks for milestone-derived
  // blocks and for backlog items, so the plan has to actually SEE them — before
  // P7b it was instructed to use milestones and handed none, which is how a
  // planner ends up scheduling generic chores. Both reads are best-effort.
  const [milestonesByGoal, backlogBlock] = await Promise.all([
    getMilestonesByGoal(goals.map((g) => g.id)).catch(
      () => ({}) as Record<string, Milestone[]>
    ),
    getBacklog()
      .then((b) => formatBacklogForContext(b))
      .catch(() => ""),
  ]);

  const parts: string[] = [];
  parts.push(`Today: ${day} (${new Date(day + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" })}).`);
  if (events.length) parts.push(`## Fixed calendar events today\n${events.join("\n")}`);
  else parts.push("## Fixed calendar events today\n(none)");
  if (goals.length)
    parts.push(
      `## Active goals\n${goals.map((g) => `- ${g.title} [${g.progress}${g.target ? `/${g.target}` : ""}]`).join("\n")}`
    );
  try {
    const msLines: string[] = [];
    for (const g of goals) {
      const open = (milestonesByGoal[g.id] ?? []).filter((m) => !m.done);
      if (!open.length) continue;
      msLines.push(...open.slice(0, 4).map((m) => `- ${g.title} :: ${m.title}`));
    }
    if (msLines.length)
      parts.push(
        `## Open milestones (break ONE into a block, keep the goal title)\n${msLines.join("\n")}`
      );
  } catch {
    // no milestones section
  }
  if (todos.length)
    parts.push(`## Open todos\n${todos.map((t) => `- ${t.title}`).join("\n")}`);
  if (backlogBlock)
    parts.push(
      `## What has stalled and what is waiting in the backlog\n${backlogBlock}`
    );
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
  let strategy = "";
  let backlogUsed: PlanBacklogUse[] = [];
  let blocks: PlanBlock[] = [];
  const TYPES = ["focus", "task", "habit", "break", "event", "social", "admin"];
  try {
    const p = JSON.parse(raw) as {
      headline?: string;
      note?: string;
      strategy?: string;
      backlog_used?: { title?: string; reason?: string }[];
      blocks?: Partial<PlanBlock>[];
    };
    headline = (p.headline ?? "Your day").trim();
    note = (p.note ?? "").trim();
    // The reasoning is prose for the user; keep it whole but bounded, and end it
    // on a sentence rather than in the middle of a word.
    strategy = typeof p.strategy === "string" ? trimProse(p.strategy, 1400) : "";
    backlogUsed = (Array.isArray(p.backlog_used) ? p.backlog_used : [])
      .map((b) => ({
        title: String(b?.title ?? "").trim().slice(0, 160),
        reason: trimProse(String(b?.reason ?? ""), 180),
      }))
      .filter((b) => b.title.length > 0)
      .slice(0, 3);
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

  const plan: DayPlan = {
    date: day,
    headline,
    blocks,
    note,
    strategy,
    backlogUsed,
    generated_at: new Date().toISOString(),
  };

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
        // Applying a plan twice must not create the work twice. On 2026-09-18 the
        // same block was written to the day twice, which is how three duplicate
        // pairs of todos ended up in the list. An open todo with the same title
        // already on that day means this block is done being applied.
        const already = await findDayTaskByTitle(input.day, b.title);
        if (already) continue;

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
