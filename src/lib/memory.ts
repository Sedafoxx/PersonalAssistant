import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { embed, embedMany } from "./embeddings";

// --- living memory ----------------------------------------------------------
//
// A maintained store of facts the coach keeps CURRENT instead of accumulating.
// A fact is a (topic, key) pair with one live value; writing the same key again
// supersedes the old value rather than adding a contradicting row. Nothing in
// this module ever issues a delete — superseded values stay for history.

const TOPIC_COLS = "id,slug,title,summary,summary_updated_at,updated_at";
const FACT_COLS =
  "id,topic_id,key,value,status,pinned,source,superseded_by,created_at,updated_at";

export type FactStatus = "active" | "superseded" | "pending_removal";

export interface MemoryTopic {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  summary_updated_at: string | null;
  updated_at: string;
}

export interface MemoryFact {
  id: string;
  topic_id: string;
  key: string;
  value: string;
  status: FactStatus;
  pinned: boolean;
  source: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

// --- pure helpers -----------------------------------------------------------

// Topic title → slug: German diacritics are transliterated first (ä→ae, ö→oe,
// ü→ue, ß→ss), then lowercased, trimmed, runs of any other non-alphanumeric
// collapsed to a single "-", and leading/trailing dashes dropped.
//
// Transliterating rather than stripping matters twice over here: this user
// writes German topic titles, so stripping mangles every one of them
// ("Küche" → "k-che", "Vorräte" → "vorr-te"), and it also risks a collision,
// since "Küche" and a literal "K-che" would otherwise slugify identically and
// silently merge two different topics. Pure + exported so it can be checked
// without a database.
export function slugifyTopic(title: string): string {
  return title
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- LLM (mirrors coach.ts / journal.ts: DeepSeek-safe, single user message) --

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

// --- topics -----------------------------------------------------------------

// All topics, most recently active first.
export async function getTopics(): Promise<MemoryTopic[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_topics")
      .select(TOPIC_COLS)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as MemoryTopic[];
  } catch {
    return [];
  }
}

// Resolve a topic by slug, creating it when missing. Safe against a concurrent
// create: a duplicate-slug insert error falls back to a re-read.
export async function getOrCreateTopic(title: string): Promise<MemoryTopic> {
  const clean = title.trim();
  const slug = slugifyTopic(clean) || "general";
  const db = createServiceClient();

  const { data: existing, error: readErr } = await db
    .from("memory_topics")
    .select(TOPIC_COLS)
    .eq("slug", slug)
    .maybeSingle();
  if (readErr) throw new Error(readErr.message);
  if (existing) return existing as MemoryTopic;

  const { data: created, error: insertErr } = await db
    .from("memory_topics")
    .insert({ slug, title: clean || slug })
    .select(TOPIC_COLS)
    .maybeSingle();
  if (!insertErr && created) return created as MemoryTopic;

  // Concurrency: another writer created the same slug between our read and
  // insert. Re-read and return theirs rather than throwing.
  const { data: again, error: reErr } = await db
    .from("memory_topics")
    .select(TOPIC_COLS)
    .eq("slug", slug)
    .maybeSingle();
  if (reErr) throw new Error(reErr.message);
  if (again) return again as MemoryTopic;
  throw new Error(insertErr?.message ?? `Could not create topic "${clean}"`);
}

// --- facts ------------------------------------------------------------------

// Active facts, pinned first then most recently updated. Optionally one topic.
export async function getActiveFacts(topicId?: string): Promise<MemoryFact[]> {
  try {
    const db = createServiceClient();
    let q = db
      .from("memory_facts")
      .select(FACT_COLS)
      .eq("status", "active");
    if (topicId) q = q.eq("topic_id", topicId);
    q = q
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as MemoryFact[];
  } catch {
    return [];
  }
}

// Active AND superseded facts for one topic, so the UI can show what changed.
export async function getFactsIncludingHistory(
  topicId: string
): Promise<MemoryFact[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_facts")
      .select(FACT_COLS)
      .eq("topic_id", topicId)
      .in("status", ["active", "superseded"])
      .order("pinned", { ascending: false })
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as MemoryFact[];
  } catch {
    return [];
  }
}

