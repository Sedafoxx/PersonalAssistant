import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { upsertFact, getTopics, type FactKind } from "./memory";

// --- one notebook (M2) ------------------------------------------------------
//
// `coach_memory` holds the older memory store: free-text notes about the user,
// up to three per chat turn, with no update path at all. 552 rows had accumulated
// by the time this was written. Facts (topic, key, value) can be corrected, so
// they are the single home — and these rows have to MOVE, not be copied, or the
// two-notebook problem simply persists under a new name.
//
// THE JANITOR RULE: everything written must be traceable to the notes given. This
// pass may merge, sharpen and drop, but never invent. Dropping is expected and is
// REPORTED with a reason, so "nothing lost" stays an auditable claim rather than a
// slogan — the user can see exactly which sentences were judged not worth keeping.

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

/** The part of a coach_memory row this pass needs. */
export interface LegacyNote {
  id: string;
  kind: string;
  text: string;
  category: string | null;
}

export interface ProposedFact {
  topic: string;
  key: string;
  value: string;
  kind: FactKind;
  /** Indices into the batch that this fact was built from. */
  from: number[];
  confidence: number;
}

export interface DroppedNote {
  text: string;
  reason: string;
}

export interface ConsolidationResult {
  facts: ProposedFact[];
  dropped: DroppedNote[];
}

const KINDS: FactKind[] = ["durable", "state", "derived"];

export const CONSOLIDATE_SYSTEM = `You consolidate a personal assistant's free-text NOTES about one user into a maintained FACT store. You are the janitor, not the author: every fact must be traceable to the notes you were given, and you may merge, sharpen and drop — but NEVER invent.

A fact is (topic, key, value):
- topic: a broad area of their life, in the user's own language, reusing a topic that already fits (e.g. "Küche & Vorräte", "Ziele", "Arbeit", "Beziehung"). Few topics beat many.
- key: the stable thing being talked about, short and generic ("diet", "tennis", "mother", "salary_target"). A key is a SLOT, not a sentence.
- value: its CURRENT state, plainly, present tense, without a "user" prefix.
- kind: "durable" (true for weeks: preferences, people, patterns, goals), "state" (true until reality moves: pantry, what they are reading, where they are) or "derived" (a coaching insight you are concluding, not something they said).

Rules that matter:
- MERGE. Three notes saying the same thing are ONE fact. Two notes that differ are one fact with the newest value.
- DROP what is not worth keeping: one-off logistics that are already done, scheduling chatter, a single passing emotion with no lasting value, and anything you cannot state as a current fact. Dropping is expected and good — report every drop with a short reason.
- Never invent a fact that is not supported by the notes. Never guess a value.
- Keep the language the user wrote in (German stays German).

Return ONLY JSON:
{"facts":[{"topic":"...","key":"...","value":"...","kind":"durable|state|derived","from":[0,2],"confidence":0.8}],
 "dropped":[{"index":7,"reason":"one-off errand, already done"}]}
- "from" lists the note indices the fact was built from.
- 0 facts is a valid answer when the batch is all noise.`;

/**
 * Turn one model response into validated proposals. PURE on purpose: the
 * judgement (what is worth keeping) is the model's, and the plumbing (what is
 * structurally acceptable) is testable without an API call.
 *
 * Unusable entries are dropped rather than trusted, and a drop is never silent:
 * anything the model returned but the mapper rejected lands in `dropped` with the
 * reason, so a malformed answer shows up as data instead of as a missing fact.
 */
