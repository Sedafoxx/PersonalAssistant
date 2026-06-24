import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { getJournalEntries } from "./journal";
import { getGoals } from "./goals";
import { getItems } from "./db";
import { getRecentChat } from "./chat-log";

// Lazy-init: never construct at module load (keeps the server-only key off any
// accidental client import — same footgun that white-screened the app once).
let _client: OpenAI | null = null;
function openai(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

export type SuggestionStatus = "new" | "building" | "done" | "dismissed";
export type SuggestionCategory =
  | "feature"
  | "ux"
  | "workflow"
  | "automation"
  | "content";

const SUGGESTION_COLS =
  "id,title,category,rationale,evidence,status,created_at,updated_at";

export interface Suggestion {
  id: string;
  title: string;
  category: SuggestionCategory;
  rationale: string | null;
  evidence: string | null;
  status: SuggestionStatus;
  created_at: string;
  updated_at: string;
}

export async function getSuggestions(
  status?: SuggestionStatus
): Promise<Suggestion[]> {
  const db = createServiceClient();
  let q = db.from("suggestions").select(SUGGESTION_COLS);
  if (status) q = q.eq("status", status);
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Suggestion[];
}

export async function updateSuggestionStatus(
  id: string,
  status: SuggestionStatus
): Promise<Suggestion> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("suggestions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(SUGGESTION_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No suggestion found with id "${id}"`);
  return data as Suggestion;
}

// --- context building ------------------------------------------------------

// Compact, token-bounded digest of how the user has been using the app.
async function buildUsageDigest(): Promise<string> {
  const [entries, items, goals, chat] = await Promise.all([
    getJournalEntries(30),
    getItems({}),
    getGoals(),
    getRecentChat(40).catch(() => []),
  ]);

  const parts: string[] = [];

  // Journal: mood + topics + summary capture recurring themes.
  if (entries.length) {
    const lines = entries
      .slice(0, 25)
      .map(
        (e) =>
          `- [${e.mood ?? "?"}] ${e.summary ?? e.raw_text.slice(0, 120)}` +
          (e.topics?.length ? ` (topics: ${e.topics.join(", ")})` : "")
      );
    parts.push(`## Journal entries (${entries.length} total, recent first)\n${lines.join("\n")}`);
  }

  // Items: counts by type/status + a sample, plus stale active todos.
  if (items.length) {
    const byType = (t: string) => items.filter((i) => i.type === t);
    const counts = ["todo", "note", "idea"]
      .map((t) => `${t}: ${byType(t).length}`)
      .join(", ");
    const doneTodos = items.filter((i) => i.type === "todo" && i.status === "done").length;
    const now = Date.now();
    const staleTodos = items
      .filter(
        (i) =>
          i.type === "todo" &&
          i.status === "active" &&
          now - new Date(i.created_at).getTime() > 14 * 864e5
      )
      .slice(0, 10)
      .map((i) => `- ${i.title}`);
    const sample = items.slice(0, 20).map((i) => `- [${i.type}/${i.status}] ${i.title}`);
    parts.push(
      `## Items (${counts}; ${doneTodos} todos completed)\n${sample.join("\n")}` +
        (staleTodos.length
          ? `\n\nStale active todos (>14d, never completed):\n${staleTodos.join("\n")}`
          : "")
    );
  }

  // Goals: progress + status reveal what's stalling.
  if (goals.length) {
    const lines = goals.map(
      (g) =>
        `- ${g.title} — ${g.progress}${g.target ? `/${g.target}` : ""} [${g.status}]`
    );
    parts.push(`## Goals\n${lines.join("\n")}`);
  }

  // Chat: where the user reaches for the assistant, and where it may fall short.
  if (chat.length) {
    const lines = chat
      .slice(-30)
      .map((m) => `${m.role === "user" ? "U" : "A"}: ${m.content.slice(0, 160)}`);
    parts.push(`## Recent chat\n${lines.join("\n")}`);
  }

  return parts.join("\n\n") || "No usage data yet.";
}

// --- generation ------------------------------------------------------------

const SYSTEM = `You are a product analyst improving a single-user personal-assistant web app (chat to capture todos/notes/ideas, a journal with mood/XP gamification, goals, push reminders, voice input).

Given the user's real usage data, propose concrete, specific suggestions to improve THIS user's experience or add features they would clearly benefit from. Ground every suggestion in an observed pattern from the data — not generic product advice.

Return ONLY JSON: {"suggestions":[{"title","category","rationale","evidence"}]}
- "title": short imperative headline (e.g. "Auto-create todos from journal mentions").
- "category": one of feature | ux | workflow | automation | content.
- "rationale": one or two sentences on why it helps this user.
- "evidence": the specific data pattern that prompted it (quote/paraphrase the signal).

Rules:
- Propose 3-6 suggestions. Quality over quantity. If data is thin, propose fewer.
- Be concrete and buildable, not vague ("improve UX" is bad; "show a mood-trend sparkline above the journal" is good).
- Do NOT repeat or lightly reword any suggestion in the "Already suggested" list.`;

interface RawSuggestion {
  title?: string;
  category?: string;
  rationale?: string;
  evidence?: string;
}

const CATEGORIES: SuggestionCategory[] = [
  "feature",
  "ux",
  "workflow",
  "automation",
  "content",
];

// Analyze usage, propose new suggestions, store the non-duplicate ones.
// Returns the suggestions actually inserted.
export async function generateSuggestions(): Promise<Suggestion[]> {
  const digest = await buildUsageDigest();

  // Dedup context: titles of every suggestion still on the board (not dismissed/done).
  const existing = await getSuggestions();
  const open = existing.filter(
    (s) => s.status === "new" || s.status === "building"
  );
  const existingTitles = new Set(open.map((s) => s.title.toLowerCase().trim()));
  const alreadyBlock = open.length
    ? `\n\nAlready suggested (do not repeat):\n${open.map((s) => `- ${s.title}`).join("\n")}`
    : "";

  const res = await openai().chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `# Usage data\n\n${digest}${alreadyBlock}` },
    ],
  });

  const raw = res.choices[0].message.content ?? "{}";
  let parsed: { suggestions?: RawSuggestion[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rows = (parsed.suggestions ?? [])
    .map((s) => ({
      title: (s.title ?? "").trim(),
      category: (CATEGORIES.includes(s.category as SuggestionCategory)
        ? s.category
        : "feature") as SuggestionCategory,
      rationale: (s.rationale ?? "").trim() || null,
      evidence: (s.evidence ?? "").trim() || null,
    }))
    .filter(
      (s) => s.title.length > 0 && !existingTitles.has(s.title.toLowerCase())
    );

  if (rows.length === 0) return [];

  const db = createServiceClient();
  const { data, error } = await db
    .from("suggestions")
    .insert(rows)
    .select(SUGGESTION_COLS);
  if (error) throw new Error(error.message);
  return (data ?? []) as Suggestion[];
}