export interface UpsertFactInput {
  topic: string;
  key: string;
  value: string;
  source?: string;
  pinned?: boolean;
  /**
   * Pre-computed embedding. Callers that write several facts at once (a chat
   * turn can write six) embed them in ONE batched request and pass the vectors
   * in; a caller that passes nothing gets a single best-effort embed here.
   */
  embedding?: number[] | null;
}

/**
 * The text a fact is embedded as. The topic title is part of it because
 * "tofu: none left" is ambiguous until you know the topic is the kitchen.
 */
export function factText(topicTitle: string, key: string, value: string): string {
  return `${topicTitle} :: ${key}: ${value}`;
}

/** Best-effort embed: a failed embedding must never stop a fact being remembered. */
async function safeEmbed(text: string): Promise<number[] | null> {
  try {
    return await embed(text);
  } catch {
    return null;
  }
}

export interface UpsertFactResult {
  fact: MemoryFact | null;
  supersededId: string | null;
  changed: boolean;
}

// The one write path, and the heart of this module: update instead of
// accumulate. Returns the live fact, the id it superseded (if any), and whether
// anything the user cares about actually changed.
export async function upsertFact(
  input: UpsertFactInput
): Promise<UpsertFactResult> {
  const key = input.key.trim().slice(0, 200);
  const value = input.value.trim().slice(0, 2000);
  if (!key || !value) return { fact: null, supersededId: null, changed: false };

  const topic = await getOrCreateTopic(input.topic);
  const db = createServiceClient();
  const now = new Date().toISOString();

  // Read the live fact for this key. key_norm is the generated lower(btrim())
  // column, so matching on it is case-insensitive.
  const { data: live, error: liveErr } = await db
    .from("memory_facts")
    .select(FACT_COLS)
    .eq("topic_id", topic.id)
    .eq("status", "active")
    .eq("key_norm", key.toLowerCase())
    .maybeSingle();
  if (liveErr) throw new Error(liveErr.message);

  // 6. A pinned live fact is never overwritten.
  if (live && live.pinned) {
    return { fact: live as MemoryFact, supersededId: null, changed: false };
  }

  // 4. Same value → touch updated_at only; a repeat mention must not churn
  // history.
  if (live && (live.value as string).trim() === value) {
    const { data: touched, error } = await db
      .from("memory_facts")
      .update({ updated_at: now })
      .eq("id", live.id)
      .select(FACT_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { fact: (touched as MemoryFact) ?? (live as MemoryFact), supersededId: null, changed: false };
  }

  let supersededId: string | null = null;

  if (live) {
    // 5. Supersede FIRST — this frees the partial unique slot for the new row.
    const { error: supErr } = await db
      .from("memory_facts")
      .update({ status: "superseded", updated_at: now })
      .eq("id", live.id);
    if (supErr) throw new Error(supErr.message);
    supersededId = live.id as string;
  }

  // M1: embed on write — but only here, after the "pinned" and "same value"
  // paths have already returned, so a no-op write costs no embedding call.
  const embedding =
    input.embedding ?? (await safeEmbed(factText(topic.title, key, value)));

  // 3 & 5. Insert the new active row.
  const { data: created, error: insErr } = await db
    .from("memory_facts")
    .insert({
      topic_id: topic.id,
      key,
      value,
      status: "active",
      pinned: input.pinned ?? false,
      source: input.source ?? null,
      embedding,
    })
    .select(FACT_COLS)
    .maybeSingle();
  if (insErr) throw new Error(insErr.message);
  const fact = created as MemoryFact;

  // 5. Link the old row to its replacement (best-effort — the value is already
  // safely superseded and linked by status even if this fails).
  if (supersededId && fact?.id) {
    try {
      const { error } = await db
        .from("memory_facts")
        .update({ superseded_by: fact.id, updated_at: now })
        .eq("id", supersededId);
      if (error) throw new Error(error.message);
    } catch {
      // non-fatal: the supersede already happened
    }
  }

  return { fact, supersededId, changed: true };
}

// --- human-override path ----------------------------------------------------

export async function setFactValueByHand(
  id: string,
  value: string
): Promise<MemoryFact | null> {
  const clean = value.trim().slice(0, 2000);
  if (!clean) return null;
  const db = createServiceClient();
  const { data, error } = await db
    .from("memory_facts")
    .update({ value: clean, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(FACT_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MemoryFact) ?? null;
}

export async function setFactStatus(
  id: string,
  status: FactStatus
): Promise<MemoryFact | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("memory_facts")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(FACT_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MemoryFact) ?? null;
}

export async function setFactPinned(
  id: string,
  pinned: boolean
): Promise<MemoryFact | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("memory_facts")
    .update({ pinned, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(FACT_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MemoryFact) ?? null;
}

// Facts flagged for removal, awaiting a human decision (never deleted here).
export async function getPendingRemovals(): Promise<MemoryFact[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_facts")
      .select(FACT_COLS)
      .eq("status", "pending_removal")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as MemoryFact[];
  } catch {
    return [];
  }
}

// --- curation ---------------------------------------------------------------

const CURATE_SYSTEM = `You maintain a single "topic" note about a person's life from their CURRENT facts. Write ONE short, current, human-readable paragraph in present tense that a coach could read at a glance.

Rules:
- Use ONLY the facts given. Never invent or infer anything not stated.
- Present tense, third person ("They ..." / "Their ..."). 1-3 sentences.
- No bullet lists, no headings, no markdown, no preamble ("Here is ..."). Plain prose only.
- If the facts contradict, trust the most recently updated one.

Return ONLY JSON: {"summary": "..."}`;

// Best-effort LLM rewrite of a topic summary from its ACTIVE facts only.
// Returns null on any failure and leaves the previous summary in place — a
// failed rewrite must never blank a good summary.
export async function curateTopic(topicId: string): Promise<string | null> {
  try {
    const facts = await getActiveFacts(topicId);
    if (!facts.length) return null;

    const factLines = facts
      .map((f) => `- ${f.key}: ${f.value} (updated ${f.updated_at})`)
      .join("\n");

    const res = await llm().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CURATE_SYSTEM },
        { role: "user", content: `Facts:\n${factLines}\n\nWrite the summary (JSON).` },
      ],
    });
    const raw = (res.choices[0].message.content ?? "").trim();
    const summary = (JSON.parse(raw) as { summary?: string }).summary?.trim();
    if (!summary) return null;

    const db = createServiceClient();
    const now = new Date().toISOString();
    const { error } = await db
      .from("memory_topics")
      .update({ summary, summary_updated_at: now, updated_at: now })
      .eq("id", topicId);
    if (error) throw new Error(error.message);
    return summary;
  } catch {
    return null;
  }
}