export function mapConsolidation(
  batch: LegacyNote[],
  raw: string
): ConsolidationResult {
  let parsed: {
    facts?: {
      topic?: string;
      key?: string;
      value?: string;
      kind?: string;
      from?: unknown;
      confidence?: unknown;
    }[];
    dropped?: { index?: unknown; reason?: string }[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error("consolidation response was not JSON");
  }

  const used = new Set<number>();
  const facts: ProposedFact[] = [];
  for (const f of parsed.facts ?? []) {
    const topic = (f.topic ?? "").trim();
    const key = (f.key ?? "").trim();
    const value = (f.value ?? "").trim();
    if (!topic || !key || !value) continue;
    const kind = (KINDS.includes(f.kind as FactKind) ? f.kind : "durable") as FactKind;
    const from = (Array.isArray(f.from) ? f.from : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < batch.length);
    for (const n of from) used.add(n);
    const rawConf = typeof f.confidence === "number" ? f.confidence : Number(f.confidence);
    const confidence = Number.isFinite(rawConf)
      ? Math.min(1, Math.max(0, rawConf))
      : 0.7;
    facts.push({ topic, key, value, kind, from, confidence });
  }

  const dropped: DroppedNote[] = [];
  for (const d of parsed.dropped ?? []) {
    const idx = Number(d.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
    dropped.push({ text: batch[idx].text, reason: (d.reason ?? "").trim() || "not stated" });
  }
  // A note the model neither used nor reported is still accounted for: it is a
  // drop, and it says so. Silence would be the one unacceptable outcome.
  for (let i = 0; i < batch.length; i++) {
    if (!used.has(i) && !dropped.some((d) => d.text === batch[i].text)) {
      dropped.push({ text: batch[i].text, reason: "the model did not use it" });
    }
  }

  return { facts, dropped };
}

/** Notes that have not been consolidated into facts yet. */
export async function listUnconsolidated(limit = 10000): Promise<LegacyNote[]> {
  const db = createServiceClient();
  const [{ data: notes, error: nErr }, { data: done, error: dErr }] = await Promise.all([
    db
      .from("coach_memory")
      .select("id,kind,text,category,created_at")
      .order("created_at", { ascending: true })
      .limit(limit),
    db.from("memory_facts").select("source_ref").eq("source", "consolidated"),
  ]);
  if (nErr) throw new Error(nErr.message);
  if (dErr) throw new Error(dErr.message);

  // A consolidated fact records the note ids it came from, so a re-run skips
  // work already done — the pass is resumable instead of all-or-nothing.
  const covered = new Set<string>();
  for (const row of (done ?? []) as { source_ref: string | null }[]) {
    for (const id of (row.source_ref ?? "").split(",")) {
      if (id.trim()) covered.add(id.trim());
    }
  }

  return ((notes ?? []) as (LegacyNote & { created_at: string })[])
    .filter((n) => !covered.has(n.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      text: n.text,
      category: n.category,
    }));
}

export interface ConsolidateSummary {
  notesRead: number;
  batches: number;
  factsWritten: number;
  factsMerged: number;
  dropped: DroppedNote[];
  sample: ProposedFact[];
  dryRun: boolean;
}

/**
 * Move legacy notes into the facts store, in batches, resumably.
 *
 * `dryRun` makes NO writes and returns the same summary, so the proposal can be
 * read before it is applied — which matters because this is a judgement call on
 * 552 sentences, and the alternative (writing first, looking later) is how a
 * cleanup becomes the next mess.
 */
export async function consolidateMemories(
  opts: { batchSize?: number; limit?: number; dryRun?: boolean } = {}
): Promise<ConsolidateSummary> {
  const batchSize = Math.max(5, Math.min(40, opts.batchSize ?? 25));
  const notes = await listUnconsolidated();
  const scoped = opts.limit ? notes.slice(0, opts.limit) : notes;

  // The topics that already exist, handed to the model on every batch.
  //
  // Without this, each batch invents topic names from the notes in front of it and
  // the store fragments: the first run created 127 topics, with "Fitness" and
  // "Gesundheit & Fitness" both live. A batch cannot reuse a name it has never
  // seen, so the vocabulary has to travel with the request.
  const knownTopics = (await getTopics()).map((t) => t.title);
  const topicGuidance = knownTopics.length
    ? `\n\nExisting topics — REUSE one of these whenever it fits, and only invent a new topic when none of them covers the note:\n${knownTopics.join(" | ")}`
    : "";

  const summary: ConsolidateSummary = {
    notesRead: scoped.length,
    batches: 0,
    factsWritten: 0,
    factsMerged: 0,
    dropped: [],
    sample: [],
    dryRun: !!opts.dryRun,
  };

  for (let i = 0; i < scoped.length; i += batchSize) {
    const batch = scoped.slice(i, i + batchSize);
    const numbered = batch
      .map((n, idx) => `[${idx}] (${n.category ?? n.kind}) ${n.text}`)
      .join("\n");

    const res = await llm().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CONSOLIDATE_SYSTEM },
        {
          role: "user",
          content: `Notes:\n${numbered}${topicGuidance}\n\nConsolidate them (JSON).`,
        },
      ],
    });
    const raw = (res.choices[0].message.content ?? "").trim();
    const { facts, dropped } = mapConsolidation(batch, raw);
    summary.batches++;
    summary.dropped.push(...dropped);
    if (summary.sample.length < 12) summary.sample.push(...facts.slice(0, 12));

    for (const f of facts) {
      if (summary.dryRun) {
        summary.factsWritten++;
        continue;
      }
      const sourceRefs = f.from.map((n) => batch[n]?.id).filter(Boolean).join(",");
      try {
        const result = await upsertFact({
          topic: f.topic,
          key: f.key,
          value: f.value,
          kind: f.kind,
          confidence: f.confidence,
          source: "consolidated",
          source_ref: sourceRefs || batch[0]?.id || null,
        });
        summary.factsWritten++;
        if (result.supersededId) summary.factsMerged++;
      } catch (err) {
        summary.dropped.push({
          text: f.value,
          reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return summary;
}
