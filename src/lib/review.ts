import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { curateTopic, getActiveFacts, getTopics, type MemoryTopic } from "./memory";
import { listLoops, staleLoops } from "./loops";
import { listCommitments } from "./commitments";
import { getReflection } from "./reflection";
import { logicalDay } from "./dates";

// --- the nightly review -----------------------------------------------------
//
// The coach tidies up at night so the morning starts from a tidy record rather
// than a pile. It runs at 02:00, unattended, against the record the day left
// behind.
//
// THE RULE THAT SHAPES EVERY DECISION HERE: the review consolidates and
// reports; it never silently changes the user's state. It may rewrite a topic
// SUMMARY — a derived, regenerable artefact, exactly the curate step that
// already exists. It may NOT change a loop's state or waiting_on (that is an
// assertion about the user's world), delete or supersede a fact, or archive or
// edit an item or a commitment.
//
// Instead it produces a report: what it tidied, what looks contradictory, what
// has gone quiet. That report is stored (so it is auditable) and surfaced in the
// 08:00 morning check. Same discipline as forget_fact being propose-only, and
// scripts/review-test.ts asserts the discipline rather than promising it: it
// snapshots every loop's state/waiting_on and every considered topic's active
// fact count before and after, and requires them to be identical.

export interface ReviewObservation {
  topic?: string;
  kind: "contradiction" | "stale" | "note";
  text: string;
}

export interface NightlyReview {
  id: string | null;
  ranAt: string;
  topicsConsidered: number;
  topicsCurated: number;
  staleLoops: number;
  openCommitments: number;
  observations: ReviewObservation[];
  skippedReason?: string;
}

const REVIEW_COLS =
  "id,ran_at,topics_curated,topics_considered,stale_loops,open_commitments,observations,notes,created_at";

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

// --- constants --------------------------------------------------------------

const DEFAULT_MAX_TOPICS = 5;
const MAX_OBSERVATIONS = 3;
/** How far back "touched" reaches: the night reviews the day it just closed. */
const TOUCH_WINDOW_HOURS = 24;

const KINDS: ReviewObservation["kind"][] = ["contradiction", "stale", "note"];

const REVIEW_SYSTEM = `You review one person's maintained life record overnight, looking for things that have gone WRONG in the record itself — never for things for them to do. You are the tidy-up pass, not the coach.

You look ONLY for:
- facts within the SAME topic that CONTRADICT each other (both cannot be true at once),
- facts that look STALE given a NEWER fact in the same topic,
- loops or commitments that appear SUPERSEDED or DUPLICATED by another entry,
- at most ONE genuine note, only if something important is otherwise unrecorded.

Rules — these matter:
- Maximum 3 observations. An EMPTY array is the correct and expected answer on a clean night: most nights there is nothing to report, and inventing work to look useful is a failure.
- Each observation is ONE sentence, and each names its topic (use the topic as it is given to you).
- "kind" is "contradiction" for facts that cannot both be true, "stale" for something a newer fact has moved past, "note" for the single optional remark.
- Report ONLY what is in front of you. Never invent a fact, a loop or a commitment, and never suggest an action.
- You are REPORTING, not changing anything: you cannot edit, delete or resolve anything. You only describe what you see.

Return ONLY JSON: {"observations":[{"topic":"...","kind":"contradiction|stale|note","text":"..."}]}`;

// --- pure helpers -----------------------------------------------------------

/**
 * Best-effort normalization of a model-supplied observations array.
 *
 * Shape is enforced, content is not: contradiction detection is a model
 * judgement, so this rejects malformed entries and caps the count rather than
 * second-guessing what the model found. An unknown `kind` is dropped (a finding
 * with no category cannot be acted on) and a missing topic is allowed, since a
 * `note` may be about the record as a whole.
 */
export function normalizeObservations(raw: unknown): ReviewObservation[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ReviewObservation[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { topic?: unknown; kind?: unknown; text?: unknown };
    const kind = KINDS.includes(e.kind as ReviewObservation["kind"])
      ? (e.kind as ReviewObservation["kind"])
      : null;
    if (!kind) continue;
    const text = typeof e.text === "string" ? e.text.trim().slice(0, 500) : "";
    if (!text) continue;
    const topic =
      typeof e.topic === "string" && e.topic.trim()
        ? e.topic.trim().slice(0, 200)
        : undefined;
    out.push(topic ? { topic, kind, text } : { kind, text });
    if (out.length >= MAX_OBSERVATIONS) break;
  }
  return out;
}

// --- formatting -------------------------------------------------------------

