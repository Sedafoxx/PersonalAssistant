// Nova's feed, part 2: finding REAL links, from sources that can be checked.
//
// P1 derived what fits the user. This module turns one interest's search
// queries into concrete candidates — an article, a video, a podcast episode, a
// post — and then VALIDATES each candidate individually before it is allowed
// anywhere near the database. Search snippets lie (dead links, wrong titles,
// YouTube "results" that are really channels), so nothing here is trusted until
// a second, independent call has confirmed it exists:
//
//   video   → YouTube oEmbed must return a title (and corrects it)
//   podcast → Spotify search already proved it; otherwise a reachability GET
//   article → GET with a browser UA, must be html/pdf and < 400
//   post    → same as article
//
// Two rules hold throughout:
//   - every source is best-effort: a failure yields an empty list, never a
//     thrown error that blanks the page;
//   - no ranking happens here. Ordering belongs to P3, so the one popularity
//     threshold below (Bluesky's like floor) is a noise filter only.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// --- types ------------------------------------------------------------------

export type ItemKind = "article" | "video" | "podcast" | "post";

export interface Candidate {
  url: string;
  kind: ItemKind;
  platform: string;
  title: string;
  creator: string | null;
  summary: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  image_url: string | null;
}

// --- URL canonicalisation ---------------------------------------------------

// Params that only ever identify the referrer, never the content. Dropping them
// is what makes the code's dedupe key and the database's generated url_norm
// agree: the 2 rows that leaked per run were the same link seen twice under two
// tracking-parameter spellings. `v` (YouTube) and `i` (Apple episode) are
// meaningful and MUST survive.
const TRACKING_PARAMS = new Set([
  "uo", "si", "feature", "ref", "fbclid", "gclid", "mc_cid",
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || n.startsWith("utm_");
}

// One link, one string. Lowercases scheme and host only (path and query case
// can be significant), trims a trailing slash off a non-root path, and drops
// the tracking params. Never throws: anything unparseable comes back merely
// lowercased and trimmed, which is exactly what url_norm does on the DB side.
export function canonicalUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    const keys = [...u.searchParams.keys()];
    for (const key of keys) {
      if (isTrackingParam(key)) u.searchParams.delete(key);
    }
    // URL sorts nothing on its own; normalising the order keeps two spellings
    // of the same link identical byte for byte.
    u.searchParams.sort();
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/" && !u.search && !u.hash) {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return trimmed.toLowerCase();
  }
}

// --- shortform social -------------------------------------------------------

// Platforms whose whole format is the short, endlessly-scrollable video the feed
// exists to replace. A "source" is unknowable here and there is no depth to rank
// on, so they never enter through the article door — a TikTok link turned up for
// the reading interest and that is precisely the thing being escaped. Social
// POSTS remain a legitimate kind on their own path (Bluesky), which is a
// different door with a different shape.
const SHORTFORM_HOSTS = [
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "snapchat.com",
  "pinterest.com",
  "threads.net",
];

/** True when the URL is shortform social video/image, never a place to read. */
export function isShortformSocial(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return SHORTFORM_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
  } catch {
    // An unparseable URL is not obviously shortform; other checks will judge it.
    return false;
  }
}

// --- relevance --------------------------------------------------------------

// Words that appear in almost every phrase and so distinguish nothing.
const RELEVANCE_STOPWORDS = new Set([
  "with", "from", "that", "this", "your", "about", "into", "over", "more",
  "best", "for", "and", "the",
]);

// Words that turn up in unending content titles, so a match on one of them proves
// nothing about fit. A pickleball episode titled "Skill Ratings, Tournament
// Pickleball, the IPTPA, Tips for Advanced Players" was matching a TENNIS query on
// tips/advanced/players alone — three generic words, no tennis. A match made only
// of these therefore does not count, which is what keeps a look-alike hobby out.
const GENERIC_TOKENS = new Set([
  "tips", "advanced", "players", "ideas", "guide", "training", "basics",
  "tricks", "highlights", "review", "explained", "complete", "episode",
]);

// Lowercase words of >= 4 characters, minus the stopwords. Applied to the query
// and to the interest label; the candidate's own text is tokenised the same way.
function relevanceTokens(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9äöüß]+/)
      .filter((w) => w.length >= 4 && !RELEVANCE_STOPWORDS.has(w))
  );
}

