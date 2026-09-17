// Nova's feed, part 1: what FITS the user, as interests WITH evidence.
//
// The assistant reads the user's own signals — goals, milestone steps, living
// memory, journal themes, captured ideas, past conversations — and derives 8 to
// 12 concrete, readable areas of interest, each citing the signal that produced
// it and carrying the English search phrases that will actually find it.
// Discovery (P2) turns those interests into validated links; ranking (P3) and
// UI (P4) come later.
//
// Two rules hold everywhere in this module:
//   - every external source is best-effort: a failure yields an empty result,
//     never a thrown error that blanks the page;
//   - the model never deletes and never touches a row it did not write. Only
//     rows with source='derived' are its to update.

import OpenAI from "openai";
import { createServiceClient } from "./supabase";
import { getGoals } from "./goals";
import { getMilestones } from "./milestones";
import { getTopics, getActiveFacts, formatForContext } from "./memory";
import { getCategories, getJournalEntries } from "./journal";
import { getItems } from "./db";
import { getCoachMemories } from "./coach";
import { logicalDay } from "./dates";
import {
  validate,
  searchArticles,
  searchYouTube,
  searchPodcasts,
  searchAiNews,
  canonicalUrl,
  isShortformSocial,
  isAiSoftwareInterest,
  type Candidate as SourceCandidate,
  type ItemKind,
} from "./feed-sources";

// --- types ------------------------------------------------------------------

export type InterestKind = "topic" | "avoid";

