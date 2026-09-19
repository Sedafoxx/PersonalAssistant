import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { createItem, getItems } from "./db";
import { getThread, getRecentChat } from "./chat-log";
import { localDay } from "./coach";

// --- commitments ledger -----------------------------------------------------
//
// One row per promise the USER made, backed by a REAL item. The whole point of
// this module is the failure it prevents: a promise said in chat must not exist
// only in chat. So every path here writes an item first and the ledger row
// second, linked by item_id.
//
// Idempotency is not a hope — it is the unique partial index
// `commitments_open_text` on (text_norm) where status = 'open'. Saying the same
// promise twice hits the index and is counted as a duplicate, not a second
// item.

const COLS =
  "id,text,quote,due_date,item_id,status,source,created_at,updated_at";

export interface Commitment {
  id: string;
  text: string;
  quote: string | null;
  due_date: string | null;
  item_id: string | null;
  status: "open" | "done" | "dropped";
  source: string | null;
  created_at: string;
  updated_at: string;
}

// --- LLM (mirrors coach.ts / memory.ts: DeepSeek-safe, single user message) --

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

// --- pre-filter -------------------------------------------------------------

// A cheap German + English guard so a turn that cannot contain a promise skips
// the LLM call entirely. This is a guard, NOT the judgement: it only decides
// whether we bother asking, and "remind me" / "ich schreibe" style stems cover
// the way this user actually talks. Case-insensitive, substring-based — cheap
// on purpose.
const COMMITMENT_HINTS = [
  // German first-person stems
  "ich kaufe",
  "ich hole",
  "ich mache",
  "ich rufe",
  "ich frage",
  "ich schreibe",
  "ich schicke",
  "ich sende",
  "ich schaue",
  "ich erledige",
  "ich bezahle",
  "ich buche",
  "ich organisiere",
  "ich bringe",
  "ich schicke",
  // English first-person / imperative
  "i will",
  "i'll",
  "i’ll",
  "i am going to",
  "i'm going to",
  "i’m going to",
  "i'll do",
  "let me",
  "remind me",
  "i need to",
  "i have to",
  "i gotta",
  "i must",
];

// True when the text could plausibly contain a promise the user made. Cheap and
// deliberately over-inclusive: a false positive only costs one LLM call, while a
// false negative loses a promise.
export function looksLikeCommitment(text: string): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  return COMMITMENT_HINTS.some((hint) => hay.includes(hint));
}

// --- extraction -------------------------------------------------------------

const COMMITMENT_SYSTEM = `You extract PROMISES THE USER MADE from a single exchange with their assistant. A commitment is something the USER said they will do themselves.

Rules — these matter:
- ONLY the user's own promises. NEVER the assistant's suggestions, offers, or proposals — if the assistant proposed "you could read a chapter tonight", that is NOT a commitment unless the user then agreed to do it.
- NEVER a hypothetical ("ich könnte", "vielleicht", "I might") and NEVER something already in the past ("ich habe gekauft").
- "text" is a short IMPERATIVE todo in the user's language, e.g. "Kaufe Karotten" or "Call the dentist".
- "quote" is the user's OWN phrasing, copied as closely as possible.
- "due" is a calendar day 'YYYY-MM-DD' when a date is stated or clearly implied, else null. Never invent a date.
- If the user made no promise, return an empty array.

Return ONLY JSON:
{"commitments":[{"text":"...","due":"YYYY-MM-DD","quote":"..."}]}
- 0-3 commitments. Empty array when the user promised nothing.`;

interface RawCommitment {
  text?: string;
  due?: string | null;
  quote?: string | null;
}

function isDayString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