// --- prompt context ---------------------------------------------------------

// Compact markdown for the coach prompt, in the same "##"-section style as
// buildCoachContext. One line per topic with its summary, then its facts as
// "- key: value" (pinned marked). Returns "" when there is nothing to say.
export async function formatForContext(opts?: {
  maxTopics?: number;
  maxFactsPerTopic?: number;
}): Promise<string> {
  const maxTopics = opts?.maxTopics ?? 8;
  const maxFactsPerTopic = opts?.maxFactsPerTopic ?? 12;
  try {
    const topics = await getTopics();
    if (!topics.length) return "";
    const facts = await getActiveFacts();
    if (!facts.length) return "";

    const byTopic = new Map<string, MemoryFact[]>();
    for (const f of facts) {
      const list = byTopic.get(f.topic_id) ?? [];
      list.push(f);
      byTopic.set(f.topic_id, list);
    }

    const blocks: string[] = [];
    for (const t of topics.slice(0, maxTopics)) {
      const list = (byTopic.get(t.id) ?? []).slice(0, maxFactsPerTopic);
      if (!list.length) continue;
      const header = t.summary ? `### ${t.title} — ${t.summary}` : `### ${t.title}`;
      const lines = list.map(
        (f) => `- ${f.key}: ${f.value}${f.pinned ? " [pinned]" : ""}`
      );
      blocks.push([header, ...lines].join("\n"));
    }
    if (!blocks.length) return "";
    return `## Living memory (maintained facts)\n\n${blocks.join("\n\n")}`;
  } catch {
    return "";
  }
}