export interface FeedInterest {
  id: string;
  slug: string | null;
  text: string;
  kind: InterestKind;
  weight: number;
  queries: string[];
  evidence: string | null;
  source: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InterestDerivation {
  interests: FeedInterest[];
  created: number;
  updated: number;
  retired: number;
  /** Active areas that missed this derivation but were HELD because of hysteresis. */
  missed: number;
}

/**
 * Consecutive derivations an active area may be absent before it is deactivated.
 *
 * One is too few: the model re-phrases and re-balances between runs, so a single
 * absence is drift and retiring on it made the active set flap between 11 and 12
 * areas. Two is a change of mind.
 */
const MISSES_BEFORE_RETIRE = 2;

const INTEREST_COLS =
  "id,slug,text,kind,weight,queries,evidence,source,active,created_at,updated_at";

// A stored feed row, as far as P2 cares about it. score/reason/bucket are P3's.
export interface FeedItem {
  id: string;
  url: string;
  kind: ItemKind;
  platform: string;
  title: string;
  summary: string | null;
  creator: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  image_url: string | null;
  validated: boolean;
  matched_interest_id: string | null;
  status: string;
  surfaced_day: string | null;
  created_at: string;
  updated_at: string;
}

const ITEM_COLS =
  "id,url,kind,platform,title,summary,creator,published_at,duration_seconds,image_url,validated,matched_interest_id,status,surfaced_day,created_at,updated_at";

export interface DiscoveryStats {
  tavilyCalls: number;
  found: number;
  validated: number;
  // Two different kinds of "no", kept apart on purpose: a dead link is a
  // validation failure, a live link that does not fit is a relevance failure.
  rejectedValidation: number;
  rejectedRelevance: number;
  // Per source, how many candidates it returned and whether it errored or came
  // back empty — so a dead source is a fact in the stats, not an absence. Filled
  // in by discoverCandidates; optional so a caller can build a zeroed stats
  // object before a run has happened.
  bySource?: Record<string, SourceOutcome>;
}

// How many candidates each source contributed and how many of them the
// relevance gate threw away, per interest. The report prints this so a source
// that silently stops contributing is visible rather than merely absent.
export interface SourceTally {
  found: number;
  droppedRelevance: number;
}

export interface DiscoveredItem {
  candidate: SourceCandidate;
  kind: ItemKind;
  platform: string;
  interest_id: string;
  interest_text: string;
}

// What ONE source did on ONE interest: how many candidates it returned, and —
// the point of this type — whether it ERRORED or came back EMPTY. Without it a
// source that dies contributes nothing and leaves no trace, so an outage and a
// genuinely thin topic look identical in the report.
export interface SourceOutcome {
  candidates: number;
  errored: boolean;
  empty: boolean;
  /** The reason it errored, when one was reported (e.g. "HTTP 403"). */
  reason: string | null;
}

export interface DiscoveryResult {
  candidates: DiscoveredItem[];
  stats: DiscoveryStats;
  // Per interest text, then per source type (`articles`, `youtube`,
  // `podcasts`, `ai-news`).
  bySource: Record<string, Record<string, SourceTally>>;
  // Per SOURCE (not per interest), the outcome of this run's calls, so a failing
  // or empty source is a named fact in the returned stats rather than silence.
  sourceOutcomes: Record<string, SourceOutcome>;
  // One human-readable line per source that failed or returned nothing.
  sourceNotes: string[];
}

export interface DiscoveryOptions {
  maxInterests?: number;
  perSourceLimit?: number;
  tavilyBudget?: number;
}

// --- LLM (mirrors coach.ts / journal.ts / memory.ts: DeepSeek-safe) ----------

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

// --- db helpers -------------------------------------------------------------

// All interests, highest weight first. Inactive rows are returned too when
// activeOnly is false, so a removed interest stays inspectable rather than
// vanishing.
export async function getInterests(
  activeOnly = true
): Promise<FeedInterest[]> {
  const db = createServiceClient();
  let q = db.from("feed_interests").select(INTEREST_COLS);
  if (activeOnly) q = q.eq("active", true);
  q = q.order("weight", { ascending: false }).order("text", { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as FeedInterest[];
}

// --- fit signals ------------------------------------------------------------

// A compact text digest of everything the user's own data says about them,
// labelled by section so the model can cite a specific one as evidence.
//
// Every source sits in its own try/catch and falls back to empty: a missing
// table or a failed read must leave the rest of the digest intact, because a
// partial digest still derives useful interests.
export async function gatherFitSignals(): Promise<string> {
  const parts: string[] = [];

  // Goals: title, progress/target, cadence.
  try {
    const goals = await getGoals("active");
    if (goals.length) {
      parts.push(
        `## Active goals (${goals.length})\n` +
          goals
            .map(
              (g) =>
                `- ${g.title} [${g.progress}${g.target ? `/${g.target}` : ""}]${
                  g.cadence ? ` (${g.cadence})` : ""
                }${g.description ? ` — ${g.description}` : ""}`
            )
            .join("\n")
      );
    }
  } catch {
    // no goals section
  }

  // Open milestone steps, grouped by the goal they belong to. These are the
  // most concrete statements of intent the user has, so they are the strongest
  // evidence available.
  try {
    const [goals, milestones] = await Promise.all([
      getGoals("active"),
      getMilestones(),
    ]);
    const titleById = new Map(goals.map((g) => [g.id, g.title]));
    const openByGoal = new Map<string, string[]>();
    for (const m of milestones) {
      if (m.done) continue;
      const list = openByGoal.get(m.goal_id) ?? [];
      list.push(m.title);
      openByGoal.set(m.goal_id, list);
    }
    const lines: string[] = [];
    for (const [goalId, titles] of openByGoal) {
      lines.push(
        `- ${titleById.get(goalId) ?? "goal"}: ${titles.slice(0, 10).join("; ")}`
      );
    }
    if (lines.length) {
      parts.push(`## Open milestone steps (per goal)\n${lines.join("\n")}`);
    }
  } catch {
    // no milestones section
  }

  // Living memory: per topic, its summary and its current key: value facts.
  try {
    const [topics, facts] = await Promise.all([getTopics(), getActiveFacts()]);
    if (topics.length && facts.length) {
      const byTopic = new Map<string, { key: string; value: string }[]>();
      for (const f of facts) {
        const list = byTopic.get(f.topic_id) ?? [];
        list.push({ key: f.key, value: f.value });
        byTopic.set(f.topic_id, list);
      }
      const blocks: string[] = [];
      for (const t of topics) {
        const list = (byTopic.get(t.id) ?? []).slice(0, 12);
        if (!list.length) continue;
        const header = t.summary ? `### ${t.title} — ${t.summary}` : `### ${t.title}`;
        blocks.push(
          [header, ...list.map((f) => `- ${f.key}: ${f.value}`)].join("\n")
        );
      }
      if (blocks.length) {
        parts.push(`## Living memory (maintained facts)\n\n${blocks.join("\n\n")}`);
      }
    }
  } catch {
    // no living-memory section — formatForContext() below is a second chance
  }

  // The formatted context block, when the direct read above found nothing.
  try {
    if (!parts.some((p) => p.startsWith("## Living memory"))) {
      const living = await formatForContext();
      if (living) parts.push(living);
    }
  } catch {
    // no living-memory section
  }

  // Journal categories plus trimmed recent entries: the recurring themes the
  // user actually writes about, which the structured stores may not capture.
  try {
    const [categories, entries] = await Promise.all([
      getCategories(),
      getJournalEntries(40),
    ]);
    const lines: string[] = [];
    if (categories.length) {
      lines.push(`Categories: ${categories.map((c) => c.name).join(", ")}`);
    }
    for (const e of entries) {
      const text = (e.summary ?? e.raw_text ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push(`- ${text.slice(0, 200)}`);
    }
    if (lines.length) {
      parts.push(`## Journal themes (recent entries, newest first)\n${lines.join("\n")}`);
    }
  } catch {
    // no journal section
  }

  // Captured ideas: things the user chose to write down, so they carry intent.
  try {
    const ideas = await getItems({ type: "idea" });
    if (ideas.length) {
      parts.push(
        `## Captured ideas (${ideas.length})\n` +
          ideas
            .slice(0, 40)
            .map((i) => {
              const snippet = (i.content ?? i.title ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 160);
              return `- ${i.title}${snippet ? `: ${snippet}` : ""}`;
            })
            .join("\n")
      );
    }
  } catch {
    // no ideas section
  }

  // Distilled free-text memory of past conversations.
  try {
    const memories = await getCoachMemories(60);
    if (memories.length) {
      parts.push(
        `## What you remember about the user (long-term)\n` +
          memories.map((m) => `- [${m.kind}] ${m.text}`).join("\n")
      );
    }
  } catch {
    // no memory section
  }

  // Keep the digest to a size a model can actually cite from. Sections come in
  // a deliberate order — goals and milestones first — so a truncation loses the
  // weakest evidence, not the strongest.
  const digest = parts.join("\n\n");
  return digest.length > 6000 ? `${digest.slice(0, 6000)}\n…[truncated]` : digest;
}

// --- derivation -------------------------------------------------------------

const DERIVE_SYSTEM = `You work out what a specific person WANTS to read, watch and listen to, from evidence about their actual life. You are precise, concrete and honest, and you never flatter.

Return ONLY JSON:
{"interests":[{"slug":"vegan-curry","text":"Vegan curry cooking","kind":"topic","weight":1.2,"queries":["vegan curry recipe coconut milk","easy vegan curry for beginners"],"evidence":"..."}]}

Rules:
- Give 8 to 12 areas. Fewer, better areas beat many thin ones.
- "text" is a short human-readable LABEL IN ENGLISH, capitalised normally — the app's UI is English even though the user's own data is German. "evidence" may quote the original German verbatim; the label must not.
- "slug" is lowercase kebab-case, stable and specific ("vegan-curry", not "food"). Two areas with the same subject MUST share a slug: "AI initiative ownership at work" and "AI product ownership case building" are ONE area, and must come out as a single object with one slug.
- THE WATCHABILITY TEST: an interest must be something a person could watch a video, read an article or listen to a podcast episode ABOUT. Reject and omit errands, shopping-list items, scheduled calls, promises, and anything the user is doing for someone else. "Curry Grundgewürze besorgen" and "Feierabend-Anruf 20 Uhr" are exactly what must NOT appear.
- "queries" is 2 to 3 SEARCH KEYWORD PHRASES IN ENGLISH — no punctuation, no sentences, no question marks. These are the strings the search APIs actually receive, so they must be the phrases that would return good results.
- "kind" is "avoid" ONLY for things the signals show they want LESS of (brain rot, doomscrolling, outrage news), and ONLY when "evidence" contains a VERBATIM signal — something the user actually said or implied in the digest. With no such signal, emit NO avoid rows. At most 2 avoid rows.
- "evidence" must cite the ACTUAL signal you used, naming it specifically — for example "4 active goals; living-memory topic Küche & Vorräte" or "3 journal entries about running". Quote the German verbatim when you quote at all. Inventing evidence is worse than a lower weight.
- "weight" is 0.5 to 1.5. Use a higher weight for areas backed by active goals or repeated mentions, lower for a single passing mention.
- Base every area on the signals given. If the signals are thin, return fewer areas rather than inventing plausible ones.
- If a list of the areas you derived LAST TIME is given, REUSE those exact slugs for the areas that are still the same subject. Never invent a new slug for an area you already named; a changed slug retires a good row and creates a duplicate of it.`;

// The areas the previous derivation produced, as (slug, label) pairs, so the
// model reuses its own stable slug instead of inventing a new one for the same
// subject on every call. A changed slug is what used to churn the active set.
async function previousAreasBlock(): Promise<string> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("feed_interests")
      .select("slug,text")
      .eq("source", "derived")
      .eq("active", true)
      .not("slug", "is", null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { slug: string; text: string }[];
    if (!rows.length) return "";
    return (
      `## Areas you derived LAST TIME (reuse these exact slugs where the subject still matches)\n` +
      rows.map((r) => `- ${r.slug} — ${r.text}`).join("\n")
    );
  } catch {
    return "";
  }
}

// Tokens too generic to distinguish two areas. Dropped before the Jaccard
// comparison so "Tennis spielen Hobby" and "tennis training drills and
// technique" collapse on their shared subject rather than on "and".
const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "at", "with", "und",
  "mit", "für", "von", "der", "die", "das", "den", "dem", "im", "am", "zu",
  "or", "your", "my", "about", "how", "what", "tips", "guide", "basics",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

// Jaccard overlap of two labels' significant tokens. >= 0.6 means "the same
// area" — the belt-and-braces for language-varying near-duplicates.
export function tokenOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

// The merge half of the derivation, in code rather than in the prompt: the
// model is trusted less than the prompt implies. Same slug collapses to one
// candidate (higher weight wins, evidence concatenates), and a label that
// overlaps an already-kept label by >= 0.6 is the same area too.
const MERGE_OVERLAP = 0.6;

// A lower floor used only to pair a re-derived candidate with an existing row
// whose slug drifted but whose subject clearly stayed ("Vegan Cooking" vs
// "Cooking Curry with Coconut Milk"). Below this the areas are treated as
// genuinely different.
const RENAME_OVERLAP = 0.2;

interface Candidate {
  slug: string;
  text: string;
  kind: InterestKind;
  weight: number;
  queries: string[];
  evidence: string;
}

function parseCandidates(
  items: { slug?: unknown; text?: unknown; kind?: unknown; weight?: unknown; queries?: unknown; evidence?: unknown }[]
): Candidate[] {
  const bySlug = new Map<string, Candidate>();
  const kept: Candidate[] = [];

  for (const item of items) {
    const text = String(item.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
    if (!text) continue;
    const slug = String(item.slug ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!slug) continue;
    const kind: InterestKind = item.kind === "avoid" ? "avoid" : "topic";

    const n = typeof item.weight === "number" ? item.weight : Number(item.weight);
    const weight = Number.isFinite(n)
      ? Math.min(1.5, Math.max(0.5, Math.round(n * 100) / 100))
      : 1;

    const queries = Array.isArray(item.queries)
      ? item.queries
          .map((q) => String(q ?? "").trim().replace(/\s+/g, " "))
          .filter(Boolean)
          .slice(0, 3)
      : [];

    const evidence = String(item.evidence ?? "").trim().slice(0, 500);

    const candidate: Candidate = { slug, text, kind, weight, queries, evidence };

    // Rule 1: identical slug is the same area. Keep the higher weight and
    // concatenate the evidence so neither cited signal is lost.
    const prior = bySlug.get(slug);
    if (prior) {
      if (weight > prior.weight) {
        prior.text = text;
        prior.weight = weight;
      }
      if (evidence && !prior.evidence.includes(evidence)) {
        prior.evidence = prior.evidence ? `${prior.evidence}; ${evidence}` : evidence;
      }
      continue;
    }

    // Rule 2: a label that overlaps an already-kept label is the same area.
    if (kept.some((k) => tokenOverlap(k.text, text) >= MERGE_OVERLAP)) continue;

    bySlug.set(slug, candidate);
    kept.push(candidate);
  }

  return kept;
}

// One LLM call derives the interests from the fit signals, then upserts them.
//
// Upsert matches on (slug, kind), falling back to (text_norm, kind) for legacy
// rows written before slugs existed — that fallback is what absorbs the rows an
// earlier run already created. A match updates text, weight, evidence, queries
// and updated_at; a miss inserts with source 'derived' and active true.
//
// Afterwards every source='derived' row that is still active but was NOT part
// of this run is deactivated. Nothing is ever deleted and a row whose source is
// not 'derived' is left completely alone — a user-removed or hand-added
// interest belongs to the user, not to the model.
export async function deriveInterests(): Promise<InterestDerivation> {
  const [signals, previous] = await Promise.all([
    gatherFitSignals(),
    previousAreasBlock(),
  ]);

  let parsed: { interests?: { slug?: unknown; text?: unknown; kind?: unknown; weight?: unknown; queries?: unknown; evidence?: unknown }[] };
  try {
    const res = await llm().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DERIVE_SYSTEM },
        {
          role: "user",
          content: `${signals}${
            previous ? `\n\n${previous}` : ""
          }\n\nDerive the interests now (JSON).`,
        },
      ],
    });
    const raw = (res.choices[0].message.content ?? "").trim();
    parsed = JSON.parse(raw);
  } catch {
    // A failed call or unparseable JSON yields no changes, never an exception.
    return { interests: await getInterests(), created: 0, updated: 0, retired: 0, missed: 0 };
  }