// The gate that makes the point of a feed: FIT, not volume.
//
// A candidate is kept when ANY query token appears in its title/summary/creator,
// or when at least one token of the interest itself does. Everything else is
// dropped as rejectedRelevance — Apple's episode search returning "Chapter 1:
// Our Pickleball Journeys" for a tennis query is the case this exists for.
export function isRelevant(
  c: Candidate,
  query: string,
  interestText: string,
  titleOnly = false,
  requireLabel = false
): boolean {
  try {
    // Some sources are loose enough that a match anywhere in a description means
    // nothing, so for those the match must be in the TITLE. The caller decides,
    // because at gate time the raw candidate may not carry its own kind yet.
    const haystackText =
      titleOnly || c.kind === "podcast"
        ? (c.title ?? "")
        : `${c.title ?? ""} ${c.summary ?? ""} ${c.creator ?? ""}`;
    const haystack = relevanceTokens(haystackText);
    if (!haystack.size) return false;

    // A word from the interest LABEL is the strongest evidence of fit: it is the
    // thing the user actually cares about. One such match is enough.
    for (const t of relevanceTokens(interestText)) {
      if (haystack.has(t)) return true;
    }

    // A title that names none of the labels is not evidence of fit at all, and for
    // the loosest source that is the whole test. This is the rule that catches
    // "TO CATCH A CHEATER: Why Is Her Boyfriend Secretly Booking a Hotel Every
    // Week?!" for an interest in reading more books: it matched the phrase "how to
    // read more books every week" on the words "every" and "week", which is a
    // coincidence of English, not a recommendation.
    if (requireLabel) return false;

    // Falling back to the search phrase alone is weaker, so it needs two matches
    // and at least one that is not generic — otherwise "tips for advanced
    // players" would let in any sport at all.
    const queryMatches = [...relevanceTokens(query)].filter((t) => haystack.has(t));
    if (
      queryMatches.length >= 2 &&
      queryMatches.some((t) => !GENERIC_TOKENS.has(t))
    ) {
      return true;
    }
    return false;
  } catch {
    // A gate that throws would empty a source; treat it as "keep" only when it
    // genuinely cannot decide, which cannot happen here — so drop.
    return false;
  }
}

// --- small helpers ----------------------------------------------------------

function clean(text: unknown, max = 400): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// A GET that returns null on any network failure instead of throwing.
async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- validation -------------------------------------------------------------

// Confirm a single candidate really exists, then correct it with what the
// verifier reported. Never throws: an unreachable or unprovable candidate is
// simply `false`.
export async function validate(c: Candidate): Promise<boolean> {
  try {
    if (c.kind === "video") {
      // oEmbed is YouTube's own word on the video, so it both proves existence
      // and fixes the title/author a broken search snippet supplied.
      const res = await safeFetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(c.url)}&format=json`
      );
      if (!res || res.status !== 200) return false;
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      const title = clean(data.title);
      if (!title) return false;
      c.title = title;
      c.creator = clean(data.author_name) || c.creator;
      c.image_url = data.thumbnail_url ? String(data.thumbnail_url) : c.image_url;
      return true;
    }

    if (c.kind === "podcast") {
      // A Spotify URL came out of Spotify's own search API, so it is already
      // proven — and open.spotify.com redirects/bot-walls plain GETs, which
      // would only produce a false rejection.
      if (/(^|\.)open\.spotify\.com\//.test(c.url)) return true;
      const res = await safeFetch(c.url, { redirect: "follow" });
      // A redirect is not a failure: the episode exists, the API just moved.
      return !!res && res.status < 400;
    }

    // article / post: fetch it like a browser and require real content.
    const res = await safeFetch(c.url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res || res.status >= 400) return false;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    return type.includes("text/html") || type.includes("application/pdf");
  } catch {
    return false;
  }
}

// --- Tavily (articles + YouTube) --------------------------------------------

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

async function tavily(query: string, topic: "news" | "general"): Promise<TavilyResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic,
        search_depth: "basic",
        max_results: 6,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: TavilyResult[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}

// Recent news for an interest. Structured results, not the formatted string
// searchWeb() returns, because each field is needed separately.
export async function searchArticles(query: string): Promise<Candidate[]> {
  const results = await tavily(query, "news");
  return results
    .filter((r) => r.url && r.title)
    .map((r) => ({
      url: canonicalUrl(String(r.url)),
      kind: "article" as const,
      platform: "web",
      title: clean(r.title),
      creator: null,
      summary: r.content ? clean(r.content, 300) : null,
      published_at: isoDate(r.published_date),
      duration_seconds: null,
      image_url: null,
    }));
}

// Video search, restricted to real watch pages, then confirmed via oEmbed.
export async function searchYouTube(query: string): Promise<Candidate[]> {
  const results = await tavily(`${query} site:youtube.com/watch`, "general");
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of results) {
    const url = String(r.url ?? "").trim();
    const title = clean(r.title);
    if (!url || !title) continue;
    // Tavily happily returns channels, playlists, Shorts and profile pages:
    // none of them is a watchable video, so drop them before validating.
    if (/\/(channel|playlist|shorts|c)\//.test(url) || url.includes("/@")) continue;
    if (/#shorts/i.test(title)) continue;
    // Keep only the bare watch URL so two links to the same video collapse.
    const id = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(url)?.[1];
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      url: canonicalUrl(`https://www.youtube.com/watch?v=${id}`),
      kind: "video",
      platform: "youtube",
      title,
      creator: null,
      summary: r.content ? clean(r.content, 300) : null,
      published_at: isoDate(r.published_date),
      duration_seconds: null,
      image_url: null,
    });
  }

  // Everything that survives the URL filter still has to pass oEmbed, which
  // also replaces the title with YouTube's own.
  const validated: Candidate[] = [];
  for (const c of out.slice(0, 6)) {
    if (await validate(c)) validated.push(c);
  }
  return validated;
}