// --- retrieval (M1) ---------------------------------------------------------
//
// THE PROBLEM THIS SOLVES. formatForContext() dumps every fact it has: 8,470
// characters of memory inside a 16,870-character coach prompt, facts included
// because they exist rather than because the conversation needs them. At the same
// time the prompt was missing things, because the free-text store was read as an
// arbitrary "newest 60" window. Bigger and less informed at once.
//
// So: rank by meaning (embedding similarity) against what the user just asked,
// always include a floor that cannot be missed, and fit an explicit budget.

/** Default size of the retrieved block, in characters. */
export const MEMORY_BUDGET_CHARS = 2600;

/** Pinned facts, plus the newest few, are ALWAYS present — see retrieveMemory. */
const FLOOR_RECENT = 10;

/** One topic may not flood the block: at most this many of its facts get in. */
const MAX_PER_TOPIC = 3;

/** Cosine floor for a match. Permissive on purpose: the budget culls, not this. */
const MATCH_THRESHOLD = 0.15;

export interface RetrievedMemory {
  block: string;
  /** How many facts the block actually carries. */
  facts: number;
  chars: number;
  /** True when retrieval failed and the full dump was used instead. */
  usedFallback: boolean;
}

interface RankedFact {
  id: string;
  topic_id: string;
  key: string;
  value: string;
  pinned: boolean;
  similarity: number;
}