  const db = createServiceClient();
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;

  // The model's areas after the code-side merge. At most 2 avoid rows, and only
  // those carrying real evidence: an "avoid" the model could not cite is the
  // invented row this step exists to remove.
  const candidates = parseCandidates(parsed.interests ?? []);
  const topics = candidates.filter((c) => c.kind === "topic");
  const avoids = candidates
    .filter((c) => c.kind === "avoid" && c.evidence)
    .slice(0, 2);
  const final = [...topics, ...avoids].slice(0, 14);

  const liveIds: string[] = [];

  // The existing derived rows, so a re-derivation whose labels are stable but
  // whose slugs drifted still updates the row instead of creating a new one and
  // retiring the old. Without this the active set churns every run.
  let activeDerived: { id: string; slug: string | null; text: string; kind: InterestKind }[] = [];
  try {
    const { data, error } = await db
      .from("feed_interests")
      .select("id,slug,text,kind")
      .eq("source", "derived")
      .eq("active", true);
    if (error) throw new Error(error.message);
    activeDerived = (data ?? []) as typeof activeDerived;
  } catch {
    // No memory of prior runs: insert-only, same as before.
  }
  const claimed = new Set<string>();

  for (const c of final) {
    // text_norm is a generated column, so match on it directly.
    const textNorm = c.text.toLowerCase();
    try {
      let existing: FeedInterest | null = null;

      // Best unclaimed row of the same kind: the slug is the identity, and a
      // strong label overlap is the belt-and-braces for a renamed area. The
      // memory of prior runs is what keeps a re-derivation from churning.
      let remembered = activeDerived.find(
        (r) =>
          r.kind === c.kind &&
          !claimed.has(r.id) &&
          (r.slug === c.slug || tokenOverlap(r.text, c.text) >= MERGE_OVERLAP)
      );

      // Still nothing: fall back to the best-matching unclaimed row of the same
      // kind at a low floor. A re-derivation that keeps the same areas but
      // re-phrases them must update those rows, not retire and recreate them.
      if (!remembered) {
        const scored = activeDerived
          .filter((r) => r.kind === c.kind && !claimed.has(r.id))
          .map((r) => ({ r, s: tokenOverlap(r.text, c.text) }))
          .filter((x) => x.s >= RENAME_OVERLAP)
          .sort((a, b) => b.s - a.s);
        remembered = scored[0]?.r;
      }
      if (remembered) {
        claimed.add(remembered.id);
        const { data, error } = await db
          .from("feed_interests")
          .select(INTEREST_COLS)
          .eq("id", remembered.id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        existing = (data as FeedInterest | null) ?? null;
      }

      if (!existing) {
        const { data: bySlug, error: slugErr } = await db
          .from("feed_interests")
          .select(INTEREST_COLS)
          .eq("slug", c.slug)
          .eq("kind", c.kind)
          .maybeSingle();
        if (slugErr) throw new Error(slugErr.message);
        existing = (bySlug as FeedInterest | null) ?? null;
      }

      if (!existing) {
        // Legacy row from before slugs: match the derived row by label so the
        // 27 rows an earlier run wrote are reused, not duplicated.
        const { data: byText, error: textErr } = await db
          .from("feed_interests")
          .select(INTEREST_COLS)
          .eq("text_norm", textNorm)
          .eq("kind", c.kind)
          .maybeSingle();
        if (textErr) throw new Error(textErr.message);
        existing = (byText as FeedInterest | null) ?? null;
      }

      if (existing) {
        // The user owns any row the model did not write — never resurrect or
        // rewrite a hand-added or user-removed interest.
        if (existing.source !== "derived") {
          liveIds.push(existing.id);
          continue;
        }
        const { error } = await db
          .from("feed_interests")
          .update({
            // Keep the row's existing slug: the slug is the stable identity, so
            // a re-phrased label updates this row rather than renaming it.
            slug: existing.slug ?? c.slug,
            text: c.text,
            weight: c.weight,
            queries: c.queries,
            evidence: c.evidence || null,
            active: true,
            // It came back, so it is not drifting out.
            miss_count: 0,
            updated_at: now,
          })
          .eq("id", existing.id);
        if (error) throw new Error(error.message);
        liveIds.push(existing.id);
        updated++;
      } else {
        const { data: inserted, error } = await db
          .from("feed_interests")
          .insert({
            slug: c.slug,
            text: c.text,
            kind: c.kind,
            weight: c.weight,
            queries: c.queries,
            evidence: c.evidence || null,
            source: "derived",
            active: true,
          })
          .select("id")
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (inserted?.id) liveIds.push(inserted.id);
        created++;
      }
    } catch {
      // One bad row must not abort the rest of the derivation.
    }
  }

  // Retire what this run no longer derives — but only after a SECOND consecutive
  // miss, because one absence is drift rather than a decision (see
  // MISSES_BEFORE_RETIRE). Deactivate, never delete: the row, its evidence and its
  // history stay, and getInterests() hides it.
  let retired = 0;
  let missed = 0;
  try {
    const { data: stillActive, error } = await db
      .from("feed_interests")
      .select("id,miss_count")
      .eq("source", "derived")
      .eq("active", true);
    if (error) throw new Error(error.message);
    const live = new Set(liveIds);
    const stale = (stillActive ?? [])
      .map((r) => ({
        id: r.id as string,
        missCount: Number(r.miss_count ?? 0) + 1,
      }))
      .filter((r) => !live.has(r.id));

    const expiring = stale.filter((r) => r.missCount >= MISSES_BEFORE_RETIRE).map((r) => r.id);
    const holding = stale.filter((r) => r.missCount < MISSES_BEFORE_RETIRE);

    if (expiring.length) {
      const { error: upErr } = await db
        .from("feed_interests")
        .update({ active: false, updated_at: now })
        .in("id", expiring);
      if (upErr) throw new Error(upErr.message);
      retired = expiring.length;
    }

    // Held-back rows remember the miss, one row at a time: the count is the whole
    // point of the hysteresis, so it cannot be a single bulk write of one value.
    for (const row of holding) {
      const { error: missErr } = await db
        .from("feed_interests")
        .update({ miss_count: row.missCount, updated_at: now })
        .eq("id", row.id);
      if (missErr) throw new Error(missErr.message);
      missed++;
    }
  } catch {
    // A failed retire leaves the active set as it was; it never throws.
  }

  return { interests: await getInterests(), created, updated, retired, missed };
}

// --- discovery (P2) ---------------------------------------------------------

// Env-tunable knobs. The defaults are the plan's, and each one is overridable
// so a broader verification sweep needs no code change.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Search EVERY query phrase of an interest, recording how many candidates each
// returned, then interleave them so no single phrase's results dominate the
// slice the caller takes.
function collect(
  groups: { query: string; items: SourceCandidate[] }[],
  perSourceLimit: number
): SourceCandidate[] {
  const out: SourceCandidate[] = [];
  const seen = new Set<string>();
  const max = Math.max(0, ...groups.map((g) => g.items.length));
  for (let i = 0; i < max; i++) {
    for (const g of groups) {
      const c = g.items[i];
      if (!c) continue;
      const key = c.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out.slice(0, perSourceLimit);
}

// What each search group is called in the report.
const SOURCE_LABELS: Record<"article" | "video" | "podcast" | "ainews", string> = {
  article: "articles",
  video: "youtube",
  podcast: "podcasts",
  ainews: "ai-news",
};

// Rank used by the cross-group dedupe: the highest-weighted interest's claim on
// a URL wins, so the same paper found for two interests is attributed to the
// one the user cares about more. Ties fall back to the query order.
function dedupeWeight(item: DiscoveredItem, weightById: Map<string, number>): number {
  return weightById.get(item.interest_id) ?? 0;
}

// One canonical URL, one candidate, across EVERY group. The bug this fixes: the
// same arXiv paper arrived five times (articles, YouTube, podcasts, AI news all
// query independently) and every copy was "surfaced". Within-group dedupe only
// ever caught the trivial case.
function dedupeAcrossGroups(
  batch: DiscoveredItem[],
  weightById: Map<string, number>
): DiscoveredItem[] {
  const best = new Map<string, DiscoveredItem>();
  for (const item of batch) {
    const key = item.candidate.url;
    const prior = best.get(key);
    if (!prior || dedupeWeight(item, weightById) > dedupeWeight(prior, weightById)) {
      best.set(key, item);
    }
  }
  return [...best.values()];
}

// Turn the user's interests into validated candidates.
//
// Interests are processed in weight order, starting from a day-rotated offset
// so the same handful of interests are not searched every single day. `avoid`
// interests are NEVER searched — they only ever subtract in P3. Tavily powers
// articles and YouTube under a shared call budget; podcasts (Spotify/iTunes)
// and the AI-news sources are keyless and cost nothing.
export async function discoverCandidates(
  interests: FeedInterest[],
  opts: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const maxInterests = opts.maxInterests ?? envInt("FEED_MAX_INTERESTS", 6);
  const perSourceLimit = opts.perSourceLimit ?? envInt("FEED_PER_SOURCE", 4);
  const tavilyBudget = opts.tavilyBudget ?? envInt("FEED_TAVILY_BUDGET", 12);

  const stats: DiscoveryStats = {
    tavilyCalls: 0,
    found: 0,
    validated: 0,
    rejectedValidation: 0,
    rejectedRelevance: 0,
  };
  const candidates: DiscoveredItem[] = [];
  const bySource: Record<string, Record<string, SourceTally>> = {};
  // Per-source outcomes and the one-line reports they produce. A source that
  // fails or returns nothing is a NAMED fact here, so an outage cannot hide
  // behind an empty feed.
  const sourceOutcomes: Record<string, SourceOutcome> = {};
  const sourceNotes: string[] = [];
  const noteOutcome = (name: string, count: number, reason: string | null) => {
    const prior = sourceOutcomes[name];
    sourceOutcomes[name] = {
      candidates: (prior?.candidates ?? 0) + count,
      errored: !!reason || !!prior?.errored,
      empty: count === 0,
      reason: reason ?? prior?.reason ?? null,
    };
    // ONE line per source that contributed nothing this run, naming the source,
    // the reason when there is one, and the fact that it contributed nothing.
    // A source that returns results is silent — only the failures are loud.
    if (count === 0) {
      sourceNotes.push(
        `${name}: 0 results${reason ? ` (${reason})` : ""} — contributed nothing`
      );
    }
  };
  const empty = (): DiscoveryResult => {
    // The per-source outcomes ride along IN the stats too, so a caller that only
    // keeps `stats` still learns which source failed or came back empty.
    stats.bySource = sourceOutcomes;
    return { candidates, stats, bySource, sourceOutcomes, sourceNotes };
  };

  // Only things to seek out are searched.
  const pool = interests.filter((i) => i.kind === "topic" && i.active);
  if (!pool.length) return empty();

  const weightById = new Map(pool.map((i) => [i.id, Number(i.weight) || 0]));

  // Day-of-year rotation: the same interests are not always the ones searched,
  // so a long list still gets covered across days.
  const start = new Date();
  const dayOfYear = Math.floor(
    (start.getTime() - Date.UTC(start.getUTCFullYear(), 0, 0)) / 86_400_000
  );
  const offset = pool.length ? dayOfYear % pool.length : 0;
  const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];
  const chosen = rotated.slice(0, Math.max(0, maxInterests));

  for (const interest of chosen) {
    // The queries array is what gets searched — the label is a readable name,
    // not a search string.
    const queries = (interest.queries ?? []).map((q) => q.trim()).filter(Boolean);
    if (!queries.length) continue;

    const batch: DiscoveredItem[] = [];
    const tally = (bySource[interest.text] ??= {});

    const push = (
      type: "article" | "video" | "podcast" | "ainews",
      list: SourceCandidate[]
    ) => {
      const t = (tally[SOURCE_LABELS[type]] ??= { found: 0, droppedRelevance: 0 });
      for (const candidate of list) {
        // AI-news items arrive with their own kind already set; the others are
        // labelled by which search produced them.
        const kind: ItemKind =
          type === "article" ? "article" : type === "video" ? "video" : candidate.kind;
        t.found++;
        // NO relevance gate here any more (P5). Ingest does not filter by words:
        // this feed is judged on MEANING by the model at ranking time, and a
        // keyword list cannot tell "basics" (which the user is past) from
        // "basics" (which he needs). Everything a source returns is carried
        // forward to validation, and only the VALIDATION gate below can reject
        // it. The model, not a regex, decides what fits.
        batch.push({
          candidate: { ...candidate, kind },
          kind,
          platform: candidate.platform,
          interest_id: interest.id,
          interest_text: interest.text,
        });
      }
    };

    const youtubeGroups: { query: string; items: SourceCandidate[] }[] = [];
    const articleGroups: { query: string; items: SourceCandidate[] }[] = [];
    const newsGroups: { query: string; items: SourceCandidate[] }[] = [];
    const podcastGroups: { query: string; items: SourceCandidate[] }[] = [];

    // Each source call runs through this: a throw becomes a recorded ERROR with
    // its message as the reason, and an empty return is recorded as EMPTY. Both
    // are turned into one report line by noteOutcome, so a dead source is
    // visible instead of silently contributing nothing.
    const callSource = async (
      name: string,
      run: () => Promise<SourceCandidate[]>
    ): Promise<SourceCandidate[]> => {
      try {
        const list = await run();
        noteOutcome(name, list.length, null);
        return list;
      } catch (err) {
        const reason =
          err instanceof Error && err.message ? err.message : "error";
        noteOutcome(name, 0, reason);
        return [];
      }
    };

    // Podcasts are keyless, so they always run.
    for (const query of queries) {
      const found = await callSource("podcasts", async () =>
        (await searchPodcasts(query)).candidates
      );
      podcastGroups.push({ query, items: found });
    }
    push("podcast", collect(podcastGroups, perSourceLimit));

    // Tavily-backed searches, under the shared budget.
    for (const query of queries) {
      if (stats.tavilyCalls < tavilyBudget) {
        stats.tavilyCalls++;
        articleGroups.push({
          query,
          items: await callSource("articles", () => searchArticles(query)),
        });
      }
      if (stats.tavilyCalls < tavilyBudget) {
        stats.tavilyCalls++;
        youtubeGroups.push({
          query,
          items: await callSource("youtube", () => searchYouTube(query)),
        });
      }
      if (stats.tavilyCalls >= tavilyBudget) break;
    }
    push("article", collect(articleGroups, perSourceLimit));
    push("video", collect(youtubeGroups, perSourceLimit));

    // AI news: keyless, so it is not budgeted. arXiv is skipped outright for an
    // interest with no AI/software token, so tennis and curry never ask it.
    const includeArxiv = isAiSoftwareInterest(`${interest.text} ${queries.join(" ")}`);
    for (const query of queries) {
      newsGroups.push({
        query,
        items: await callSource("ai-news", () =>
          searchAiNews(query, { includeArxiv })
        ),
      });
    }
    push("ainews", collect(newsGroups, perSourceLimit));

    // Dedupe across every group before validating, so the same URL is never
    // validated — or surfaced — twice.
    const unique = dedupeAcrossGroups(batch, weightById);

    // Individually validate every candidate before it counts. Search results
    // are not evidence; the validator is.
    for (const item of unique) {
      stats.found++;
      const ok = await validate(item.candidate);
      if (ok) {
        stats.validated++;
        candidates.push(item);
      } else {
        stats.rejectedValidation++;
      }
    }
  }

  // One link, one row — across interests too. The per-interest dedupe above only
  // guarantees uniqueness WITHIN one interest, so the same arXiv paper matched by
  // three different interests surfaced three times and was validated three times.
  // First occurrence wins, and interests are processed in weight order, so the
  // copy that survives belongs to the strongest fit.
  const seenUrls = new Set<string>();
  const uniqueCandidates = candidates.filter((item) => {
    const key = canonicalUrl(item.candidate.url).toLowerCase();
    if (!key || seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });

  // Say out loud what each failing or empty source did. ONE line per source,
  // logged here rather than swallowed, so a silent 0 is reported as a fact.
  for (const note of sourceNotes) console.log(`  [feed] ${note}`);

  return { ...empty(), candidates: uniqueCandidates };
}

// Persist validated candidates, deduped within the batch and against rows that
// already exist. Dedupe is done by reading the url_norm values for this batch's
// canonical URLs and inserting only the unseen ones — url_norm is a generated
// column, so upsert would not interact with it cleanly.
//
// Rows go in ONE AT A TIME: a chunked insert aborts the whole batch on a single
// unique-constraint conflict, and that is half of why a repeat run used to
// insert 2 rows instead of 0. A conflict is a `skippedConflict`; any other error
// is logged and skipped. The two skip counts are reported separately so a future
// regression is diagnosable rather than merely visible.
export async function saveCandidates(
  items: DiscoveredItem[],
  interestIdById: Map<string, string>
): Promise<{
  inserted: number;
  insertedUrls: string[];
  skipped: number;
  skippedPrefiltered: number;
  skippedConflict: number;
}> {
  const db = createServiceClient();

  // The comparison key must be EXACTLY what the database's generated column
  // holds — url_norm is lower(btrim(url)) — while the stored url keeps the case
  // that can genuinely matter inside a path (YouTube IDs are case-sensitive).
  // Comparing the canonical URL unchanged against url_norm silently missed every
  // mixed-case URL: it fell through the pre-filter, then collided with the row
  // that was already there and was counted as a unique conflict. That was the
  // real cause of "a repeat run inserted 2 rows".
  const normKey = (url: string): string => canonicalUrl(url).toLowerCase();

  // In-batch dedupe on that same key first.
  const seen = new Set<string>();
  const unique: DiscoveredItem[] = [];
  for (const item of items) {
    const url = canonicalUrl(item.candidate.url);
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    item.candidate.url = url;
    unique.push(item);
  }

  // Then drop the ones the table already holds, comparing on url_norm.
  const urls = unique.map((i) => normKey(i.candidate.url));
  let existing = new Set<string>();
  try {
    const { data, error } = await db
      .from("feed_items")
      .select("url_norm")
      .in("url_norm", urls);
    if (error) throw new Error(error.message);
    existing = new Set((data ?? []).map((r) => r.url_norm as string));
  } catch {
    // A failed lookup must not block the insert; the unique index is the
    // backstop that still prevents a duplicate.
  }

  const rows = unique
    .filter((i) => !existing.has(normKey(i.candidate.url)))
    .map((i) => ({
      url: i.candidate.url,
      kind: i.kind,
      platform: i.platform,
      title: i.candidate.title || i.candidate.url,
      summary: i.candidate.summary,
      creator: i.candidate.creator,
      published_at: i.candidate.published_at,
      duration_seconds: i.candidate.duration_seconds,
      image_url: i.candidate.image_url,
      validated: true,
      status: "new",
      matched_interest_id: interestIdById.get(i.interest_id) ?? null,
    }));

  const skippedPrefiltered = items.length - rows.length;
  let inserted = 0;
  let skippedConflict = 0;
  // Named, not merely counted: a repeat run must leave this empty, and if a live
  // source genuinely returns something new it should be visible as a URL rather
  // than as an unexplained non-zero count.
  const insertedUrls: string[] = [];

  for (const row of rows) {
    try {
      const { error } = await db.from("feed_items").insert(row);
      if (error) {
        // A unique-constraint violation is the expected, harmless case: another
        // run (or another group of this one) already stored this URL.
        if (/duplicate key|unique constraint|23505/i.test(error.message)) {
          skippedConflict++;
          continue;
        }
        console.log(`  [feed] insert failed — ${row.url}: ${error.message}`);
        skippedConflict++;
        continue;
      }
      inserted++;
      insertedUrls.push(row.url);
    } catch (err) {
      console.log(`  [feed] insert failed — ${row.url}: ${(err as Error).message}`);
      skippedConflict++;
    }
  }

  return {
    inserted,
    insertedUrls,
    skipped: skippedPrefiltered + skippedConflict,
    skippedPrefiltered,
    skippedConflict,
  };
}

// Stored items, newest first, for inspection without a UI.
export async function getStoredItems(limit = 100): Promise<FeedItem[]> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("feed_items")
    .select(ITEM_COLS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as FeedItem[];
}

// Clear the found links so a run starts from a known state. `feed_items` ONLY:
// the derived interests are the user's fit profile and are never touched here.
// Used once to drop the pre-relevance-gate noise; the same run repopulates it.
export async function resetStoredItems(): Promise<number> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("feed_items")
    .delete()
    .not("id", "is", null)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}

// --- ranking (P3a) ----------------------------------------------------------

// P2 leaves a pool of individually valid links and no judgement. This section
// adds the judgement: a model that scores each candidate WITH a reason that
// names something of the user's, a diversity rule that is a first-class
// constraint rather than a tiebreaker, and a time budget.
//
// Why diversity is a rule and not a tiebreaker: the live P2 output returned
// eight links that were all budget vegan meal prep (`$35. One Week. 21 Vegan
// Meals`, `$7/Day Budget Vegan Meal Prep`, plus four articles saying the same
// thing). Every one was valid and on-topic; a six-item feed filled with them
// would be useless. A score alone cannot fix that — the selection has to refuse
// the third item of the same area.

export interface RankedItem {
  item: FeedItem;
  score: number;
  reason: string;
  /** The active goal the item was attributed to. Non-null for anything surfaced. */
  goal: string;
  /** The id of that goal, written to feed_items.matched_goal_id. */
  goalId: string | null;
  /**
   * Kept so the existing UI chip keeps working. P5's rubric is goals, not
   * growth/fun, so this is now derived from whether the item serves a goal.
   */
  bucket: "growth" | "fun";
}

/** One of the user's active goals, with the milestones still open under it. */
export interface RankGoal {
  id: string;
  title: string;
  description: string | null;
  openMilestones: string[];
}

export interface Shortlist {
  items: RankedItem[];
  minutes: number;
  budgetMinutes: number;
  droppedNoReason: number;
  /** Candidates that survived the mechanical drops and were offered to the model. */
  considered: number;
  /** Candidates with a valid reason AND a score at or above the minimum. */
  scored: number;
  /**
   * Always 0. The time budget informs ORDERING and is reported, but it never
   * truncates the list — a hard stop let one 39-minute podcast starve a real run
   * down to a single item while 14 candidates vanished uncounted. This field
   * exists so a regression is caught by a test rather than by noticing.
   */
  droppedBudget: number;
  /** The model left the candidate out entirely (an ignored instruction). */
  droppedOmitted: number;
  /** The model returned an entry but with a blank reason (a declined justification). */
  droppedBlankReason: number;
  /** The relaxed per-interest limit actually used, or null for a normal day. */
  relaxedTo: number | null;
  droppedLowScore: number;
  droppedDiversity: number;
  droppedFeedback: number;
  /** Cheap pre-model drops: shortform social only, now that the listicle regex is gone. */
  droppedMechanical: number;
}

// How many candidates the ranker considers in one run. Bounded because one call
// carries the whole list, and the pool is no longer trimmed by a relevance gate
// at ingest (P5): the cap lives HERE, on the model call, rather than discarding
// candidates on the way in. Env-tunable so a broader sweep needs no code change.
const DEFAULT_RANK_LIMIT = 40;

function rankLimit(): number {
  return envInt("FEED_RANK_LIMIT", DEFAULT_RANK_LIMIT);
}

// The score is an integer 1-5 against the user's GOALS (P5), not a 0-100 against
// interest areas. 3 is the floor: below it the item does not move him toward a
// goal. A five-point scale with a meaningful floor, not a percentage.
const MIN_SCORE = 3;
const MAX_SCORE = 5;

// Per-interest allowances. The first pass takes at most 2 items of any one
// interest; the fallbacks relax that visibly (to 3, then 4) so a thin day can
// still fill the feed, and so the relaxation is never invisible in the report.
const INTEREST_LIMIT = 2;
const INTEREST_LIMITS_RELAXED = [3, 4];

// A near-duplicate title, by the same measure feed-test.ts uses on labels:
// Jaccard overlap of lowercased non-stopword tokens of >= 4 characters. Two
// budget-meal-prep videos with re-worded titles are the same item twice.
const TITLE_OVERLAP = 0.5;

const TITLE_STOPWORDS = new Set([
  "with", "from", "that", "this", "your", "about", "into", "over", "more",
  "best", "for", "and", "the",
]);

function titleTokens(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w))
  );
}