// --- podcasts (Spotify, else keyless iTunes) --------------------------------

interface SpotifyToken {
  access_token?: string;
}

export interface PodcastSearch {
  candidates: Candidate[];
  // Which path actually ran, so the caller/report can say so.
  source: "spotify" | "itunes";
}

async function spotifyToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SpotifyToken;
    return data.access_token ? String(data.access_token) : null;
  } catch {
    return null;
  }
}

async function spotifyEpisodes(query: string, token: string): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=episode&limit=5&market=AT`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      episodes?: {
        items?: {
          name?: string;
          external_urls?: { spotify?: string };
          duration_ms?: number;
          release_date?: string;
          images?: { url?: string }[];
          show?: { name?: string };
        }[];
      };
    };
    return (data.episodes?.items ?? [])
      .filter((e) => e.external_urls?.spotify && e.name)
      .map((e) => ({
        url: canonicalUrl(String(e.external_urls!.spotify)),
        kind: "podcast" as const,
        platform: "spotify",
        title: clean(e.name),
        creator: e.show?.name ? clean(e.show.name) : null,
        summary: null,
        published_at: isoDate(e.release_date),
        duration_seconds:
          typeof e.duration_ms === "number" ? Math.round(e.duration_ms / 1000) : null,
        image_url: e.images?.[0]?.url ? String(e.images[0].url) : null,
      }));
  } catch {
    return [];
  }
}

async function itunesEpisodes(query: string): Promise<Candidate[]> {
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?media=podcast&entity=podcastEpisode&term=${encodeURIComponent(query)}&limit=5`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: {
        trackName?: string;
        collectionName?: string;
        trackViewUrl?: string;
        trackTimeMillis?: number;
        releaseDate?: string;
        artworkUrl600?: string;
      }[];
    };
    return (data.results ?? [])
      .filter((e) => e.trackViewUrl && e.trackName)
      .map((e) => ({
        url: canonicalUrl(String(e.trackViewUrl)),
        kind: "podcast" as const,
        platform: "apple",
        title: clean(e.trackName),
        creator: e.collectionName ? clean(e.collectionName) : null,
        summary: null,
        published_at: isoDate(e.releaseDate),
        duration_seconds:
          typeof e.trackTimeMillis === "number"
            ? Math.round(e.trackTimeMillis / 1000)
            : null,
        image_url: e.artworkUrl600 ? String(e.artworkUrl600) : null,
      }));
  } catch {
    return [];
  }
}

// Spotify when configured, keyless iTunes otherwise. Reports which one ran.
// The relevance gate is applied by the caller (discoverCandidates), which is
// the only place that also knows the interest text.
export async function searchPodcasts(query: string): Promise<PodcastSearch> {
  const token = await spotifyToken();
  if (token) {
    const episodes = await spotifyEpisodes(query, token);
    return { candidates: episodes, source: "spotify" };
  }
  return { candidates: await itunesEpisodes(query), source: "itunes" };
}

// --- AI news (all keyless) --------------------------------------------------

