import { createServiceClient } from "./supabase";
import { embed, itemText } from "./embeddings";
import { xpForTask } from "./stats";

export type ItemType = "todo" | "note" | "idea";
export type ItemStatus = "active" | "done" | "archived";
export type SortBy = "priority" | "created_at" | "due_date";

// Columns to return — excludes `embedding` to keep payloads small.
const ITEM_COLS =
  "id,type,title,content,priority,status,tags,due_date,notification_time,xp_awarded,planned_for,planned_time,day_order,required,goal_id,milestone_id,resolved_at,created_at,updated_at";

// Drop embedding from rows returned by the match_items RPC (returns setof items).
function stripEmbedding(row: Record<string, unknown>): Item {
  const { embedding: _embedding, ...rest } = row;
  void _embedding;
  return rest as unknown as Item;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  content: string | null;
  priority: number;
  status: ItemStatus;
  tags: string[];
  due_date: string | null;
  notification_time: string | null;
  xp_awarded: number;
  planned_for: string | null;
  planned_time: string | null;
  day_order: number | null;
  required: boolean;
  goal_id: string | null;
  milestone_id: string | null;
  /**
   * When a finished task was put away (migration 0025). NULL means live for
   * planning; a timestamp means the day is over and the element is resolved.
   * status stays 'done' and planned_for stays on purpose — they are the history
   * keys the Stats tab, the day metrics and the milestone roll-up read.
   */
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateItemInput {
  type: ItemType;
  title: string;
  content?: string;
  priority?: number;
  tags?: string[];
  due_date?: string;
  notification_time?: string;
  planned_for?: string;
  planned_time?: string;
  day_order?: number;
  required?: boolean;
  goal_id?: string;
  milestone_id?: string | null;
}

export interface UpdateItemInput {
  type?: ItemType;
  title?: string;
  content?: string;
  priority?: number;
  status?: ItemStatus;
  tags?: string[];
  due_date?: string;
  notification_time?: string;
  planned_for?: string | null;
  planned_time?: string | null;
  day_order?: number | null;
  required?: boolean;
  goal_id?: string | null;
  milestone_id?: string | null;
}

export interface GetItemsOpts {
  type?: ItemType;
  status?: ItemStatus;
  sort_by?: SortBy;
  query?: string;
  // Only items planned for this exact local day (YYYY-MM-DD).
  planned_for?: string;
  // true → only planned items; false → only unplanned (planned_for is null).
  has_plan?: boolean;
  // true → exclude items that have been RESOLVED (migration 0025). Resolution is
  // "finished and its day is over", so this is what keeps finished work out of
  // the list without hiding it on the day it was actually done.
  unresolved?: boolean;
}

// Words that carry no meaning on their own in either language this app is used
// in. They are dropped from the query BEFORE it is turned into a filter, because
// a generic word does not merely fail to help — it floods the candidate set
// ("the" is a substring of "together", "get" of "budget"), and the row limit
// then buries the answer under matches that share nothing but a syllable.
const SEARCH_STOPWORDS = new Set([
  // English
  "the", "and", "for", "with", "from", "that", "this", "these", "those",
  "what", "when", "where", "which", "who", "whom", "why", "how", "about",
  "into", "over", "under", "should", "would", "could", "can", "get", "got",
  "have", "has", "had", "want", "need", "please", "help", "tell", "show",
  "find", "search", "look", "looking", "give", "make", "made", "does", "did",
  "i", "me", "my", "we", "our", "you", "your", "she", "her", "his", "him",
  "they", "them", "it", "its", "is", "are", "was", "were", "be", "been", "do",
  "of", "to", "in", "on", "at", "by", "as", "or", "if", "so", "no", "not",
  "but", "than", "then", "there", "here", "all", "any", "some", "just", "now",
  // German
  "und", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
  "einem", "einer", "für", "mit", "von", "zum", "zur", "auf", "ist", "war",
  "waren", "wird", "werden", "würde", "ich", "mein", "meine", "meinen",
  "meiner", "mir", "mich", "dein", "deine", "sie", "ihr", "ihre", "ihren",
  "wir", "uns", "euch", "du", "dich", "dir", "er", "ihn", "ihm", "es", "man",
  "sich", "wie", "was", "wer", "wo", "oder", "auch", "noch", "schon", "nur",
  "sehr", "nicht", "kein", "keine", "aber", "wenn", "dann", "weil", "damit",
  "dass", "kann", "können", "könnte", "muss", "müssen", "soll", "sollte",
  "will", "wollen", "hast", "habe", "haben", "bin", "bist", "sind", "sein",
  "bei", "aus", "als", "zu", "im", "am", "um", "an", "nach", "vor", "über",
  "bitte", "mal", "etwas",
]);

/**
 * Bilingual synonym groups, because this notebook is written in two languages:
 * an item is often titled in English while the question is asked in German
 * ("Geburtstag Geschenk Theresa" against "Gift for Theresa"). Google handles
 * that; a substring match cannot. A SMALL, curated glossary closes the gap
 * without pretending to be a translation engine — and it is deliberately
 * weighted BELOW the user's own words, so a translation can never outrank a
 * literal hit.
 *
 * Groups, not pairs: every word in a group expands to the others.
 */
const SYNONYM_GROUPS: string[][] = [
  ["birthday", "geburtstag", "geburtstage"],
  ["gift", "geschenk", "geschenke", "schenken", "schenke", "verschenken", "präsent"],
  ["idea", "idee", "ideen"],
  ["cards", "karten"],
  ["game", "spiel", "spielen", "spielt"],
  ["buy", "kaufen", "kauf", "einkaufen", "bestellen", "order", "shopping"],
  ["travel", "trip", "vacation", "holiday", "reise", "urlaub", "verreisen"],
  ["book", "bücher", "buch", "lesen", "read", "reading", "lese"],
  ["run", "running", "joggen", "laufen", "läuft", "workout", "training", "fitness", "gym"],
  ["cook", "cooking", "kochen", "kocht", "rezept", "recipe"],
  ["clean", "cleaning", "putzen", "aufräumen", "waschen", "laundry"],
  ["money", "geld", "budget", "finanzen", "finance"],
  ["tax", "steuer", "steuern", "taxes"],
  ["insurance", "versicherung", "versicherungen"],
  ["doctor", "arzt", "ärztin", "termin", "appointment", "appointments"],
  ["dentist", "zahnarzt", "zahnärztin"],
  ["family", "familie", "freund", "freundin", "friend", "friends", "freunde"],
  ["mother", "mutter", "mama", "mom", "mum"],
  ["father", "vater", "papa", "dad"],
  ["sister", "schwester"],
  ["brother", "bruder"],
  ["work", "arbeit", "job", "beruf", "project", "projekt"],
  ["boss", "chef", "chefin", "vorgesetzte"],
  ["learn", "lernen", "lerne", "study", "studieren", "sprache", "language", "deutsch", "german", "english", "englisch"],
  ["plan", "planen", "planung", "planning"],
  ["write", "schreiben", "writing"],
  ["house", "home", "wohnung", "haus"],
  ["car", "auto", "wagen"],
  ["wedding", "hochzeit"],
  ["christmas", "weihnachten"],
  ["weather", "wetter"],
  ["invite", "einladen", "invitation", "einladung"],
  ["email", "mail"],
];

// word → the other words in its group(s).
const SEARCH_SYNONYMS = ((): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      const others = group.filter((w) => w !== word);
      map.set(word, [...(map.get(word) ?? []), ...others]);
    }
  }
  return map;
})();