/** The embedding search itself. Throws — retrieveMemory decides what to do. */
async function matchFacts(intent: string, limit: number): Promise<RankedFact[]> {
  const db = createServiceClient();
  const queryEmbedding = await embed(intent);
  const { data, error } = await db.rpc("match_memory_facts", {
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: MATCH_THRESHOLD,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as {
    id: string;
    topic_id: string;
    key: string;
    value: string;
    pinned: boolean;
  }[]).map((f) => ({ ...f, similarity: 0 }));
}

/**
 * What Nova should know RIGHT NOW, for one intent (normally the user's message).
 *
 * Three properties matter more than the ranking itself:
 *  1. A FLOOR that cannot be missed. Pinned facts and the most recently updated
 *     ones are always included, so a fact written a minute ago is never invisible
 *     merely because nothing has asked about it yet.
 *  2. ONE TOPIC CANNOT FLOOD. Facts are capped per topic after ranking, so a
 *     kitchen with 40 facts does not crowd out everything else.
 *  3. IT NEVER GOES BLIND. If embeddings or the RPC are unavailable, the full
 *     dump is used and `usedFallback` says so. Retrieval is an optimisation, and
 *     an optimisation must not be a dependency.
 */
export async function retrieveMemory(
  intent: string,
  opts: { budgetChars?: number; maxFacts?: number; matchLimit?: number } = {}
): Promise<RetrievedMemory> {
  const budget = opts.budgetChars ?? MEMORY_BUDGET_CHARS;
  const maxFacts = opts.maxFacts ?? 30;
  try {
    const [matched, recent, topics] = await Promise.all([
      intent.trim() ? matchFacts(intent, opts.matchLimit ?? 40) : Promise.resolve([]),
      getActiveFacts(), // pinned first, then most recently updated
      getTopics(),
    ]);

    const titleOf = new Map(topics.map((t) => [t.id, t.title]));
    const summaryOf = new Map(topics.map((t) => [t.id, t.summary]));

    const floor: RankedFact[] = recent
      .filter((f) => f.pinned)
      .concat(recent.slice(0, FLOOR_RECENT))
      .map((f) => ({
        id: f.id,
        topic_id: f.topic_id,
        key: f.key,
        value: f.value,
        pinned: f.pinned,
        similarity: 0,
      }));

    const seen = new Set<string>();
    const ranked: RankedFact[] = [];
    for (const f of [...floor, ...matched]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      ranked.push(f);
    }

    const perTopic = new Map<string, number>();
    const kept: RankedFact[] = [];
    for (const f of ranked) {
      const n = perTopic.get(f.topic_id) ?? 0;
      if (n >= MAX_PER_TOPIC) continue;
      perTopic.set(f.topic_id, n + 1);
      kept.push(f);
      if (kept.length >= maxFacts) break;
    }
    if (!kept.length) return { block: "", facts: 0, chars: 0, usedFallback: false };

    const byTopic = new Map<string, RankedFact[]>();
    for (const f of kept) {
      const list = byTopic.get(f.topic_id) ?? [];
      list.push(f);
      byTopic.set(f.topic_id, list);
    }

    const chunks: string[] = [];
    let chars = 0;
    for (const [topicId, list] of byTopic) {
      const title = titleOf.get(topicId) ?? "Other";
      const summary = summaryOf.get(topicId);
      const chunk = [
        summary ? `### ${title} — ${summary}` : `### ${title}`,
        ...list.map((f) => `- ${f.key}: ${f.value}${f.pinned ? " [pinned]" : ""}`),
      ].join("\n");
      // Always keep at least one topic, even if it alone exceeds the budget: an
      // empty memory block is worse than a long one.
      if (chars + chunk.length > budget && chunks.length) break;
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (!chunks.length) return { block: "", facts: 0, chars: 0, usedFallback: false };

    const block = `## What Nova knows about the user (retrieved for this moment)\n\n${chunks.join("\n\n")}`;
    return { block, facts: kept.length, chars: block.length, usedFallback: false };
  } catch {
    const block = await formatForContext().catch(() => "");
    return { block, facts: 0, chars: block.length, usedFallback: block.length > 0 };
  }
}

// --- backfill ---------------------------------------------------------------

/**
 * Give every active fact an embedding. Idempotent and batched (one request per
 * batch, not per fact); safe to re-run after any interruption, because it only
 * ever reads facts that have no embedding yet. Facts written from now on are
 * embedded at write time — this is for the ones that already existed.
 */
export async function backfillFactEmbeddings(
  opts: { batch?: number; dryRun?: boolean } = {}
): Promise<{ embedded: number; failed: number; remaining: number }> {
  const batch = Math.max(1, Math.min(64, opts.batch ?? 32));
  const db = createServiceClient();

  const missing = async (): Promise<number> => {
    const { count } = await db
      .from("memory_facts")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .is("embedding", null);
    return count ?? 0;
  };

  if (opts.dryRun) {
    return { embedded: 0, failed: 0, remaining: await missing() };
  }

  const topics = await getTopics();
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));

  let embedded = 0;
  let failed = 0;
  for (;;) {
    const { data, error } = await db
      .from("memory_facts")
      .select("id,topic_id,key,value")
      .eq("status", "active")
      .is("embedding", null)
      .limit(batch);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as {
      id: string;
      topic_id: string;
      key: string;
      value: string;
    }[];
    if (!rows.length) break;

    let vectors: (number[] | null)[] = [];
    try {
      vectors = await embedMany(
        rows.map((r) => factText(titleOf.get(r.topic_id) ?? "General", r.key, r.value))
      );
    } catch {
      // One failed batch must not abort the whole backfill: the next loop
      // iteration re-reads the same rows, so a persistent failure would spin.
      failed += rows.length;
      break;
    }

    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i];
      if (!vector) {
        failed++;
        continue;
      }
      const { error: upErr } = await db
        .from("memory_facts")
        .update({ embedding: vector })
        .eq("id", rows[i].id);
      if (upErr) failed++;
      else embedded++;
    }
  }

  return { embedded, failed, remaining: await missing() };
}
