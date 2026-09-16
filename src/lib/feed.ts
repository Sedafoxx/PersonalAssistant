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
import {
  validate,
  searchArticles,
  searchYouTube,
  searchPodcasts,
  searchAiNews,
  canonicalUrl,
  isRelevant,
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

export interface DiscoveryResult {
  candidates: DiscoveredItem[];
  stats: DiscoveryStats;
  // Per interest text, then per source type (`articles`, `youtube`,
  // `podcasts`, `ai-news`).
  bySource: Record<string, Record<string, SourceTally>>;
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

  // Only things to seek out are searched.
  const pool = interests.filter((i) => i.kind === "topic" && i.active);
  if (!pool.length) return { candidates, stats, bySource };

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
        // The relevance gate: a link that exists but does not fit is noise, and
        // the point of the feed is fit. Counted separately from a dead link.
        if (!keep(candidate, type)) {
          t.droppedRelevance++;
          stats.rejectedRelevance++;
          continue;
        }
        batch.push({
          candidate: { ...candidate, kind },
          kind,
          platform: candidate.platform,
          interest_id: interest.id,
          interest_text: interest.text,
        });
      }
    };

    // The gate itself, per source. Spotify is checked on title and show name —
    // which is what a Spotify episode candidate carries, creator being the show.
    const keep = (
      candidate: SourceCandidate,
      type: "article" | "video" | "podcast" | "ainews"
    ): boolean => {
      // Podcasts and arXiv are held to the strict standard: the match must be in
      // the TITLE. Both are loose sources — Apple matches any word in an episode
      // blurb, and arXiv's subject filter (cs.AI/cs.LG/cs.CL/cs.SE) narrows the
      // field but not the topic, so "PhysStream: Streaming Physics-Grounded Video
      // Generation" and "Vanilla Scotogenic Model at the future Muon Collider"
      // both arrived for an interest about owning an AI initiative. `titleOnly` is
      // passed explicitly rather than inferred from candidate.kind, because at gate
      // time the raw candidate has not been labelled with its kind yet.
      // Shortform social video never counts as an article: escaping that is the
      // entire point of this feed.
      if (type === "article" && isShortformSocial(candidate.url)) return false;

      const titleOnly = type === "podcast" || candidate.platform === "arxiv";
      // Podcasts are held to the strictest standard of all: the TITLE must contain
      // a word from the interest LABEL, not merely two words from a search phrase.
      // The episode that defeated the looser rule matched "how to read more books
      // every week" on the words "every" and "week".
      const requireLabel = type === "podcast";
      return queries.some((q) =>
        isRelevant(candidate, q, interest.text, titleOnly, requireLabel)
      );
    };

    const youtubeGroups: { query: string; items: SourceCandidate[] }[] = [];
    const articleGroups: { query: string; items: SourceCandidate[] }[] = [];
    const newsGroups: { query: string; items: SourceCandidate[] }[] = [];
    const podcastGroups: { query: string; items: SourceCandidate[] }[] = [];

    // Podcasts are keyless, so they always run.
    for (const query of queries) {
      const { candidates: found } = await searchPodcasts(query);
      podcastGroups.push({ query, items: found });
    }
    push("podcast", collect(podcastGroups, perSourceLimit));

    // Tavily-backed searches, under the shared budget.
    for (const query of queries) {
      if (stats.tavilyCalls < tavilyBudget) {
        stats.tavilyCalls++;
        articleGroups.push({ query, items: await searchArticles(query) });
      }
      if (stats.tavilyCalls < tavilyBudget) {
        stats.tavilyCalls++;
        youtubeGroups.push({ query, items: await searchYouTube(query) });
      }
      if (stats.tavilyCalls >= tavilyBudget) break;
    }
    push("article", collect(articleGroups, perSourceLimit));
    push("video", collect(youtubeGroups, perSourceLimit));

    // AI news: keyless, so it is not budgeted. arXiv is skipped outright for an
    // interest with no AI/software token, so tennis and curry never ask it.
    const includeArxiv = isAiSoftwareInterest(`${interest.text} ${queries.join(" ")}`);
    for (const query of queries) {
      newsGroups.push({ query, items: await searchAiNews(query, { includeArxiv }) });
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

  return { candidates: uniqueCandidates, stats, bySource };
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