const KIND_LABEL: Record<ReviewObservation["kind"], string> = {
  contradiction: "contradiction",
  stale: "stale",
  note: "note",
};

/**
 * One short line for the 08:00 memory check, or "" when there is nothing to
 * report. An empty string is a first-class answer here: a review with no
 * observations — and a review that never ran — must both leave the morning
 * message exactly as it was, so the caller can append unconditionally.
 */
export function formatReviewForMorning(review: NightlyReview | null): string {
  if (!review || review.observations.length === 0) return "";
  const first = review.observations[0];
  const label = KIND_LABEL[first.kind];
  const topic = first.topic ? `${first.topic} — ` : "";
  const rest =
    review.observations.length > 1
      ? ` (+${review.observations.length - 1} more)`
      : "";
  return `last night: ${label} in ${topic}${first.text}${rest}`;
}

// --- reads ------------------------------------------------------------------

interface RawReviewRow {
  id: string;
  ran_at: string;
  topics_curated: number | null;
  topics_considered: number | null;
  stale_loops: number | null;
  open_commitments: number | null;
  observations: unknown;
  notes: string | null;
  created_at: string;
}

function rowToReview(row: RawReviewRow): NightlyReview {
  return {
    id: row.id,
    ranAt: row.ran_at,
    topicsConsidered: row.topics_considered ?? 0,
    topicsCurated: row.topics_curated ?? 0,
    staleLoops: row.stale_loops ?? 0,
    openCommitments: row.open_commitments ?? 0,
    observations: normalizeObservations(row.observations),
    ...(row.notes ? { skippedReason: row.notes } : {}),
  };
}

/**
 * The latest review, or null when none was ever written (also on any failure —
 * a read-only inspection route must not turn a missing table into an error).
 */
export async function latestReview(): Promise<NightlyReview | null> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_reviews")
      .select(REVIEW_COLS)
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rowToReview(data as RawReviewRow) : null;
  } catch {
    return null;
  }
}

// --- the run ----------------------------------------------------------------

// Topics touched in the last 24 hours, newest first. This is the bounded input
// to the whole run: a nightly job must tidy what the day touched, not re-audit
// the entire record — a nightly run must not become a nightly bill.
async function touchedTopics(cutoffIso: string): Promise<MemoryTopic[]> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_topics")
      .select("id,slug,title,summary,summary_updated_at,updated_at")
      .gte("updated_at", cutoffIso)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as MemoryTopic[];
  } catch {
    return [];
  }
}

/**
 * Run one nightly review.
 *
 * Writes exactly ONE row to `memory_reviews` on a night with anything to review,
 * and no row at all on a night with nothing to review (an empty night must not
 * create noise in the audit trail). Never throws: any failure comes back as a
 * review carrying a `skippedReason`, because this runs unattended at 02:00 and a
 * thrown error would simply be an empty cron log.
 */