async function hackerNews(query: string): Promise<Candidate[]> {
  try {
    const res = await safeFetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5&numericFilters=points>50`
    );
    if (!res || !res.ok) return [];
    const data = (await res.json()) as {
      hits?: {
        title?: string;
        url?: string | null;
        created_at?: string;
        objectID?: string;
        author?: string;
      }[];
    };
    const out: Candidate[] = [];
    for (const h of data.hits ?? []) {
      const title = clean(h.title);
      if (!title) continue;
      // Ask-HN style stories have no external URL; link to the discussion.
      const url = h.url ?? (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : "");
      if (!url) continue;
      out.push({
        url: canonicalUrl(url),
        kind: "post",
        platform: "hn",
        title,
        creator: h.author ? clean(h.author) : null,
        summary: null,
        published_at: isoDate(h.created_at),
        duration_seconds: null,
        image_url: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// arXiv only ever answers AI/software questions here. `all:<phrase>` with no
// subject restriction happily returns papers on the muon collider and on
// tensor-to-scalar ratios for a phrase about AI initiative ownership, which is
// why the categories are pinned and why irrelevant interests never query arXiv.
const ARXIV_CATS = "cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.SE";

async function arxiv(query: string): Promise<Candidate[]> {
  try {
    const search = `(${ARXIV_CATS}) AND all:${encodeURIComponent(query)}`;
    const res = await safeFetch(
      `http://export.arxiv.org/api/query?search_query=${search}&sortBy=submittedDate&sortOrder=descending&max_results=5`
    );
    if (!res || !res.ok) return [];
    const xml = await res.text();
    const out: Candidate[] = [];
    // A small regex parse over the Atom entries: arxiv's feed is a stable,
    // flat shape, so a full XML parser would be more machinery than value.
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    for (const entry of entries) {
      const pick = (tag: string): string => {
        const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
        return m ? m[1].replace(/\s+/g, " ").trim() : "";
      };
      const title = clean(pick("title"));
      const url = pick("id");
      if (!title || !url) continue;
      out.push({
        url: canonicalUrl(url),
        kind: "post",
        platform: "arxiv",
        title,
        creator: null,
        summary: pick("summary") ? clean(pick("summary"), 300) : null,
        published_at: isoDate(pick("published")),
        duration_seconds: null,
        image_url: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function bluesky(query: string): Promise<Candidate[]> {
  try {
    const res = await safeFetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=5&sort=top`
    );
    if (!res || !res.ok) return [];
    const data = (await res.json()) as {
      posts?: {
        uri?: string;
        likeCount?: number;
        indexedAt?: string;
        author?: { handle?: string };
        record?: { text?: string };
      }[];
    };
    const out: Candidate[] = [];
    for (const p of data.posts ?? []) {
      // A NOISE FLOOR ONLY — this drops one-like replies, and must never be
      // turned into a ranking input later. Ordering belongs to P3.
      if ((p.likeCount ?? 0) < 2) continue;
      const handle = p.author?.handle;
      const rkey = p.uri?.split("/").pop();
      const text = clean(p.record?.text, 300);
      if (!handle || !rkey || !text) continue;
      out.push({
        url: canonicalUrl(`https://bsky.app/profile/${handle}/post/${rkey}`),
        kind: "post",
        platform: "bluesky",
        title: clean(text, 120),
        creator: handle,
        summary: text,
        published_at: isoDate(p.indexedAt),
        duration_seconds: null,
        image_url: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Tokens that make an interest an AI/software subject. arXiv is skipped
// entirely without one, so tennis or curry never reaches it.
const AI_SOFTWARE_TOKENS = [
  "ai", "ml", "llm", "machine", "learning", "agent", "software", "engineering",
  "automation", "data", "code", "coding",
];

export function isAiSoftwareInterest(interestText: string): boolean {
  const words = new Set(
    String(interestText ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  return AI_SOFTWARE_TOKENS.some((t) => words.has(t));
}

// AI/signal news across three keyless sources, each independently best-effort
// so one outage cannot empty the other two. arXiv is conditional: it is only
// asked when the interest is actually an AI/software subject.
export async function searchAiNews(
  query: string,
  opts: { includeArxiv?: boolean } = {}
): Promise<Candidate[]> {
  const includeArxiv = opts.includeArxiv !== false;
  const [hn, papers, posts] = await Promise.all([
    hackerNews(query),
    includeArxiv ? arxiv(query) : Promise.resolve([] as Candidate[]),
    bluesky(query),
  ]);
  return [...hn, ...papers, ...posts];
}