function titleOverlap(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

// Per-kind length ESTIMATE, used only when the source reported no duration.
// It is a guess and is never presented as an exact figure.
const ESTIMATED_MINUTES: Record<ItemKind, number> = {
  article: 6,
  post: 3,
  video: 12,
  podcast: 30,
};

// The minutes an item is assumed to cost. A real duration when the source gave
// one, otherwise the per-kind estimate above.
export function itemMinutes(item: FeedItem): number {
  if (item.duration_seconds && item.duration_seconds > 0) {
    return item.duration_seconds / 60;
  }
  return ESTIMATED_MINUTES[item.kind] ?? 6;
}

// The rubric, verbatim in spirit from the plan. This is a GOAL feed, not a news
// feed: the question for every candidate is "which of this person's active goals
// does it move him toward?", and the answer is an integer 1-5 with a reason that
// names the goal. The calibration below is the user's own, written in because a
// keyword list cannot tell "basics" he is past from "basics" he needs.
const RANK_SYSTEM = `You rank a specific person's candidate reading, watching and listening for one day. This is a GOAL feed, not a news feed: for every candidate the question is "which of this person's active goals does it move him toward?". You are honest and severe. He wants to get SMARTER, not to be entertained. A high score is a promise, and a vague reason is worse than no item at all.

Return ONLY JSON:
{"ranked":[{"index":3,"score":4,"goal":"Move toward a leadership role","reason":"design patterns for agents, past the basics he already has"}]}

Score every candidate with an INTEGER 1-5:
5 = directly and substantially advances one of the goals below, at his level.
4 = clearly advances a goal, useful and non-obvious.
3 = relevant to a goal; worth surfacing.
2 = only weakly related, or below his level, or content that does not make him smarter.
1 = moves him toward none of his goals, or is gear/product/marketing.

CALIBRATION (his own, follow it literally):
- He is ADVANCED at AI and vibecoding. Basics he already has score LOW: "Basics of Vibe Coding Explained" is a 2. Content at HIS level scores HIGH: limits, design patterns, and agents.
- Product, gear, buy and top-N content scores LOW regardless of topic, because it does not make him smarter. "Best 6 Tennisballmaschinen" is a 1.
- Tennis TECHNIQUE and TRAINING are relevant (Play tennis regularly); equipment lists and ball-machine reviews are not.
- Relevant: leadership and visibility; health and cooking WITHOUT product lists; reading about leadership, relationships and psyche.
- NEWS CLAUSE (AI and agent engineering). Substantive AI and agent-engineering content that actually TEACHES him something at his level advances the goal "Owning the AI Initiative at Work" and MUST score 3 or higher, with that goal named in "goal" and referenced in the reason. His level means: agent architecture and how a system is put together; design patterns for agents and LLM applications; the LIMITS of the technology and when it fails; evaluation, evals and how you know it works; tooling and the real mechanics of building; and post-mortems or case studies of how a real initiative was made to work inside a company. Score 2 the things that teach him nothing: funding rounds, model-release announcements, benchmark marketing, hype and industry gossip. Concretely — 4: "How we redesigned our agent's tool-calling to cut retries by 60%, with the eval harness we built to prove it" (agent architecture + evaluation, owned inside a real company). 2: "OpenAI raises $40B at a $300B valuation" (a funding round; it teaches him nothing about owning the initiative).
- Score 2 or lower when an item moves him toward NONE of his goals, however well made it is.
- He reads GERMAN and ENGLISH ONLY. A French or Spanish item is a 1, however good it is.

"goal": the EXACT title of ONE of the active goals listed below that the item serves, copied verbatim. It is required — a candidate you cannot attribute to a goal is not for him.
"reason": AT MOST 12 WORDS, ONE sentence, and it MUST name the goal (or the milestone) it serves — "design patterns for agents, past the basics he already has", NOT "great content". A generic reason is worse than no item, because it teaches him to stop reading them.
Omit any candidate you cannot justify. An omitted candidate, a candidate with no goal, or one with an empty reason is dropped — it is never surfaced behind a vague label.
Every index you return MUST be an index from the numbered candidate list, and an index must appear at most once.`;

// The goals and their OPEN milestones, as the model reads them. This IS the
// rubric: the interests are only discovery sources now, so the goals are what a
// reason has to tie back to and what matched_goal_id must point at.
function goalsBlock(goals: RankGoal[]): string {
  if (!goals.length) return "## Active goals\n(none recorded)";
  const lines = goals.map((g) => {
    const desc = (g.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const head = `- ${g.title}${desc ? ` — ${desc}` : ""}`;
    const steps = g.openMilestones.length
      ? `\n    open steps: ${g.openMilestones.join("; ")}`
      : "";
    return head + steps;
  });
  return `## Active goals (the rubric — attribute every candidate to one of these)\n${lines.join("\n")}`;
}

// The candidate list as the model reads it: numbered so the response can refer
// to it by index, with the interest it was found for (which is the thing a
// reason has to tie back to) and the shape of the item.
function candidateBlock(items: FeedItem[], interestText: Map<string, string>): string {
  return items
    .map((item, index) => {
      const interest = item.matched_interest_id
        ? interestText.get(item.matched_interest_id)
        : null;
      const minutes = Math.round(itemMinutes(item));
      const creator = item.creator ? ` · by ${item.creator}` : "";
      const summary = (item.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return (
        `[${index}] ${item.title} · ${item.kind} · ${item.platform}${creator} · ~${minutes} min\n` +
        `    interest: ${interest ?? "(unknown)"}\n` +
        (summary ? `    summary: ${summary}\n` : "")
      );
    })
    .join("");
}

// What the user has already answered, so the model can avoid recommending the
// same thing again — and, just as importantly, so a "not for me" is remembered.
async function feedbackBlock(): Promise<string> {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("feed_feedback")
      .select("item_id,signal,at")
      .order("at", { ascending: false })
      .limit(40);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { item_id: string | null; signal: string }[];
    if (!rows.length) return "";
    const ids = [...new Set(rows.map((r) => r.item_id).filter(Boolean))] as string[];
    const titles = new Map<string, string>();
    if (ids.length) {
      const { data: items } = await db.from("feed_items").select("id,title").in("id", ids);
      for (const r of (items ?? []) as { id: string; title: string }[]) {
        titles.set(r.id, r.title);
      }
    }
    const lines = rows.map((r) => {
      const label = r.signal === "not_for_me" ? "not for me" : r.signal;
      return `- [${label}] ${r.item_id ? titles.get(r.item_id) ?? r.item_id : "(unknown)"}`;
    });
    return `## The user's history\n${lines.join("\n")}`;
  } catch {
    // No history is a valid state: the model ranks on the rubric alone.
    return "";
  }
}

interface RawRanking {
  index: number;
  score: number;
  reason: string;
  goal: string;
}

function parseRanking(raw: string): RawRanking[] {
  let parsed: { ranked?: { index?: unknown; score?: unknown; reason?: unknown; goal?: unknown }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const seen = new Set<number>();
  const out: RawRanking[] = [];
  for (const r of parsed.ranked ?? []) {
    const index = Number(r.index);
    if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
    const n = Number(r.score);
    if (!Number.isFinite(n)) continue;
    // Models like to hand back "because you are preparing the salary
    // conversation". The reason is a clause that names the user's own thing;
    // the "because" is the UI's to add, so storing it here would render it
    // twice.
    const reason = String(r.reason ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^because\s+/i, "");
    const goal = String(r.goal ?? "").replace(/\s+/g, " ").trim();
    seen.add(index);
    out.push({
      index,
      // An integer 1-5: rounded and clamped, so a model that returns 0 or 120
      // cannot leak a foreign scale into the table.
      score: Math.max(1, Math.min(MAX_SCORE, Math.round(n))),
      reason,
      goal,
    });
  }
  return out;
}

// The diversity walk over one relaxation level. Best-first, and an item is taken
// only when its interest is below the limit AND its title is not a near-duplicate
// of something already chosen. Rejections at this stage are droppedDiversity.
function selectDiverse(
  ranked: RankedItem[],
  perInterestLimit: number,
  cap: number
): { chosen: RankedItem[]; dropped: number } {
  const chosen: RankedItem[] = [];
  const perInterest = new Map<string, number>();
  let dropped = 0;

  for (const r of ranked) {
    if (chosen.length >= cap) break;

    const interestId = r.item.matched_interest_id ?? "(none)";
    if ((perInterest.get(interestId) ?? 0) >= perInterestLimit) {
      dropped++;
      continue;
    }
    if (chosen.some((c) => titleOverlap(c.item.title, r.item.title) >= TITLE_OVERLAP)) {
      dropped++;
      continue;
    }

    // NO budget check here, deliberately. The plan says a "visible time budget,
    // not a lock — nothing is blocked, the point is awareness", and this used to
    // be a hard stop: one 39-minute podcast filled the budget and silently starved
    // a real run down to a single item, with 14 candidates dropped and not even
    // counted. Length now only decides ORDER among similarly-scored items, via the
    // band sort in buildShortlist. `droppedBudget` in the result must stay 0.
    chosen.push(r);
    perInterest.set(interestId, (perInterest.get(interestId) ?? 0) + 1);
  }

  return { chosen, dropped };
}

// A candidate the model scored. `score` is the integer 1-5 and `goal`/`goalId`
// are the active goal it was attributed to (goalId null when the model named no
// goal, or named one that is not the user's). P5's whole rubric lives here.
export interface ScoredCandidate {
  item: FeedItem;
  score: number;
  reason: string;
  goal: string;
  goalId: string | null;
}

export interface ScoreResult {
  /** Every candidate the model returned with a valid integer score and a reason. */
  scored: ScoredCandidate[];
  /** How many candidates were offered to the model (after the shortform drop). */
  considered: number;
  droppedBlankReason: number;
  droppedOmitted: number;
  /** Returned with a score and reason but attributed to no active goal. */
  droppedNoGoal: number;
  droppedLowScore: number;
}

export interface ScoreOptions {
  /** id -> interest label, so the candidate block can say what it was found for. */
  interestText?: Map<string, string>;
  /** The user's feedback history, so the model can avoid repeat recommendations. */
  history?: string;
  /** Overridable for a test that wants the exact same path without a DB. */
  goals?: RankGoal[];
  /** Overridable for a test that wants to score arbitrary candidates. */
  candidates?: FeedItem[];
}

// Score candidates against the user's ACTIVE GOALS with ONE model call. This is
// the whole judgement of the feed, factored out so buildShortlist and the rank
// test push candidates through the IDENTICAL code path rather than each having
// its own copy. It does NOT apply the MIN_SCORE threshold or the cap: it returns
// every candidate the model gave an integer score and a reason to, so the caller
// decides what "surfaced" means. A failed call yields an empty result, never a
// throw.
export async function scoreCandidates(
  candidates: FeedItem[],
  goals: RankGoal[],
  opts: ScoreOptions = {}
): Promise<ScoreResult> {
  const empty: ScoreResult = {
    scored: [],
    considered: candidates.length,
    droppedBlankReason: 0,
    droppedOmitted: 0,
    droppedNoGoal: 0,
    droppedLowScore: 0,
  };
  if (!candidates.length) return empty;

  const interestText = opts.interestText ?? new Map<string, string>();
  const history = opts.history ?? "";

  // Numbered so the response can refer to a candidate by index. The index is the
  // ONLY link back, so it is rebuilt here rather than trusted from the model.
  const byIndex = new Map<number, FeedItem>();
  candidates.forEach((item, index) => byIndex.set(index, item));

  let ranked: RawRanking[] = [];
  try {
    const res = await llm().chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RANK_SYSTEM },
        {
          role: "user",
          content:
            `${goalsBlock(goals)}\n\n` +
            `${candidateBlock(candidates, interestText)}\n` +
            `${history ? `\n${history}\n` : ""}\n` +
            `Rank the candidates now (JSON).`,
        },
      ],
    });
    ranked = parseRanking((res.choices[0].message.content ?? "").trim());
  } catch {
    // A failed call yields nothing scored, never a thrown error.
    ranked = [];
  }

  // The goal title the model named, mapped to the user's own id. Matching is
  // case-insensitive on the trimmed title so a small spelling difference does
  // not lose the attribution.
  const goalByTitle = new Map<string, RankGoal>();
  for (const g of goals) goalByTitle.set(g.title.trim().toLowerCase(), g);

  let droppedBlankReason = 0;
  let droppedNoGoal = 0;
  const scored: ScoredCandidate[] = [];
  for (const r of ranked) {
    const item = byIndex.get(r.index);
    if (!item) continue;
    // An item returned with a blank reason is dropped — never surfaced behind a
    // vague label.
    if (!r.reason || !r.reason.trim()) {
      droppedBlankReason++;
      continue;
    }
    const match = r.goal ? goalByTitle.get(r.goal.trim().toLowerCase()) : undefined;
    if (!match) droppedNoGoal++;
    scored.push({
      item,
      score: r.score,
      reason: r.reason,
      goal: match ? match.title : r.goal,
      goalId: match ? match.id : null,
    });
  }

  // Candidates the model left out entirely, counted SEPARATELY from a blank
  // reason because the two mean different things: a blank reason is the model
  // declining to justify an item, an omission is the model ignoring an explicit
  // instruction. Reporting them as a single number is what hid a real run
  // dropping 19 candidates and producing a one-item feed without saying which
  // had happened.
  const returned = new Set(ranked.map((r) => r.index));
  let droppedOmitted = 0;
  for (const [index] of byIndex) {
    if (!returned.has(index)) droppedOmitted++;
  }
  if (byIndex.size > 0 && droppedOmitted > byIndex.size / 2) {
    console.log(
      `  [feed] the ranking omitted ${droppedOmitted} of ${byIndex.size} candidates — the ` +
        `prompt requires one entry per candidate, so this is the instruction being ignored, ` +
        `not a filter rejecting them.`
    );
  }

  return {
    scored,
    considered: candidates.length,
    droppedBlankReason,
    droppedOmitted,
    droppedNoGoal,
    droppedLowScore: 0,
  };
}