// The ONE write path for a commitment: a real item first, then the ledger row
// linked to it. Exported so the coach tool reuses it instead of reimplementing
// it. Returns the created commitment, or null when the promise is already open
// (the unique index rejected it) — that is the idempotency guarantee.
export async function createCommitment(input: {
  text: string;
  quote?: string | null;
  due_date?: string | null;
  source?: string | null;
}): Promise<{ commitment: Commitment; duplicate: boolean }> {
  const text = input.text.trim().slice(0, 300);
  if (!text) throw new Error("A commitment needs some text.");

  // Idempotency, read side: an open commitment with this normalized text means
  // the promise is already tracked. Return it rather than writing a new item —
  // the unique index below is the real guarantee, this just avoids the wasted
  // item insert.
  const db = createServiceClient();
  const { data: existing, error: readErr } = await db
    .from("commitments")
    .select(COLS)
    .eq("status", "open")
    .eq("text_norm", text.toLowerCase())
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (existing) {
    return { commitment: existing as Commitment, duplicate: true };
  }

  // A real item first. If this fails there is no ledger row and nothing claims
  // a capture that did not happen.
  const due = isDayString(input.due_date) ? input.due_date : null;
  const item = await createItem({
    type: "todo",
    title: text,
    priority: 3,
    due_date: due ?? undefined,
  });

  const { data: created, error: insErr } = await db
    .from("commitments")
    .insert({
      text,
      quote: input.quote?.trim() || null,
      due_date: due,
      item_id: item.id,
      status: "open",
      source: input.source ?? "chat",
    })
    .select(COLS)
    .maybeSingle();

  if (insErr) {
    // The unique index fired: another writer opened the same promise between
    // our read and insert. The item we just made is redundant, so drop it and
    // report a duplicate rather than leaving a stray todo behind.
    const duplicate = await db
      .from("commitments")
      .select(COLS)
      .eq("status", "open")
      .eq("text_norm", text.toLowerCase())
      .maybeSingle();
    if (duplicate.data) {
      try {
        const { deleteItem } = await import("./db");
        await deleteItem(item.id);
      } catch {
        // best-effort cleanup
      }
      return { commitment: duplicate.data as Commitment, duplicate: true };
    }
    throw new Error(insErr.message);
  }

  return { commitment: created as Commitment, duplicate: false };
}

// ONE JSON-mode LLM call in the existing extractMemories style: ask the model
// for the promises the USER made in this exchange, then persist each one via the
// single write path. Never throws on a model/parse failure — an unparseable
// answer simply yields no commitments.
export async function extractCommitments(
  userText: string,
  assistantText: string,
  day?: string
): Promise<Commitment[]> {
  const today = day ?? localDay();
  const exchange =
    `Today is ${today}.\n\nUser: ${userText}\n\nAssistant: ${assistantText}`.slice(
      0,
      4000
    );

  let parsed: { commitments?: RawCommitment[] };
  try {
    const res = await llm().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      // temperature 0: this is PARSING, not writing. The same sentence must yield
      // the same promise every time, or the ledger's own de-duplication (which
      // compares the words of the promise) fails against its own rephrasing and
      // the same promise becomes two items with two due dates.
      temperature: 0,
      messages: [
        { role: "system", content: COMMITMENT_SYSTEM },
        { role: "user", content: exchange },
      ],
    });
    const raw = (res.choices[0].message.content ?? "").trim();
    parsed = JSON.parse(raw) as { commitments?: RawCommitment[] };
  } catch {
    return [];
  }

  const saved: Commitment[] = [];
  for (const c of (parsed.commitments ?? []).slice(0, 3)) {
    const text = (c.text ?? "").trim();
    if (!text) continue;
    try {
      const { commitment, duplicate } = await createCommitment({
        text,
        quote: c.quote ?? null,
        due_date: isDayString(c.due) ? c.due : null,
        source: "chat",
      });
      // A duplicate means it was already open — skip it, do not re-mention it.
      if (!duplicate) saved.push(commitment);
    } catch {
      // non-fatal: one bad candidate must not lose the others
    }
  }
  return saved;
}

// --- reads / writes ---------------------------------------------------------

export async function listCommitments(opts?: {
  status?: "open" | "done" | "dropped";
  limit?: number;
}): Promise<Commitment[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("commitments")
      .select(COLS)
      .eq("status", opts?.status ?? "open")
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(opts?.limit ?? 20);
    if (error) throw new Error(error.message);
    return (data ?? []) as Commitment[];
  } catch {
    return [];
  }
}

export async function getCommitment(id: string): Promise<Commitment | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("commitments")
    .select(COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Commitment) ?? null;
}

// Close a commitment. Closing also completes its linked item, so the ledger and
// the todo list never disagree about whether the promise is done.
export async function closeCommitment(
  id: string,
  status: "done" | "dropped"
): Promise<void> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("commitments")
    .update({ status, updated_at: now })
    .eq("id", id)
    .select(COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as Commitment | null;
  if (row?.item_id) {
    try {
      const { updateItem } = await import("./db");
      await updateItem(row.item_id, {
        status: status === "done" ? "done" : "archived",
      });
    } catch {
      // best-effort: the ledger is already correct
    }
  }
}

// --- morning capture check --------------------------------------------------

export interface CaptureCheckResult {
  uncaptured: { quote: string; suggested: string }[];
  scanned: number;
}

