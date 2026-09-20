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
import { fetchPageText } from "./web";
import { spotifyEpisodeDescriptionsViaSearch, spotifyEpisodeId } from "./feed-sources";
import { getTopics, getActiveFacts, formatForContext } from "./memory";
import { getCategories, getJournalEntries } from "./journal";
import { getItems } from "./db";
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
  isNewsPlatform,
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
  // Popularity (migration 0030). NULL = unknown, never zero.
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  channel_name?: string | null;
  channel_subs?: number | null;
  validated: boolean;
  matched_interest_id: string | null;
  status: string;
  surfaced_day: string | null;
  created_at: string;
  updated_at: string;
}

const ITEM_COLS =
  "id,url,kind,platform,title,summary,creator,published_at,duration_seconds,image_url,validated,matched_interest_id,status,surfaced_day,view_count,like_count,comment_count,channel_name,channel_subs,created_at,updated_at";

/**
 * Keep a page from opening with six of the same thing.
 *
 * Scoring sorts by relevance only, so the highest-scoring run of the whole store can
 * easily be one kind — the first live page was six podcasts in a row, which reads as
 * a narrower feed than the user asked for. The day's shortlist already has a
 * diversity rule; this is the same idea applied to a page: at most `maxRun` of a
 * kind in a row, then the best item of another kind. Order WITHIN a page only, so
 * paging stays a straight slice and can never skip or repeat an item.
 */
/**
 * The order a feed is READ in: mixed, and never at the cost of relevance.
 *
 * THE PROBLEM THIS SOLVES, measured on the live pool: 59 items above the bar —
 * 30 podcasts, 16 videos, 8 articles, 5 posts — where every article sat at 3 while
 * the podcasts and videos took every 4 and 5. Sorted by score alone, the first page
 * was twelve podcasts and videos and the articles never appeared at all. The user,
 * for the third time: "i do not see any articles or like posts."
 *
 * So: round-robin across KINDS within each score band, with a per-kind cap, and then
 * append everything that did not make the capped pass in plain score order.
 *
 * Two properties matter more than the look:
 *   - relevance is never faked: mixing happens WITHIN a band, so a 4/5 item is never
 *     placed ahead of a 5/5 one;
 *   - nothing is ever hidden: pass 2 appends the rest in score order, so the cap
 *     mixes the top of the feed without dropping an item out of it.
 */
function orderForFeed(items: RankedItem[], limit: number): RankedItem[] {
  const cap = Math.max(2, Math.round(limit * 0.34)); // ~4 of a 12-item page
  const bands = new Map<number, RankedItem[]>();
  for (const item of items) {
    const band = bands.get(item.score) ?? [];
    band.push(item);
    bands.set(item.score, band);
  }

  const out: RankedItem[] = [];
  const used = new Set<string>();

  for (const score of [...bands.keys()].sort((a, b) => b - a)) {
    const band = bands.get(score) ?? [];

    // Group the band by kind, keeping the order it already has (score, then
    // recency) inside each kind.
    const byKind = new Map<string, RankedItem[]>();
    for (const item of band) {
      const list = byKind.get(item.item.kind) ?? [];
      list.push(item);
      byKind.set(item.item.kind, list);
    }

    // The kinds in the order they appear, so the rotation is deterministic.
    const kinds = [...byKind.keys()];
    const taken = new Map<string, number>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const kind of kinds) {
        const list = byKind.get(kind) ?? [];
        const n = taken.get(kind) ?? 0;
        if (n >= cap || n >= list.length) continue;
        out.push(list[n]);
        used.add(list[n].item.id);
        taken.set(kind, n + 1);
        progressed = true;
      }
    }
  }

  // Pass 2: everything the cap held back, in score order. The cap reorders the top
  // of the feed; it never removes an item from it.
  for (const item of items) {
    if (!used.has(item.item.id)) out.push(item);
  }

  return out;
}

// The paged pool needs the judgement columns as well. It deliberately does NOT
// include full_text: article bodies would ride along in every page payload.
const POOL_COLS = `${ITEM_COLS},score,reason,bucket,matched_goal_id`;

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
  /**
   * Which pass over the interest rotation this is. Round 0 is the day's normal
   * pass. A later round shifts the starting point so an on-demand top-up searches
   * interests the day has NOT already covered, instead of re-finding what is
   * already stored (which the url_norm dedupe would then throw away).
   */
  round?: number;
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

  // Memory is NOT dumped here any more (M1). The free-text store was read as an
  // arbitrary "newest 60" window: 552 rows growing forever, of which a fixed
  // slice was always shown and the rest were silently invisible. The feed's
  // memory arrives through gatherFitSignals(), which retrieves the facts
  // relevant to what this person actually wants.

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