// Load the active goals with their OPEN milestones — the rubric the model scores
// against. Best-effort: a failed read yields an empty rubric (the model then
// cannot attribute anything, which shows up as an empty shortlist rather than a
// wrong one).
export async function loadRankGoals(): Promise<RankGoal[]> {
  try {
    const goals = (await getGoals("active")).filter((g) => g.status === "active");
    const out: RankGoal[] = goals.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      openMilestones: [],
    }));
    if (out.length) {
      const byId = new Map(out.map((g) => [g.id, g]));
      const milestones = await getMilestones();
      for (const m of milestones) {
        if (m.done) continue;
        byId.get(m.goal_id)?.openMilestones.push(m.title);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// The day's shortlist: load, drop cheaply, ask the model once, select with the
// diversity rule and the time budget, then stamp what was chosen.
//
// Best-effort throughout in the style of the rest of this module: a failed model
// call yields an empty shortlist rather than a thrown error that blanks a page.
export async function buildShortlist(day?: string): Promise<Shortlist> {
  const surfacedDay = day ?? logicalDay();
  const db = createServiceClient();

  // Preferences: how many items and how many minutes a day. Created on demand so
  // a missing row is never an error — the defaults are the plan's.
  let dailyCount = 6;
  let dailyMinutes = 45;
  try {
    const { data, error } = await db
      .from("feed_prefs")
      .select("daily_count,daily_minutes")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      dailyCount = Number(data.daily_count ?? dailyCount) || dailyCount;
      dailyMinutes = Number(data.daily_minutes ?? dailyMinutes) || dailyMinutes;
    }
  } catch {
    // Keep the defaults.
  }

  // The interests, so the candidate block can name what each item was found for.
  const interestText = new Map<string, string>();
  try {
    const { data } = await db.from("feed_interests").select("id,text");
    for (const r of (data ?? []) as { id: string; text: string }[]) {
      interestText.set(r.id, r.text);
    }
  } catch {
    // Without labels the prompt loses context but still ranks.
  }

  // 1. Candidates: new and validated, newest first. saved/hidden/done are
  // excluded by the status filter, which is the same "already answered" set.
  // FEED_RANK_LIMIT is the only bound on how many are considered — the ingest no
  // longer trims the pool by relevance (P5), so the cap lives here, on the one
  // model call, where it actually bounds cost.
  let candidates: FeedItem[] = [];
  try {
    const { data, error } = await db
      .from("feed_items")
      .select(ITEM_COLS)
      .eq("status", "new")
      .eq("validated", true)
      .order("created_at", { ascending: false })
      .limit(rankLimit());
    if (error) throw new Error(error.message);
    candidates = (data ?? []) as FeedItem[];
  } catch {
    return {
      items: [],
      minutes: 0,
      budgetMinutes: dailyMinutes,
      droppedNoReason: 0,
      considered: 0,
      scored: 0,
      droppedBudget: 0,
      droppedOmitted: 0,
      droppedBlankReason: 0,
      relaxedTo: null,
      droppedLowScore: 0,
      droppedDiversity: 0,
      droppedFeedback: 0,
      droppedMechanical: 0,
    };
  }

  // Anything the user has already answered is never surfaced again — including
  // an item whose status update lagged its feedback row.
  let answered = new Set<string>();
  try {
    const { data, error } = await db.from("feed_feedback").select("item_id");
    if (error) throw new Error(error.message);
    answered = new Set(
      ((data ?? []) as { item_id: string | null }[])
        .map((r) => r.item_id)
        .filter(Boolean) as string[]
    );
  } catch {
    // No feedback table read: the status filter above is still the main guard.
  }
  const kept: FeedItem[] = [];
  let droppedFeedback = 0;
  for (const item of candidates) {
    if (answered.has(item.id) || item.status !== "new") {
      droppedFeedback++;
      continue;
    }
    kept.push(item);
  }

  // 2. The one cheap drop left: shortform social. A TikTok URL is a FORMAT
  // decision, not a meaning judgement, so it never reaches the model. The
  // listicle regex is gone (P5) — "top-N content scores low" is now a rubric
  // line, because a keyword list cannot tell "basics" he is past from "basics"
  // he needs.
  let droppedMechanical = 0;
  const mechanical: FeedItem[] = [];
  for (const item of kept) {
    if (isShortformSocial(item.url)) {
      droppedMechanical++;
      continue;
    }
    mechanical.push(item);
  }

  if (!mechanical.length) {
    return {
      items: [],
      minutes: 0,
      budgetMinutes: dailyMinutes,
      droppedNoReason: 0,
      considered: 0,
      scored: 0,
      droppedBudget: 0,
      droppedOmitted: 0,
      droppedBlankReason: 0,
      relaxedTo: null,
      droppedLowScore: 0,
      droppedDiversity: 0,
      droppedFeedback,
      droppedMechanical,
    };
  }

  // 3. ONE model call, JSON mode, over the numbered candidates plus the rubric.
  //    The rubric is the user's ACTIVE GOALS (with their open milestones), not
  //    the interest areas: the interests only decided where to look.
  const [history, goals] = await Promise.all([feedbackBlock(), loadRankGoals()]);
  const result = await scoreCandidates(mechanical, goals, { interestText, history });

  // Every caller-facing number comes straight from scoreCandidates, so the test
  // that drives it directly reports the same thing the feed does.
  const droppedBlankReason = result.droppedBlankReason;
  const droppedOmitted = result.droppedOmitted;
  const droppedNoReason = droppedBlankReason + droppedOmitted;

  // 4. THE THRESHOLD — the first and most important cut, secondary to nothing.
  //    Anything below MIN_SCORE (or attributed to no goal) is parked: no
  //    surfaced_day, so it ages out, and no reason.
  let droppedLowScore = 0;
  const scored: RankedItem[] = [];
  for (const s of result.scored) {
    if (s.score < MIN_SCORE) {
      droppedLowScore++;
      continue;
    }
    // An item with no goal is not surfaced: "which goal does this serve?" is the
    // whole question, and an answer of "none" is a no.
    if (!s.goalId) continue;
    scored.push({
      item: s.item,
      score: s.score,
      reason: s.reason,
      goal: s.goal,
      goalId: s.goalId,
      // P5's rubric is goals, not growth/fun. Keep the field honest: an item that
      // cleared the bar serves a goal, which is what "growth" always meant.
      bucket: "growth",
    });
  }

  // Best first, but within a score band prefer the shorter item. With a 1-5
  // scale the band is a single point, so a 5 beats a 4 whatever its length while
  // two 5s compete on the shorter one. This is how the day lands near its time
  // budget WITHOUT the budget ever blocking an item — length is absorbed into
  // ordering instead.
  const SCORE_BAND = 1;
  scored.sort(
    (a, b) =>
      Math.floor(b.score / SCORE_BAND) - Math.floor(a.score / SCORE_BAND) ||
      itemMinutes(a.item) - itemMinutes(b.item)
  );

  // 4. Diversity selection. The first pass holds every interest to 2 items; only
  // when the list would otherwise be short is the limit relaxed, visibly, to 3
  // and then 4 — and it stops there.
  // Secondary to the threshold: the cap is how many of the items that CLEARED
  // the bar may be shown, never a way to pad a short day.
  const cap = Math.min(dailyCount, scored.length);
  let chosen: RankedItem[] = [];
  let droppedDiversity = 0;
  const first = selectDiverse(scored, INTEREST_LIMIT, cap);
  chosen = first.chosen;
  droppedDiversity = first.dropped;

  const relaxationUsed: number[] = [];
  if (chosen.length < cap) {
    for (const limit of INTEREST_LIMITS_RELAXED) {
      if (chosen.length >= cap) break;
      const again = selectDiverse(scored, limit, cap);
      // The relaxed pass may only ADD: an item already chosen stays chosen.
      const have = new Set(chosen.map((c) => c.item.id));
      let added = 0;
      for (const r of again.chosen) {
        if (have.has(r.item.id)) continue;
        have.add(r.item.id);
        chosen.push(r);
        added++;
      }
      // Only a pass that actually put something in counts as a relaxation.
      // Running the relaxed walk, finding it adds nothing, and then reporting a
      // relaxed day would be a lie about how the list was built.
      if (added) relaxationUsed.push(limit);
    }
  }

  // 5. The budget total, reported so nothing is hand-waved.
  const minutes = chosen.reduce((sum, r) => sum + itemMinutes(r.item), 0);

  // 6. Stamp what was chosen. status stays 'new': the item is waiting, not
  // answered. A row that was not chosen keeps its null score/reason and stays
  // eligible for a later day — nothing is discarded.
  const stamp = new Date().toISOString();
  for (const r of chosen) {
    try {
      const { error } = await db
        .from("feed_items")
        .update({
          surfaced_day: surfacedDay,
          score: r.score,
          reason: r.reason,
          bucket: r.bucket,
          matched_goal_id: r.goalId,
          updated_at: stamp,
        })
        .eq("id", r.item.id);
      if (error) throw new Error(error.message);
      r.item.surfaced_day = surfacedDay;
    } catch {
      // One unstamped row must not abort the shortlist it is part of.
    }
  }

  if (relaxationUsed.length) {
    console.log(
      `  [feed] short list: relaxed the per-interest limit to ${relaxationUsed.join(
        ", then "
      )} to fill (a normal day holds every interest to ${INTEREST_LIMIT}).`
    );
  }

  return {
    items: chosen,
    minutes,
    budgetMinutes: dailyMinutes,
    droppedNoReason,
    considered: mechanical.length,
    scored: scored.length,
    droppedBudget: 0,
    droppedOmitted,
    droppedBlankReason,
    relaxedTo: relaxationUsed.length ? relaxationUsed[relaxationUsed.length - 1] : null,
    droppedLowScore,
    droppedDiversity,
    droppedFeedback,
    droppedMechanical,
  };
}