// Words that carry no signal in a promise. Without this, "morgen" being folded
// into a due date would make the same promise look like a different one.
const PROMISE_STOPWORDS = new Set([
  "ich", "du", "der", "die", "das", "und", "mal", "noch", "morgen", "heute",
  "dann", "auch", "mit", "fuer", "für", "ein", "eine", "einen", "mich", "mir",
  "the", "and", "for", "will", "werde", "muss", "soll", "habe", "hat",
]);

function promiseWords(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/g, " ")
      .split(" ")
      .filter((word) => word.length >= 3 && !PROMISE_STOPWORDS.has(word))
  );
}

/**
 * True when two phrasings name the same promise.
 *
 * This exists because exact text equality failed in practice: the extractor
 * stored "Kaufe Karotten" — it folded "morgen" into the due date — while the
 * morning check re-read the same sentence from the transcript as "Kaufe morgen
 * Karotten", found no exact match, and reported a promise that HAD been captured
 * as "said but never recorded". A check that cries wolf is worse than no check,
 * because the entire point is that it can be trusted.
 *
 * Symmetric by design: half of the smaller word set must overlap, with at least
 * one shared word, so either phrasing recognises the other.
 */
export function samePromise(a: string, b: string): boolean {
  const wordsA = promiseWords(a);
  const wordsB = promiseWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  const smaller = Math.min(wordsA.size, wordsB.size);
  return shared >= 1 && shared / smaller >= 0.5;
}

// The morning check: read the previous logical day's chat turns and ask the
// model which of them are commitments. Anything with NO matching open
// commitment (and no matching open item) was said and never captured — that is
// what the morning message must surface. Best-effort: a failure returns
// { uncaptured: [], scanned: 0 }, never throws.
export async function captureCheck(opts?: {
  since?: string;
  clientId?: string;
}): Promise<CaptureCheckResult> {
  const empty: CaptureCheckResult = { uncaptured: [], scanned: 0 };
  try {
    // Default window: the whole of the previous logical day. Logical day, not
    // calendar day, so a 1am conversation still counts as "yesterday".
    let since = opts?.since;
    if (!since) {
      const [y, m, d] = localDay().split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 1, d));
      prev.setUTCDate(prev.getUTCDate() - 1);
      since = prev.toISOString().slice(0, 10);
    }

    // Read the turns for the named conversation when we have a client_id, else
    // the global recent thread. Either read is best-effort.
    let turns: { role: string; content: string; created_at: string }[] = [];
    try {
      turns = opts?.clientId
        ? await getThread(opts.clientId, 200)
        : await getRecentChat(200);
    } catch {
      turns = [];
    }

    const inWindow = turns.filter((t) => t.created_at >= `${since}T00:00:00`);
    const userTurns = inWindow.filter((t) => t.role === "user");
    if (!userTurns.length) return { ...empty, scanned: inWindow.length };

    // Pre-filter before spending an LLM call.
    const candidateText = userTurns.map((t) => t.content).join("\n");
    if (!looksLikeCommitment(candidateText)) {
      return { ...empty, scanned: inWindow.length };
    }

    const transcript = inWindow
      .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
      .join("\n")
      .slice(0, 4000);

    let parsed: { commitments?: RawCommitment[] };
    try {
      const res = await llm().chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: COMMITMENT_SYSTEM },
          {
            role: "user",
            content: `Transcript:\n${transcript}\n\nList the promises the USER made (JSON).`,
          },
        ],
      });
      const raw = (res.choices[0].message.content ?? "").trim();
      parsed = JSON.parse(raw) as { commitments?: RawCommitment[] };
    } catch {
      return { ...empty, scanned: inWindow.length };
    }

    const open = await listCommitments({ status: "open", limit: 100 });
    const activeItems = await getItems({ status: "active" }).catch(() => []);

    const uncaptured: { quote: string; suggested: string }[] = [];
    for (const c of (parsed.commitments ?? []).slice(0, 10)) {
      const text = (c.text ?? "").trim();
      if (!text) continue;
      // Matching is by word overlap, never by exact text — see samePromise().
      const alreadyOpen = open.some((c) => samePromise(text, c.text));
      const matchingItem = activeItems.some((i) => samePromise(text, i.title));
      if (alreadyOpen || matchingItem) continue;
      uncaptured.push({ quote: (c.quote ?? "").trim() || text, suggested: text });
    }

    return { uncaptured, scanned: inWindow.length };
  } catch {
    return empty;
  }
}