/**
 * Normalise a query into the words worth matching on.
 *
 * Two things a plain `split(/\s+/)` got wrong:
 *  - Possessives/inflections. "Theresas Birthday gift ideas" searched for the
 *    literal string "Theresas", which matches nothing; the item is titled
 *    "Gift for Theresa". So a trailing "s" is dropped, in the query only, for
 *    words long enough that it is safe. "ideas" → "idea" is the same rule, and
 *    it is what makes an item titled "… Ideas" findable by a query worded in the
 *    singular.
 *  - Stopwords, in both languages. See SEARCH_STOPWORDS.
 */
export function searchWords(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const w =
      raw.length >= 4 && raw.endsWith("s") && !raw.endsWith("ss")
        ? raw.slice(0, -1)
        : raw;
    if (w.length < 3 || SEARCH_STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/**
 * The full literal word set for a query: the user's own words, plus their
 * bilingual synonyms. `own` marks the words that came from the query itself, so
 * the ranking can weight a literal hit above a translated one.
 *
 * (The semantic side embeds the query as the user typed it — it needs no help
 * crossing languages.)
 */
export function expandQuery(query: string): { words: string[]; translated: string[] } {
  const own = searchWords(query);
  const words = [...own];
  const translated: string[] = [];
  for (const w of own) {
    for (const s of SEARCH_SYNONYMS.get(w) ?? []) {
      if (words.includes(s)) continue;
      words.push(s);
      translated.push(s);
    }
  }
  return { words, translated };
}

export async function getItems(opts: GetItemsOpts = {}): Promise<Item[]> {
  const db = createServiceClient();

  // Hybrid search: literal keyword (ilike) matches RANKED BY HOW MUCH of the
  // query they cover, then semantic (vector) matches as the tail. A literal hit
  // is evidence the user meant this item; similarity is a hint. So the order is
  // "strongest literal match first", and the items that only matched by meaning
  // follow — never interleaved ahead of them.
  if (opts.query) {
    const { words, translated } = expandQuery(opts.query);
    const translatedSet = new Set(translated);
    const queryEmbedding = await embed(opts.query);

    const semanticHits = async (): Promise<Item[]> => {
      const { data, error } = await db.rpc("match_items", {
        query_embedding: queryEmbedding,
        match_count: 30,
        match_threshold: 0.2,
        filter_type: opts.type ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map(stripEmbedding);
    };

    // Literal side: any query word as a substring of title or content. Skipped
    // entirely when the query was all stopwords — there is nothing to match on,
    // and "the" would otherwise return the whole table.
    const lexicalHits = async (): Promise<Item[]> => {
      if (!words.length) return [];
      let lex = db.from("items").select(ITEM_COLS).neq("status", "archived");
      if (opts.type) lex = lex.eq("type", opts.type);
      if (opts.planned_for) lex = lex.eq("planned_for", opts.planned_for);
      if (opts.has_plan === false) lex = lex.is("planned_for", null);
      if (opts.has_plan === true) lex = lex.not("planned_for", "is", null);
      const ors = words.flatMap((w) => [
        `title.ilike.%${w}%`,
        `content.ilike.%${w}%`,
      ]);
      const { data, error } = await lex.or(ors.join(",")).limit(40);
      if (error) throw new Error(error.message);
      return (data ?? []) as Item[];
    };

    const [semItems, lexItems] = await Promise.all([
      semanticHits(),
      lexicalHits(),
    ]);

    // The RPC returns by similarity, so its ORDER is worth keeping as the
    // tie-breaker instead of the arbitrary order the lexical query came back in.
    const semRank = new Map(semItems.map((it, index) => [it.id, index]));

    // Relevance = how much of the query the item literally contains. A title hit
    // is worth three content hits (the title is what the item IS); matching by
    // meaning as well is worth a tip; a word reached through the bilingual
    // glossary counts for less than a word the user actually typed, so a
    // translation can never outrank a literal hit.
    const relevance = (it: Item): number => {
      const title = it.title.toLowerCase();
      const content = (it.content ?? "").toLowerCase();
      let score = 0;
      for (const w of words) {
        const titleHit = translatedSet.has(w) ? 2 : 3;
        if (title.includes(w)) score += titleHit;
        else if (content.includes(w)) score += 1;
      }
      return semRank.has(it.id) ? score + 2 : score;
    };

    const rankOf = (id: string): number => semRank.get(id) ?? Number.MAX_SAFE_INTEGER;

    const ranked = lexItems
      .map((it, index) => ({ it, index, score: relevance(it) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          rankOf(a.it.id) - rankOf(b.it.id) ||
          a.index - b.index
      )
      .map((r) => r.it);

    const seen = new Set<string>();
    const merged: Item[] = [];
    for (const it of [...ranked, ...semItems]) {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        merged.push(it);
      }
    }
    return merged;
  }

  let q = db.from("items").select(ITEM_COLS);

  if (opts.type) q = q.eq("type", opts.type);
  if (opts.status) q = q.eq("status", opts.status);
  else q = q.neq("status", "archived");

  if (opts.planned_for) q = q.eq("planned_for", opts.planned_for);
  if (opts.has_plan === false) q = q.is("planned_for", null);
  else if (opts.has_plan === true) q = q.not("planned_for", "is", null);
  if (opts.unresolved) q = q.is("resolved_at", null);

  const sortCol = opts.sort_by ?? "created_at";
  q = q.order(sortCol, { ascending: sortCol === "priority" });

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}

export async function createItem(input: CreateItemInput): Promise<Item> {
  const db = createServiceClient();
  const embedding = await embed(itemText(input.title, input.content));
  const { data, error } = await db
    .from("items")
    .insert({ ...input, priority: input.priority ?? 3, embedding })
    .select(ITEM_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as Item;
}

export async function updateItem(
  id: string,
  input: UpdateItemInput
): Promise<Item & { xpGained: number }> {
  const db = createServiceClient();
  const patch: Record<string, unknown> = {
    ...input,
    updated_at: new Date().toISOString(),
  };

  const needsCurrent =
    input.title !== undefined ||
    input.content !== undefined ||
    input.status === "done";

  let current:
    | { title?: string; content?: string | null; type?: ItemType; status?: ItemStatus; priority?: number; xp_awarded?: number }
    | null = null;
  if (needsCurrent) {
    const { data } = await db
      .from("items")
      .select("title,content,type,status,priority,xp_awarded")
      .eq("id", id)
      .maybeSingle();
    current = data;
  }

  // Re-embed when title or content changes; merge with existing values for the other field.
  if (input.title !== undefined || input.content !== undefined) {
    const title = input.title ?? current?.title ?? "";
    const content = input.content ?? current?.content ?? null;
    patch.embedding = await embed(itemText(title, content));
  }

  // Gamified completion: award XP the first time a todo goes active -> done.
  // Stored on the row (xp_awarded) so re-completing never double-counts.
  let xpGained = 0;
  if (
    input.status === "done" &&
    current?.type === "todo" &&
    current.status !== "done" &&
    (current.xp_awarded ?? 0) === 0
  ) {
    xpGained = xpForTask(current.priority ?? 3);
    patch.xp_awarded = xpGained;
  }

  const { data, error } = await db
    .from("items")
    .update(patch)
    .eq("id", id)
    .select(ITEM_COLS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No item found with id "${id}"`);

  // Roll-up choke point: every status change (sidebar, Today window, coach
  // tools) flows through this one function, so hooking the milestone sync
  // here means no caller can forget it. A roll-up failure must never fail the
  // item update, so it is swallowed. Imported lazily to avoid a module-scope
  // import cycle (milestones.ts must not import db.ts).
  const row = data as Item;
  if (row.milestone_id && input.status !== undefined) {
    try {
      const { syncMilestoneFromTasks } = await import("./milestones");
      await syncMilestoneFromTasks(row.milestone_id);
    } catch {
      // best-effort: the milestone stays as-is; the task change still applies.
    }
  }

  return { ...row, xpGained };
}

export async function deleteItem(id: string): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from("items").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function getItemsDueForNotification(): Promise<Item[]> {
  const db = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("items")
    .select(ITEM_COLS)
    .eq("status", "active")
    .not("notification_time", "is", null)
    .lte("notification_time", now);
  if (error) throw new Error(error.message);
  return (data ?? []) as Item[];
}