/**
 * German markers for an interest LABEL. The UI is English even though the user's
 * data is German, so a label is copy, not a quote — the derivation prompt asks for
 * English, and this is where the request is enforced.
 *
 * Why here and not (only) in the test: the test asserts on the ACTIVE set, so a
 * German label used to be written to the table, then retired by the hysteresis a
 * run or two later. Seven had accumulated that way and nobody had ever seen one —
 * invisible, but only by luck. The test keeps its own list on purpose (a test that
 * imports the implementation's constants asserts nothing).
 */
export const LABEL_GERMAN_WORDS = [
  "der", "die", "das", "und", "mit", "für", "von", "im", "zum", "zur",
  "gehalt", "rezepte", "üben", "besorgen", "vermeiden", "abendreflexion",
  "morgensport", "grundgewürze", "kokosmilch", "beziehungsroutine",
  // the seven that actually leaked (2026-09-20), which the list above missed
  // because they contain no umlaut and no function word
  "wohnung", "gestalten", "organisieren", "vegane", "frühstück", "joghurt",
  "beeren", "nüssen", "günstig", "kochen", "einkaufsliste", "freunden",
  "planen", "bücher", "lesen", "gewohnheit", "zeit", "mehr",
];

/** True when a label reads German. Umlauts catch some, the word list the rest. */
export function looksGerman(text: string): boolean {
  if (/[äöüßÄÖÜ]/.test(text)) return true;
  const words = String(text).toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
  return words.some((w) => LABEL_GERMAN_WORDS.includes(w));
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

    // Rule 0: the label must be readable English. Dropped BEFORE the merge rules
    // so a German label cannot even attach itself to a good area's text, and
    // LOGGED rather than counted: an invisible rejection is how seven of these
    // piled up in the first place.
    if (looksGerman(text)) {
      console.log(`  [feed] dropped an interest label that was not English: "${text}"`);
      continue;
    }

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
  // Each round shifts a whole pass further along the rotation, so round 1 starts
  // where round 0 stopped rather than searching the same interests again.
  const perRound = Math.max(1, maxInterests);
  const offset = pool.length
    ? (dayOfYear + (opts.round ?? 0) * perRound) % pool.length
    : 0;
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
      view_count: i.candidate.view_count ?? null,
      like_count: i.candidate.like_count ?? null,
      comment_count: i.candidate.comment_count ?? null,
      channel_name: i.candidate.channel_name ?? null,
      channel_subs: i.candidate.channel_subs ?? null,
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
  /**
   * How many times the ranker had to ask again because the model omitted more
   * than half of the candidates it was given. 0 on a well-behaved day, at most 1:
   * the retry happens ONCE, with a stricter instruction, and then the day is
   * whatever the two attempts together produced.
   */
  rankRetries: number;
  /**
   * Candidates the ranking omitted even after the retry — the instruction to
   * answer every index was ignored twice. Counted against the number offered, so
   * "the model dropped a fifth of the list" is a number rather than an inference
   * from a thin feed.
   */
  omittedStill: number;
  /** How many of the day's chosen items came from the news platforms (hn, arxiv, bluesky). */
  newsChosen: number;
  /**
   * News items the diversity walk refused because the day already held
   * NEWS_CAP_PER_DAY of them. Its own number, so "news crowded out the goal
   * content" is visible as a fact rather than felt as a quiet feed.
   */
  newsSkippedByCap: number;
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
/** 2465 → "2.5k", for a ranking block that has to stay small. Pure. */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

/**
 * THE QUALITY FLOOR, in code rather than in the prompt.
 *
 * The complaint (2026-09-20): "interesting title but very poor quality videos".
 * Measured in the stored pool: a salary-negotiation video with **2,465 views** had
 * scored 5/5 — the top of the feed — and a 228-view upload from a 982-subscriber
 * channel sat at 3. A rubric that judges the TOPIC cannot see either, and a title
 * is the cheapest thing on the internet to produce.
 *
 * Applied AFTER the model scores, and only on evidence: a video whose counts are
 * unknown is never capped, because unmeasured is not the same as bad. Two tiers,
 * because views alone mislead on a niche topic — the harsh one also needs a small
 * channel.
 */
export function qualityCap(
  item: Pick<FeedItem, "kind" | "view_count" | "channel_subs">,
  score: number
): { score: number; why: string } {
  if (item.kind !== "video") return { score, why: "" };
  const views = item.view_count ?? null;
  const subs = item.channel_subs ?? null;
  if (views == null) return { score, why: "" };
  if (views < 1000 && (subs == null || subs < 10000)) {
    return score <= 1
      ? { score, why: "" }
      : { score: 1, why: `${views} views, and no channel big enough to vouch for it` };
  }
  if (views < 5000 && (subs == null || subs < 20000)) {
    // `subs == null` is deliberately inside the cap, not outside it: the video that
    // caused this (2,465 views, channel size unknown) escaped the first version of
    // this rule for exactly that reason. An unknown channel is not a large one.
    return score <= 2
      ? { score, why: "" }
      : {
          score: 2,
          why:
            subs == null
              ? `${views} views, channel size unknown`
              : `${views} views from a ${compactCount(subs)}-subscriber channel`,
        };
  }
  return { score, why: "" };
}

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
- PRODUCTION QUALITY IS EVIDENCE, NOT TASTE (added 2026-09-20, after a 2,465-view salary-negotiation video scored 5). A video that is a list of tips read aloud, an AI voiceover over stock footage, a screen recording with nobody explaining it, or a re-upload is a 1 or a 2 — however promising the title. A good title is the cheapest thing on the internet to produce.
- USE THE NUMBERS when a video shows them. Under ~5k views from a channel under ~20k subscribers is a hobby upload: 2 or less, unless the substance is genuinely exceptional (a primary source, a practitioner's first-hand account, a talk by the person who did the work). 100k+ views from a 100k+ subscriber channel that is ABOUT the goal is a 3 or 4. When the numbers are absent, judge the substance alone and do not guess popularity from the title.
- Tennis TECHNIQUE and TRAINING are relevant (Play tennis regularly); equipment lists and ball-machine reviews are not.
- ABOUT, NOT MERELY ADJACENT. The item must BE ABOUT the goal; touching it in passing is not enough. A general multi-topic interview podcast — a show whose real subject is whichever guest happens to be on — that brushes leadership, habits or money somewhere inside it is a 2, NEVER a 3 or a 4, even though its topics overlap a goal. Concretely: an episode titled "Invest Like Warren Buffett & How To Disagree Better" is a 2 for the leadership goal, because the episode is ABOUT those two talking points and only adjacent to leadership. Reserve 3 and above for items whose own SUBJECT is the goal.
- A BARE LINK TEACHES NOTHING. A link to someone's website or product — a landing page, a pricing page, a launch post, including every Show HN submission, which is a link plus a discussion thread — is a 1 or a 2 and never higher: the link itself has no substance, and the discussion is its only substance. Judge such an item on that discussion alone, and when there is none, score it 1.
- Relevant: leadership and visibility; health and cooking WITHOUT product lists; reading about leadership, relationships and psyche.
- NEWS CLAUSE (AI and agent engineering). Substantive AI and agent-engineering content that actually TEACHES him something at his level advances the goal "Owning the AI Initiative at Work" and MUST score 3 or higher, with that goal named in "goal" and referenced in the reason. His level means: agent architecture and how a system is put together; design patterns for agents and LLM applications; the LIMITS of the technology and when it fails; evaluation, evals and how you know it works; tooling and the real mechanics of building; and post-mortems or case studies of how a real initiative was made to work inside a company. Score 2 the things that teach him nothing: funding rounds, model-release announcements, benchmark marketing, hype and industry gossip. Concretely — 4: "How we redesigned our agent's tool-calling to cut retries by 60%, with the eval harness we built to prove it" (agent architecture + evaluation, owned inside a real company). 2: "OpenAI raises $40B at a $300B valuation" (a funding round; it teaches him nothing about owning the initiative).
- Score 2 or lower when an item moves him toward NONE of his goals, however well made it is.
- He reads GERMAN and ENGLISH ONLY. A French or Spanish item is a 1, however good it is.

"goal": the EXACT title of ONE of the active goals listed below that the item serves, copied verbatim. It is required — a candidate you cannot attribute to a goal is not for him.
"reason": AT MOST 12 WORDS, ONE sentence, and it MUST name the goal (or the milestone) it serves — "design patterns for agents, past the basics he already has", NOT "great content". A generic reason is worse than no item, because it teaches him to stop reading them.
Omit any candidate you cannot justify. An omitted candidate, a candidate with no goal, or one with an empty reason is dropped — it is never surfaced behind a vague label.
Every index you return MUST be an index from the numbered candidate list, and an index must appear at most once.`;

// The retry instruction, used ONLY when the first attempt left out more than
// half of the candidates. It is the same rubric — nothing about the judgement
// changes — with the one rule the model ignored stated as its own demand: COVER
// EVERY INDEX. Score 0 is allowed here as the honest answer for a candidate that
// is a flat rejection, because the failure being fixed was the model staying
// silent rather than the model scoring low: an index with a score of 0 and a
// one-sentence reason is a decision that can be counted, and an absent index is
// not. The scale above still applies to everything else, and the caller drops
// anything under the threshold either way.
const RANK_RETRY_SYSTEM = `${RANK_SYSTEM}

COVERAGE IS MANDATORY THIS TIME. The previous answer left out more than half of the candidates it was given, and a candidate you stay silent about is a candidate nobody can decide about. So:
- Every index in the numbered candidate list MUST appear in "ranked" EXACTLY ONCE. Not most of them: every one.
- Every entry MUST have an INTEGER score and a ONE-SENTENCE reason that names the goal (or the milestone) it serves — even when the score is low.
- If a candidate moves him toward none of his goals, do NOT omit it: score it 0 and say in one sentence WHY it is a rejection (gear, marketing, below his level, wrong language, not a goal of his). 0 is a legitimate answer — silence is not.
- Use 1-5 exactly as the rubric above defines it. 0 means "rejected outright" and nothing else.`;

// The indices of the candidate list a ranking left unanswered, or answered with
// an empty reason — the two are the same failure here: no decision the caller can
// use. Counted against the ORIGINAL candidate indices, never against the model's
// own numbering.
function omittedIndices(ranked: RawRanking[], indices: Iterable<number>): number[] {
  const decided = new Set<number>();
  for (const r of ranked) {
    if (r.reason && r.reason.trim()) decided.add(r.index);
  }
  const out: number[] = [];
  for (const index of indices) if (!decided.has(index)) out.push(index);
  return out;
}

// The heading a shortlist item is grouped under when its goal cannot be named:
// the goal row was deleted after the item was scored, or the read failed. A
// neutral heading is strictly better than a missing one — the UI groups BY goal,
// so an item with no title would otherwise sit under nothing or break the page.
export const NO_GOAL_TITLE = "Everything else";

// Resolve each item's attributed goal TITLE (`goal`) alongside its id
// (`goalId`), because the UI groups the shortlist by goal heading and needs the
// name, not just the id. It lives HERE rather than in one route because BOTH
// read paths need it: /api/feed, and /api/feed/refresh, whose response would
// otherwise carry goalTitle undefined and drop every goal heading until the tab
// was reloaded.
//
// The title is read from `getGoals`, and the shortlist's own copy is only the
// fallback: a goal renamed since scoring shows its current name, while an item
// whose goal row is gone still renders under a neutral heading instead of
// breaking the page. Best-effort throughout — a failed goal read leaves every
// item on the fallback rather than blanking the feed.
export async function withGoalTitles<T extends { goalId: string | null; goal: string }>(
  items: T[]
): Promise<(T & { goalTitle: string })[]> {
  const titleById = new Map<string, string>();
  try {
    // Any status, not just active: an item attributed to a goal that has since
    // been completed or archived still deserves its real name.
    const goals = await getGoals();
    for (const g of goals) titleById.set(g.id, g.title);
    // getGoals() hides archived rows; ask for those too so a goal that was
    // archived after scoring is still named rather than silently neutralised.
    const archived = await getGoals("archived");
    for (const g of archived) titleById.set(g.id, g.title);
  } catch {
    // No titles available: every item falls back below.
  }

  return items.map((r) => {
    const fromDb = r.goalId ? titleById.get(r.goalId) : undefined;
    const title = fromDb?.trim() || r.goal?.trim() || NO_GOAL_TITLE;
    return { ...r, goalTitle: title };
  });
}

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
      // Popularity, when it is known. Shown so the rubric's own instruction to
      // use the numbers has something to point at — and absent, rather than zero,
      // when it is not, so the model can tell "nobody watched it" from "unknown".
      const views = item.view_count != null ? `${compactCount(item.view_count)} views` : null;
      const subs = item.channel_subs != null ? `${compactCount(item.channel_subs)} subs` : null;
      const pop = [views, subs].filter(Boolean).join(" · ");
      return (
        `[${index}] ${item.title} · ${item.kind} · ${item.platform}${creator} · ~${minutes} min\n` +
        `    interest: ${interest ?? "(unknown)"}\n` +
        (pop ? `    popularity: ${pop}\n` : "") +
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

// THE NEWS CAP: at most this many of the day's chosen items may come from the
// news platforms (hn, arxiv, bluesky) combined. Not a comment about news being
// bad — it is a comment about what a GOAL feed is: HN, arXiv and Bluesky are
// plentiful, high-scoring and cheap to produce, so without a hard ceiling they
// win the selection outright and the one item that moves an actual goal gets
// crowded out by six interesting links. Two, enforced in the walk below itself
// so no later pass can put a third one back.
const NEWS_CAP_PER_DAY = 2;

// The diversity walk over one relaxation level. Best-first, and an item is taken
// only when its interest is below the limit, the day holds fewer than its news
// allowance, AND its title is not a near-duplicate of something already chosen.
// Rejections at this stage are droppedDiversity, except a news rejection, which
// is counted on its own as newsSkippedByCap.
function selectDiverse(
  ranked: RankedItem[],
  perInterestLimit: number,
  cap: number
): { chosen: RankedItem[]; dropped: number; newsSkipped: number } {
  const chosen: RankedItem[] = [];
  const perInterest = new Map<string, number>();
  let dropped = 0;
  // Both counters are about the CHOSEN list, not the offered one, because the cap
  // is a statement about what the day ends up containing.
  let newsChosen = 0;
  let newsSkipped = 0;

  for (const r of ranked) {
    if (chosen.length >= cap) break;

    const interestId = r.item.matched_interest_id ?? "(none)";
    if ((perInterest.get(interestId) ?? 0) >= perInterestLimit) {
      dropped++;
      continue;
    }
    // The news cap, applied INSIDE the walk so the relaxation passes below (which
    // re-run this same walk) cannot undo it: a third news item with the slack of a
    // relaxed interest limit is exactly the crowding-out this rule exists to stop.
    if (isNewsPlatform(r.item.platform) && newsChosen >= NEWS_CAP_PER_DAY) {
      newsSkipped++;
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
    if (isNewsPlatform(r.item.platform)) newsChosen++;
  }

  return { chosen, dropped, newsSkipped };
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
  /** 0 or 1: the model omitted more than half the candidates and was asked once more. */
  retries: number;
  /** Candidates still unanswered after the retry — the omission that survived it. */
  omittedStill: number;
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
    retries: 0,
    omittedStill: 0,
  };
  if (!candidates.length) return empty;

  const interestText = opts.interestText ?? new Map<string, string>();
  const history = opts.history ?? "";

  // Numbered so the response can refer to a candidate by index. The index is the
  // ONLY link back, so it is rebuilt here rather than trusted from the model.
  const byIndex = new Map<number, FeedItem>();
  candidates.forEach((item, index) => byIndex.set(index, item));

  // The ONE model call, factored out so the retry below is the IDENTICAL path
  // with a stricter instruction and nothing else changed — same numbered
  // candidates, same rubric, same goals. A failed call yields nothing, never a
  // throw.
  const askModel = async (system: string): Promise<RawRanking[]> => {
    try {
      const res = await llm().chat.completions.create({
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
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
      return parseRanking((res.choices[0].message.content ?? "").trim());
    } catch {
      // A failed call yields nothing scored, never a thrown error.
      return [];
    }
  };

  let ranked = await askModel(RANK_SYSTEM);
  let retries = 0;

  // RETRY ON OMISSION. Silence is not a judgement: an index the model left out is
  // a candidate nobody can decide about, and it used to be invisible — a run that
  // dropped 19 of 40 looked exactly like a genuinely thin day. When the first
  // attempt omits MORE THAN HALF of the candidates, ask ONCE more with an
  // instruction that demands every index exactly once, with an integer score and
  // a one-sentence reason, where 0 is the honest answer for a rejection.
  let omitted = omittedIndices(ranked, byIndex.keys());
  if (byIndex.size > 0 && omitted.length > byIndex.size / 2) {
    retries = 1;
    console.log(
      `  [feed] the ranking omitted ${omitted.length} of ${byIndex.size} candidates — asking ` +
        `ONCE more, requiring every index to appear exactly once with an integer score and a ` +
        `one-sentence reason (0 is allowed for a rejection).`
    );
    const second = await askModel(RANK_RETRY_SYSTEM);

    // MERGE, don't replace: an index answered in EITHER attempt is used, so a
    // retry that fixes the omissions cannot silently discard a good judgement the
    // first attempt made. The first attempt wins where it decided; the second is
    // taken only for an index it omitted or left without a reason.
    const merged = new Map<number, RawRanking>();
    for (const r of second) merged.set(r.index, r);
    for (const r of ranked) {
      const prior = merged.get(r.index);
      if (!prior || (r.reason && r.reason.trim())) merged.set(r.index, r);
    }
    ranked = [...merged.values()].sort((a, b) => a.index - b.index);

    omitted = omittedIndices(ranked, byIndex.keys());
  }

  // The goal title the model named, mapped to the user's own id. Matching is
  // case-insensitive on the trimmed title so a small spelling difference does
  // not lose the attribution.
  const goalByTitle = new Map<string, RankGoal>();
  for (const g of goals) goalByTitle.set(g.title.trim().toLowerCase(), g);

  let droppedBlankReason = 0;
  let droppedNoGoal = 0;
  let cappedQuality = 0;
  const scored: ScoredCandidate[] = [];
  // (cappedQuality is reported after the loop; see below.)
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
    // The cap is applied HERE, after the model, because a rubric is a request and
    // this is a rule. The reason is amended rather than replaced: the model's own
    // judgement stays visible next to the demotion, so a wrongly capped item can
    // still be recognised as such.
    const cap = qualityCap(item, r.score);
    if (cap.why) {
      cappedQuality++;
      console.log(`  [feed] quality cap: "${item.title}" ${r.score} → ${cap.score} (${cap.why})`);
    }
    scored.push({
      item,
      score: cap.score,
      reason: cap.why ? `${r.reason} [demoted: ${cap.why}]` : r.reason,
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
  //
  // Counted from the FINAL ranking, after the retry above and its merge, so
  // droppedOmitted is what SURVIVED the retry rather than what triggered it: a
  // retry that recovered every candidate leaves 0 here, and a retry that did not
  // leaves a number that says so.
  if (cappedQuality) {
    console.log(
      `  [feed] the quality cap demoted ${cappedQuality} video(s) below their scored value ` +
        `(watch for this rate: it is the difference between an interesting title and a good video)`
    );
  }

  const droppedOmitted = omitted.length;
  if (droppedOmitted > 0) {
    console.log(
      `  [feed] the ranking omitted ${droppedOmitted} of ${byIndex.size} candidates` +
        `${
          retries
            ? " even after the retry"
            : " — the prompt requires one entry per candidate, so this is the instruction being ignored, not a filter rejecting them"
        }.`
    );
  }

  return {
    scored,
    considered: candidates.length,
    droppedBlankReason,
    droppedOmitted,
    droppedNoGoal,
    droppedLowScore: 0,
    retries,
    omittedStill: droppedOmitted,
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
      rankRetries: 0,
      omittedStill: 0,
      newsChosen: 0,
      newsSkippedByCap: 0,
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
      rankRetries: 0,
      omittedStill: 0,
      newsChosen: 0,
      newsSkippedByCap: 0,
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
  // How many news items the walk refused for the cap. Accumulated across the
  // passes because each pass re-walks the same list: a news item the first pass
  // refused for the cap is still refused by the relaxed pass it re-appears in.
  let newsSkippedByCap = 0;
  const first = selectDiverse(scored, INTEREST_LIMIT, cap);
  chosen = first.chosen;
  droppedDiversity = first.dropped;
  newsSkippedByCap += first.newsSkipped;

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
      // The relaxed limit loosens the INTEREST allowance, never the news cap:
      // re-running the walk means the cap is applied again from the chosen list
      // this pass produced, so a pass that would have added a third news item
      // simply does not, and says so.
      newsSkippedByCap += again.newsSkipped;
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

  // How many of the day's items actually came from the news platforms, counted
  // from the CHOSEN list rather than from the cap, so the two numbers together
  // read as a fact: "2 of 6 were news, 3 more were held back by the cap".
  const newsChosen = chosen.filter((r) => isNewsPlatform(r.item.platform)).length;
  if (newsSkippedByCap > 0) {
    console.log(
      `  [feed] news cap: ${newsChosen} news item(s) chosen, ${newsSkippedByCap} held back ` +
        `(at most ${NEWS_CAP_PER_DAY} of the day may come from hn, arxiv and bluesky combined).`
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
    rankRetries: result.retries,
    omittedStill: result.omittedStill,
    newsChosen,
    newsSkippedByCap,
  };
}

// --- the paged pool (P8) ----------------------------------------------------
//
// THE PROBLEM. buildShortlist() answers "what are today's six items?" — and that was
// the only question the tab could ask, so everything else that had already scored
// 3+ was unreachable: 44 items, sitting on disk, refused. The user: "i wanna be able
// to really scroll through a bunch of stuff".
//
// So the pool is read directly and paged, at the SAME bar. No new judgement is
// invented for scrolling: an item that arrives by scrolling has passed exactly the
// test that an item arriving as today's shortlist passed. When the pool runs out it
// says so rather than padding — the honest end is a feature, not a failure.

export interface FeedPage {
  items: RankedItem[];
  /** Pass back as ?offset= for the next page; null marks the honest end. */
  nextOffset: number | null;
  /** How many items meet the bar in total, so the UI can honestly say "12 of 44". */
  poolSize: number;
}

/** How much of the pool is ordered in memory before a page is sliced out of it. */
const POOL_FETCH_MAX = 200;

export async function buildFeedPage(
  opts: { limit?: number; offset?: number } = {}
): Promise<FeedPage> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
  const offset = Math.max(0, opts.offset ?? 0);
  const db = createServiceClient();
  try {
    // Fetch the POOL, not the page, then order it, then slice.
    //
    // This is the difference between a mix and the illusion of one: ordering only
    // the 12 rows of a page has nothing to mix WITH, because the page slice already
    // happens in the database by score — which is how the first fix produced "a post
    // and a video" and eleven podcasts anyway. The pool is bounded at 200 rows, which
    // is far above the current 59 and keeps the query honest.
    const { data, error, count } = await db
      .from("feed_items")
      .select(POOL_COLS, { count: "exact" })
      .eq("status", "new")
      .eq("validated", true)
      .not("score", "is", null)
      .gte("score", MIN_SCORE)
      .order("score", { ascending: false })
      .order("created_at", { ascending: false })
      .range(0, POOL_FETCH_MAX - 1);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as (FeedItem & {
      score: number | null;
      reason: string | null;
      bucket: string | null;
      matched_goal_id: string | null;
    })[];
    const poolSize = count ?? rows.length;
    const ordered = orderForFeed(
      await withGoalTitles(
        rows.map((item) => ({
          item,
          score: Number(item.score ?? MIN_SCORE),
          reason: item.reason ?? "",
          goal: "",
          goalId: item.matched_goal_id,
          bucket: (item.bucket === "fun" ? "fun" : "growth") as "growth" | "fun",
        }))
      ),
      limit
    );

    const page = ordered.slice(offset, offset + limit);
    const consumed = offset + page.length;
    return {
      items: page,
      nextOffset: consumed < ordered.length ? consumed : null,
      poolSize,
    };
  } catch {
    return { items: [], nextOffset: null, poolSize: 0 };
  }
}

export interface TopUpResult {
  /** Unjudged candidates that were scored in this pass. */
  ranked: number;
  /** How many of those cleared the bar and became scrollable. */
  added: number;
  /** Candidates a fresh discovery round found (the only step that spends money). */
  discovered: number;
  /** True when there was nothing left to judge and nothing left to search. */
  exhausted: boolean;
  detail: string;
}

/**
 * Find more to scroll, cheapest first.
 *
 * STEP 1 costs no search calls at all. The store holds candidates that were fetched,
 * validated and never judged — 121 of 165 when this was written — because the daily
 * run only ranks the day's fresh ones. Judging them is one model call, and it is
 * also the reason an "endless" feed is affordable: most of the supply is already
 * paid for.
 *
 * STEP 2 runs a real discovery pass, the only part that spends money (12 Tavily
 * searches, roughly $0.10), so it runs only when step 1 had nothing to judge. The
 * pass uses `round: 1`, which shifts the interest rotation so it searches interests
 * the day's normal run did not touch.
 */
export async function topUpFeed(): Promise<TopUpResult> {
  const db = createServiceClient();

  // --- step 1: judge what is stored but unjudged ---------------------------
  let unscored: FeedItem[] = [];
  try {
    const { data, error } = await db
      .from("feed_items")
      .select(ITEM_COLS)
      .eq("status", "new")
      .eq("validated", true)
      .is("score", null)
      .order("created_at", { ascending: false })
      .limit(rankLimit());
    if (error) throw new Error(error.message);
    unscored = (data ?? []) as FeedItem[];
  } catch {
    unscored = [];
  }

  if (unscored.length) {
    const interestText = new Map<string, string>();
    try {
      const { data } = await db.from("feed_interests").select("id,text");
      for (const r of (data ?? []) as { id: string; text: string }[]) {
        interestText.set(r.id, r.text);
      }
    } catch {
      // labels are nice to have, not required
    }

    const goals = await loadRankGoals();
    const result = await scoreCandidates(unscored, goals, { interestText });

    // Persist the judgement, so the pool query can see it. Only the ones that
    // cleared the bar matter for scrolling, but writing every score keeps the
    // record of what was judged and stops the same rows being paid for twice.
    let added = 0;
    for (const s of result.scored) {
      try {
        const { error } = await db
          .from("feed_items")
          .update({
            score: s.score,
            reason: s.reason,
            // The bucket is derived, not returned: P5's rubric is goals, so an item
            // that serves an active goal is growth and one that does not is fun.
            bucket: s.goalId ? "growth" : "fun",
            matched_goal_id: s.goalId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", s.item.id);
        if (error) throw new Error(error.message);
        if (s.score >= MIN_SCORE) added++;
      } catch {
        // one failed write must not lose the rest
      }
    }

    return {
      ranked: result.scored.length,
      added,
      discovered: 0,
      exhausted: false,
      detail:
        `judged ${result.scored.length} already-stored candidate(s); ` +
        `${added} cleared ${MIN_SCORE}+ and are now scrollable (no search calls spent)`,
    };
  }

  // --- step 2: nothing left to judge, so go and find some ------------------
  const interests = await getInterests();
  const discovery = await discoverCandidates(interests, { round: 1 });
  const saved = await saveCandidates(
    discovery.candidates,
    new Map(interests.map((i) => [i.id, i.id]))
  );

  if (!saved.inserted) {
    return {
      ranked: 0,
      added: 0,
      discovered: 0,
      exhausted: true,
      detail:
        `a fresh discovery round found nothing new (${discovery.candidates.length} ` +
        `candidate(s) seen, all already stored) — the pool is genuinely empty`,
    };
  }

  // The fresh rows have no score yet, so the same shortlist call that ranks the
  // day's pool is used to judge them — one code path, not two.
  await buildShortlist().catch(() => null);

  return {
    ranked: 0,
    added: 0,
    discovered: saved.inserted,
    exhausted: false,
    detail:
      `judged everything stored, so a new discovery round ran: ` +
      `${discovery.candidates.length} candidate(s), ${saved.inserted} new ` +
      `(interests rotated by one pass; ${discovery.stats.tavilyCalls} Tavily call(s))`,
  };
}

// --- reading an item inside the app -----------------------------------------

export interface ReaderText {
  text: string | null;
  /** Where the text came from, so the UI can be honest about it. */
  source: "stored" | "fetched" | "unavailable";
  chars: number;
}

/** The columns the reader needs. Named, so a cast cannot collapse to never. */
interface ItemTextRow {
  id: string;
  url: string;
  kind: string;
  summary: string | null;
  full_text: string | null;
}

/**
 * The text to read for one item, fetching and KEEPING it the first time.
 *
 * Articles are fetched once and stored, so a second open costs nothing. Videos and
 * podcasts are NOT fetched: their pages carry no readable body (a YouTube watch page
 * is a JavaScript shell, a Spotify episode page is a player), and pretending
 * otherwise would produce either an empty reader or a page of boilerplate. For those
 * the stored description is what there is, and the card says so by offering the app
 * instead of a reader.
 */
export async function readFeedItemText(
  id: string,
  opts: { maxChars?: number } = {}
): Promise<ReaderText> {
  const maxChars = Math.max(500, Math.min(40000, opts.maxChars ?? 12000));
  const db = createServiceClient();

  let row: ItemTextRow | null = null;
  try {
    const { data, error } = await db
      .from("feed_items")
      .select("id,url,kind,summary,full_text")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    row = (data as ItemTextRow | null) ?? null;
  } catch {
    row = null;
  }
  if (!row) return { text: null, source: "unavailable", chars: 0 };

  if (row.full_text && row.full_text.length > 200) {
    return { text: row.full_text.slice(0, maxChars), source: "stored", chars: row.full_text.length };
  }

  if (row.kind !== "article") {
    const text = row.summary?.trim() || null;
    return { text, source: text ? "stored" : "unavailable", chars: text?.length ?? 0 };
  }

  try {
    const fetched = await fetchPageText(row.url, maxChars);
    const text = fetched?.trim() ?? "";
    if (text.length < 200) {
      return { text: row.summary ?? null, source: row.summary ? "stored" : "unavailable", chars: row.summary?.length ?? 0 };
    }
    // Keep it: the next open is free, and the feed stops depending on a live page.
    try {
      await db
        .from("feed_items")
        .update({ full_text: text, full_text_at: new Date().toISOString() })
        .eq("id", id);
    } catch {
      // storing is an optimisation, not a requirement
    }
    return { text, source: "fetched", chars: text.length };
  } catch {
    // A page that cannot be fetched still gives the snippet rather than a blank
    // reader — a paywall or a bot wall is normal, not an error worth showing.
    const text = row.summary ?? null;
    return { text, source: text ? "stored" : "unavailable", chars: text?.length ?? 0 };
  }
}

// --- filling in what was never captured --------------------------------------

/**
 * Give stored items the text they should have had.
 *
 * Podcast rows created before the episode description was captured have none, and
 * the live page showed the cost immediately: the top of the scroll was six podcasts
 * in a row with nothing to read — the exact "list of doors" the user rejected. This
 * The lookup goes through SEARCH, matched on the episode id, because the bulk
 * episode endpoint answers 403 for this app — feed-sources records that finding
 * where the call is. It is a repair rather than part of the daily refresh, and it is
 * idempotent: it only ever looks at rows that still have no text.
 */
export async function backfillFeedDescriptions(): Promise<{
  checked: number;
  updated: number;
  detail: string;
}> {
  const db = createServiceClient();
  let rows: { id: string; url: string; title: string; platform: string }[] = [];
  try {
    const { data, error } = await db
      .from("feed_items")
      .select("id,url,title,platform")
      .eq("kind", "podcast")
      .is("summary", null)
      .limit(200);
    if (error) throw new Error(error.message);
    rows = (data ?? []) as typeof rows;
  } catch {
    return { checked: 0, updated: 0, detail: "could not read the stored podcasts" };
  }
  if (!rows.length) {
    return { checked: 0, updated: 0, detail: "every stored podcast already has text" };
  }

  const wanted: { episodeId: string; title: string; rowIds: string[] }[] = [];
  for (const r of rows) {
    const episodeId = spotifyEpisodeId(r.url);
    if (!episodeId) continue;
    const existing = wanted.find((w) => w.episodeId === episodeId);
    if (existing) existing.rowIds.push(r.id);
    else wanted.push({ episodeId, title: r.title, rowIds: [r.id] });
  }

  // Searched by the title we stored and matched on the episode id, so the text
  // attached to a row is that episode's and never a neighbour's.
  const descriptions = await spotifyEpisodeDescriptionsViaSearch(
    wanted.map((w) => ({ episodeId: w.episodeId, title: w.title }))
  );

  let updated = 0;
  for (const w of wanted) {
    const text = descriptions.get(w.episodeId);
    if (!text) continue;
    for (const rowId of w.rowIds) {
      try {
        const { error } = await db
          .from("feed_items")
          .update({ summary: text, updated_at: new Date().toISOString() })
          .eq("id", rowId);
        if (!error) updated++;
      } catch {
        // one failed row must not stop the rest
      }
    }
  }

  // The Apple-era rows are deliberately NOT chased here. An iTunes lookup by the id
  // in the link was written and tried, and it filled nothing — a probe returns
  // status 200 with zero results, so the id/endpoint pairing is unproven rather than
  // broken-and-understood. Leaving a function that silently fills nothing would be
  // worse than leaving these rows alone: they are legacy (Spotify is the source now)
  // and they fall out of the pool as newer episodes arrive.
  const appleRows = rows.filter((r) => !spotifyEpisodeId(r.url)).length;
  return {
    checked: rows.length,
    updated,
    detail:
      `${rows.length} podcast row(s) had no text; ${updated} filled from Spotify ` +
      `search; ${appleRows} Apple-era row(s) left alone (no working lookup)`,
  };
}