export async function runNightlyReview(opts?: {
  maxTopics?: number;
}): Promise<NightlyReview> {
  const maxTopics = Math.max(0, Math.floor(opts?.maxTopics ?? DEFAULT_MAX_TOPICS));
  const ranAt = new Date().toISOString();

  // Nothing to say yet, spelled out rather than implied: every observation is
  // built on this shape so an early return can never be mistaken for a full run.
  const blank = (skippedReason: string): NightlyReview => ({
    id: null,
    ranAt,
    topicsConsidered: 0,
    topicsCurated: 0,
    staleLoops: 0,
    openCommitments: 0,
    observations: [],
    skippedReason,
  });

  try {
    // 1. What the day touched, bounded. `maxTopics: 0` is a legitimate request
    //    for "consider nothing", which is how the test simulates a clean night.
    const cutoff = new Date(
      Date.now() - TOUCH_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const touched = await touchedTopics(cutoff);
    const considered = maxTopics > 0 ? touched.slice(0, maxTopics) : [];

    // 2. The state we may only ever REPORT on. Read up front so the model is
    //    given the same snapshot the row counts.
    const [stale, openCommitments, loops] = await Promise.all([
      staleLoops(),
      listCommitments({ status: "open", limit: 100 }),
      listLoops({ limit: 100 }),
    ]);
    const openLoops = loops.filter((loop) => loop.state !== "done");
    const waitingOnYou = openLoops.filter((loop) => loop.waiting_on === "you");

    if (!considered.length && !openLoops.length && !openCommitments.length) {
      // A night with nothing to tidy writes no row: an audit trail of empty
      // nights is noise, and its absence is itself the honest signal.
      return blank("nothing to review");
    }

    // 3. Curate each considered topic. Best-effort per topic: one failure must
    //    not stop the rest, and only a topic that ACTUALLY produced a summary
    //    counts — curateTopic returns null and leaves the old summary in place
    //    on any failure, so counting calls made would overstate the work done.
    let topicsCurated = 0;
    const factsByTopic: { topic: MemoryTopic; facts: Awaited<ReturnType<typeof getActiveFacts>> }[] = [];
    for (const topic of considered) {
      try {
        const summary = await curateTopic(topic.id);
        if (summary) topicsCurated++;
      } catch {
        // non-fatal: the previous summary stays, this topic simply did not change
      }
      try {
        const facts = await getActiveFacts(topic.id);
        if (facts.length) factsByTopic.push({ topic, facts });
      } catch {
        // non-fatal: a topic with an unreadable fact list is left out of the prompt
      }
    }

    // 4. ONE JSON-mode call, in the identical llm()/MODEL style as coach.ts.
    //    Everything is best-effort: an unparseable answer yields an empty report
    //    rather than a failed run, because "found nothing" and "could not look"
    //    must not look the same in the audit trail.
    let observations: ReviewObservation[] = [];
    try {
      const parts: string[] = [];

      if (factsByTopic.length) {
        const blocks = factsByTopic.map(({ topic, facts }) => {
          const lines = facts.map((f) => `- ${f.key}: ${f.value}`);
          return `## ${topic.title}\n${lines.join("\n")}`;
        });
        parts.push(`## Facts by topic (active, newest first)\n\n${blocks.join("\n\n")}`);
      } else {
        parts.push("## Facts by topic\n(none accepted today)");
      }

      if (openLoops.length) {
        parts.push(
          `## Open loops (NOT yours to change)\n` +
            openLoops
              .map(
                (l) =>
                  `- ${l.subject}: ${l.thread} [${l.state}${
                    l.waiting_on ? `, waiting on ${l.waiting_on}` : ""
                  }, last touched ${l.last_touched_at.slice(0, 10)}]`
              )
              .join("\n")
        );
      } else {
        parts.push("## Open loops\n(none)");
      }

      if (openCommitments.length) {
        parts.push(
          `## Open commitments (NOT yours to change)\n` +
            openCommitments
              .map(
                (c) =>
                  `- ${c.text}${c.due_date ? ` (due ${c.due_date})` : ""}`
              )
              .join("\n")
        );
      } else {
        parts.push("## Open commitments\n(none)");
      }

      // Today's reflection, when there is one — the day's own words about how it
      // went, which is often what makes a stale fact visible.
      try {
        const reflection = await getReflection(logicalDay());
        if (reflection) {
          const line = [
            reflection.went_well ? `Went well: ${reflection.went_well}` : "",
            reflection.could_improve
              ? `Could improve: ${reflection.could_improve}`
              : "",
          ]
            .filter(Boolean)
            .join(" | ");
          if (line) parts.push(`## Today's reflection\n${line}`);
        }
      } catch {
        // non-fatal: no reflection section
      }

      parts.push(
        `${waitingOnYou.length} loop(s) are waiting on the user. ` +
          `${stale.length} loop(s) have gone quiet.`
      );

      const res = await llm().chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          {
            role: "user",
            content:
              `${parts.join("\n\n")}\n\n` +
              `Report what is wrong with this record (JSON). An empty array is ` +
              `the correct answer on a clean night.`,
          },
        ],
      });
      const raw = (res.choices[0].message.content ?? "").trim();
      const parsed = JSON.parse(raw) as { observations?: unknown };
      observations = normalizeObservations(parsed.observations);
    } catch {
      // A model or parse failure reports nothing rather than guessing; the row
      // below is still written, so the night is on record as having run.
      observations = [];
    }

    // 5. Exactly one row per run. The row records what was considered, what was
    //    actually rewritten, and the state that was OBSERVED but never touched.
    const db = createServiceClient();
    const { data, error } = await db
      .from("memory_reviews")
      .insert({
        ran_at: ranAt,
        topics_considered: considered.length,
        topics_curated: topicsCurated,
        stale_loops: stale.length,
        open_commitments: openCommitments.length,
        observations,
        notes: null,
      })
      .select(REVIEW_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const review: NightlyReview = {
      id: (data as RawReviewRow | null)?.id ?? null,
      ranAt,
      topicsConsidered: considered.length,
      topicsCurated,
      staleLoops: stale.length,
      openCommitments: openCommitments.length,
      observations,
    };
    if (observations.length === 0) {
      // Not a skip — the night is on record, it simply had nothing to report.
      review.skippedReason = "no observations";
    }
    return review;
  } catch (err) {
    return blank((err as Error).message || "review failed");
  }
}
