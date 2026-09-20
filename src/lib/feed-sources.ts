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
  /**
   * Popularity, when it is known. NULL means UNKNOWN, never zero: a video whose
   * counts could not be read is judged on its substance, because silently
   * demoting everything unmeasured is how a feed empties itself.
   */
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  channel_name?: string | null;
  channel_subs?: number | null;
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
//
// HERE USED TO LIVE the ingest-time word gate: `isRelevant`, `relevanceTokens`,
// RELEVANCE_STOPWORDS and GENERIC_TOKENS. Deleted 2026-09-20, for two reasons:
//
//   1. NOTHING CALLED IT. Ingest stopped filtering by words at P5 — "the model,
//      not a regex, decides what fits" (see feed.ts, where the batch is pushed
//      with no gate). The only remaining references were its own doc comment and
//      a stale line in the podcast source claiming "the relevance gate is applied
//      by the caller".
//   2. A DEAD GATE IS WORSE THAN NO GATE. Its comment promised that everything
//      unmatched "is dropped as rejectedRelevance", naming Apple's
//      Pickleball-episode-for-a-tennis-query as the case it caught — while nothing
//      was dropping anything. A reader who believed that line would trust a filter
//      that had been switched off years of commits ago.
//
// What actually decides fit is the ranker's judgement (scoreCandidates in
// feed.ts), which is why the suite now counts off-topic survivors as a reported
// smell rather than a code failure. Do not re-add a keyword gate here without
// removing that judgement path first.

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

// --- YouTube: is this video worth anyone's time? -----------------------------
//
// The complaint that produced this (2026-09-20): 81 videos stored, and a
// salary-negotiation video with **2,465 views** sitting at 5/5 — the top of the
// pool — while a 464k-subscriber channel's video sat at 3. The rubric judged the
// TOPIC and never asked whether the video was any good, and an interesting title
// is the cheapest thing on the internet to produce.
//
// Two sources, in order of trust:
//   1. the Data API (exact, needs a free key, covers every video),
//   2. the page text Tavily returns ("2,465 views", "2910 subscribers" — measured
//      at 13 of 81 stored rows, so useful but not sufficient),
//   3. unknown, which stays unknown.

/** "2,465" → 2465, "1.2M" → 1200000, "478K" → 478000, junk → null. Pure. */
export function parseCount(raw: string): number | null {
  const m = String(raw ?? "").replace(/[,\s]/g, "").match(/^([\d.]+)([KMB])?$/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toUpperCase();
  const mult = unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return Math.round(n * mult);
}

export interface YouTubeStats {
  views: number | null;
  likes: number | null;
  subs: number | null;
}

/** The counts YouTube's own page text carries. Pure, so it can be tested. */
export function parseYouTubeStats(text: string): YouTubeStats {
  const s = String(text ?? "");
  const pick = (re: RegExp): number | null => {
    const m = re.exec(s);
    return m ? parseCount(m[1]) : null;
  };
  return {
    views: pick(/([\d.,]+[KMB]?)\s+views?\b/i),
    likes: pick(/([\d.,]+[KMB]?)\s+likes?\b/i),
    subs: pick(/([\d.,]+[KMB]?)\s+subscribers?\b/i),
  };
}

/** ISO-8601 duration ("PT12M30S") → seconds. Pure. */
export function iso8601Seconds(value: string): number | null {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(value ?? ""));
  if (!m) return null;
  const total =
    Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return total > 0 ? total : null;
}

/** The id in a watch URL, or null. Pure. */
export function youTubeId(url: string): string | null {
  return /[?&]v=([A-Za-z0-9_-]{6,})/.exec(String(url ?? ""))?.[1] ?? null;
}

export interface YouTubeFacts extends YouTubeStats {
  duration_seconds: number | null;
  channel_name: string | null;
  comment_count: number | null;
}

/**
 * Exact counts from YouTube Data API v3, in batches of 50 (1 quota unit per
 * batch against 10,000/day, so free in practice).
 *
 * Returns null when YOUTUBE_API_KEY is unset — the caller then falls back to the
 * page text — and never throws: a feed that dies because a statistics call failed
 * is worse than a feed without numbers.
 */
export async function youtubeVideoFacts(
  ids: string[]
): Promise<Record<string, YouTubeFacts> | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !ids.length) return null;
  const out: Record<string, YouTubeFacts> = {};
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const res = await safeFetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet` +
          `&id=${batch.join(",")}&key=${key}`
      );
      if (!res || !res.ok) continue;
      const data = (await res.json()) as {
        items?: {
          id?: string;
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
          contentDetails?: { duration?: string };
          snippet?: { channelTitle?: string; channelId?: string };
        }[];
      };
      const channelIds = new Set<string>();
      for (const item of data.items ?? []) {
        if (!item.id) continue;
        if (item.snippet?.channelId) channelIds.add(item.snippet.channelId);
        out[item.id] = {
          views: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
          likes: item.statistics?.likeCount ? Number(item.statistics.likeCount) : null,
          subs: null,
          duration_seconds: iso8601Seconds(item.contentDetails?.duration ?? ""),
          channel_name: item.snippet?.channelTitle ?? null,
          comment_count: item.statistics?.commentCount ? Number(item.statistics.commentCount) : null,
        };
      }
      if (!channelIds.size) continue;
      // A second call for the channels: subscriber count is the best available
      // signal for "is this a real resource or one person's hobby upload".
      const chRes = await safeFetch(
        `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${[...channelIds].join(",")}&key=${key}`
      );
      if (!chRes || !chRes.ok) continue;
      const chData = (await chRes.json()) as {
        items?: { id?: string; statistics?: { subscriberCount?: string } }[];
      };
      const subsByChannel = new Map<string, number | null>();
      for (const c of chData.items ?? []) {
        subsByChannel.set(c.id ?? "", c.statistics?.subscriberCount ? Number(c.statistics.subscriberCount) : null);
      }
      for (const item of data.items ?? []) {
        const cid = item.snippet?.channelId ?? "";
        if (item.id && subsByChannel.has(cid) && out[item.id]) {
          out[item.id].subs = subsByChannel.get(cid) ?? null;
        }
      }
    }
  } catch {
    // Partial results are still worth keeping.
  }
  return Object.keys(out).length ? out : null;
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

  // Popularity BEFORE validation: a video we know nobody watched should not cost
  // an oEmbed call, and it should never reach the ranker to be argued up to a 3 on
  // the strength of an interesting title.
  const ids = out.map((c) => youTubeId(c.url)).filter((x): x is string => !!x);
  const facts = await youtubeVideoFacts(ids);
  const minViews = Number(process.env.FEED_MIN_VIEWS ?? 2000);
  const enriched: Candidate[] = [];
  let droppedSmall = 0;
  let known = 0;
  for (const c of out) {
    const id = youTubeId(c.url);
    const api = id && facts ? facts[id] : undefined;
    const fromText = parseYouTubeStats(`${c.title} ${c.summary ?? ""}`);
    const view_count = api?.views ?? fromText.views;
    if (view_count != null) known++;
    const item: Candidate = {
      ...c,
      // The API's duration is authoritative. The page text's "[13:39]" is NOT
      // parsed: it collides with timestamps inside transcripts.
      duration_seconds: api?.duration_seconds ?? c.duration_seconds,
      creator: c.creator ?? api?.channel_name ?? null,
      view_count,
      like_count: api?.likes ?? fromText.likes,
      comment_count: api?.comment_count ?? null,
      channel_name: api?.channel_name ?? null,
      channel_subs: api?.subs ?? fromText.subs,
    };
    // THE FLOOR, which is what was asked for: "at least x views". Applied ONLY
    // when the count is known — dropping everything unmeasured would quietly empty
    // the feed instead of filtering it, and an unknown popularity is not evidence
    // of anything. Tune with FEED_MIN_VIEWS.
    if (view_count != null && view_count < minViews) {
      droppedSmall++;
      continue;
    }
    enriched.push(item);
  }
  if (out.length && (droppedSmall || !facts)) {
    console.log(
      `  [feed] youtube: ${known}/${out.length} video(s) had a view count, ${droppedSmall} dropped ` +
        `under ${minViews} views` +
        (facts
          ? ""
          : " — no YOUTUBE_API_KEY, so only the ones whose page text carried a count could be judged")
    );
  }

  // Everything that survives still has to pass oEmbed, which also replaces the
  // title with YouTube's own.
  const validated: Candidate[] = [];
  for (const c of enriched.slice(0, 6)) {
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

/** The episode id inside a Spotify episode link, or null. Pure. */
export function spotifyEpisodeId(url: string): string | null {
  const m = url.match(/open\.spotify\.com\/episode\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// There is deliberately no Apple-episode lookup here. One was written
// (`/lookup?id=<episode id>&entity=podcastEpisode`) and it filled nothing for the 42
// stored Apple rows: a probe answers status 200 with zero results, so the
// id/endpoint pairing is unproven rather than understood. A function that silently
// fills nothing is worse than no function, and those rows are legacy — Spotify is the
// podcast source now, and they leave the pool as newer episodes arrive.

/**
 * Descriptions for episodes the feed ALREADY stored, found by SEARCH.
 *
 * Why not the obvious call: `GET /v1/episodes?ids=` answers **403 Forbidden** for
 * this app. Spotify restricts the episode endpoints to apps with extended access,
 * and a brand-new Development-mode app does not have it. That was verified rather
 * than assumed — the token is issued fine (200), search works, and the bulk endpoint
 * returns `{"error":{"status":403,"message":"Forbidden"}}`. So the description is
 * looked up the way the feed already finds episodes: by search, matched on the
 * episode ID, which is EXACT — no fuzzy title matching and no wrong episode's text.
 *
 * Why it matters at all: podcast rows written before the description was captured
 * have none, and a card with no text is a door, not a post. The first live page of
 * the scroll was six podcasts in a row with nothing to read.
 */
export async function spotifyEpisodeDescriptionsViaSearch(
  items: { episodeId: string; title: string }[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!items.length) return out;
  const token = await spotifyToken();
  if (!token) return out;

  for (const item of items) {
    try {
      const res = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(item.title)}` +
          `&type=episode&limit=10&market=AT`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        episodes?: { items?: { id?: string; description?: string }[] };
      };
      const match = (data.episodes?.items ?? []).find((e) => e.id === item.episodeId);
      const text = match?.description ? clean(match.description, 300) : "";
      if (text) out.set(item.episodeId, text);
    } catch {
      // one failed lookup must not lose the others
    }
  }
  return out;
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
          description?: string;
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
        // The episode description: without it a podcast card is a title and nothing
        // else, since an episode page has no readable body to fetch.
        summary: e.description ? clean(e.description, 300) : null,
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
        description?: string;
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
        summary: e.description ? clean(e.description, 300) : null,
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

// Is the Spotify path actually usable right now?
//
// The one-line answer an operator needs: `searchPodcasts()` silently falls back
// to Apple when the keys are missing OR when the client-credentials token is
// refused, so a feed full of `apple` podcasts looks identical in both cases.
// This asks the question out loud — and it only ever asks the token endpoint
// when BOTH env vars are present. Neither value, nor any part of the token, is
// ever put in the detail: only what happened and, on a failure, the HTTP status.
export async function spotifyStatus(): Promise<{
  configured: boolean;
  token: "ok" | "failed" | "skipped";
  detail: string;
}> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    const missing = [!id && "SPOTIFY_CLIENT_ID", !secret && "SPOTIFY_CLIENT_SECRET"]
      .filter(Boolean)
      .join(", ");
    return {
      configured: false,
      token: "skipped",
      detail: `${missing} not set — podcasts come from keyless Apple (iTunes)`,
    };
  }
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      return {
        configured: true,
        token: "failed",
        detail: `keys set but the token request returned HTTP ${res.status} — falling back to Apple`,
      };
    }
    const data = (await res.json()) as SpotifyToken;
    if (!data.access_token) {
      return {
        configured: true,
        token: "failed",
        detail: "keys set, token request succeeded but returned no access_token",
      };
    }
    return {
      configured: true,
      token: "ok",
      detail: "keys set and a client-credentials token was issued — podcasts come from Spotify",
    };
  } catch {
    // A thrown fetch is a failure like any other; say so, never why with values.
    return {
      configured: true,
      token: "failed",
      detail: "keys set but the token request could not be completed — falling back to Apple",
    };
  }
}

// Spotify when configured, keyless iTunes otherwise. Reports which one ran.
//
// The user's search phrase IS this source's only filter — deliberately. Ingest
// does not pass through a word gate any more (see the note where the old one used
// to be), because a podcast title and an interest label often share no vocabulary
// even when the episode is exactly right ("How to Be Better at Anything" for a
// leadership goal). The ranker's judgement decides, and it is allowed to reject
// these — which is exactly what the "relevance smell" NOTE in feed-test watches.
export async function searchPodcasts(query: string): Promise<PodcastSearch> {
  const token = await spotifyToken();
  if (token) {
    const episodes = await spotifyEpisodes(query, token);
    return { candidates: episodes, source: "spotify" };
  }
  return { candidates: await itunesEpisodes(query), source: "itunes" };
}

// --- AI news (all keyless) --------------------------------------------------

// The concepts the news sources are queried with — deliberately NOT the user's
// interest phrases (P5d rule 1). HN's search matched an interest phrase so
// loosely that a query built from one returned `Launch HN: Satchel (YC S18)` and
// `Tell HN: My early access eBook …`, while the same API asked for an
// architecture phrase returned actual agent-architecture stories. WHERE to look
// is a discovery decision and is curated here in code; WHAT is worth reading
// stays the model's judgement, which is why these are concepts and not a filter.
export const NEWS_CONCEPTS = [
  "agent architecture patterns",
  "LLM evaluation and evals",
  "context engineering and retrieval",
  "prompt engineering in production",
  "AI initiative enterprise adoption",
  "coding agent tooling and MCP",
  "RAG architecture",
  "AI reliability failure postmortems",
];

// The three keyless news sources, named in one place so the ranking path can
// treat them as a group (P5d rule 4: at most 2 of the day's items may be news).
export const NEWS_PLATFORMS = ["hn", "arxiv", "bluesky"] as const;

export function isNewsPlatform(platform: string): boolean {
  return (NEWS_PLATFORMS as readonly string[]).includes(platform);
}

async function hackerNews(query: string): Promise<Candidate[]> {
  try {
    const res = await safeFetch(
      // points>150, not points>50: at 50 the list filled with launch-day posts
      // and weekend experiments, which is exactly what the rubric then has to
      // score down. A well-received story is the floor for being considered.
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=5&numericFilters=points>150`
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
      const discussion = h.objectID
        ? `https://news.ycombinator.com/item?id=${h.objectID}`
        : null;
      // Ask-HN style stories have no external URL; link to the discussion.
      const url = h.url ?? discussion ?? "";
      if (!url) continue;
      out.push({
        url: canonicalUrl(url),
        kind: "post",
        platform: "hn",
        title,
        creator: h.author ? clean(h.author) : null,
        // The comments usually carry the substance of an HN story, and the
        // discussion is a different link from the article, so it rides along in
        // the summary — the one field both the ranker and the UI read. For a
        // story whose URL already IS the discussion there is nothing to add.
        summary: h.url && discussion ? `HN discussion: ${discussion}` : null,
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

// One sweep of the concept list across the three keyless news sources. The
// sweep is INTEREST-INDEPENDENT: it is the same work whoever asks, so without
// the memo below the per-interest, per-query discovery loop would repeat the
// identical sweep for every interest and query of a run. The short TTL keeps a
// long-lived dev server from serving stale news while a cron run still pays for
// the sweep once.
const NEWS_SWEEP_TTL_MS = 10 * 60 * 1000;
const newsSweeps = new Map<string, { at: number; items: Promise<Candidate[]> }>();

function newsSweep(includeArxiv: boolean): Promise<Candidate[]> {
  const key = includeArxiv ? "arxiv" : "no-arxiv";
  const now = Date.now();
  const hit = newsSweeps.get(key);
  if (hit && now - hit.at < NEWS_SWEEP_TTL_MS) return hit.items;

  // Each source is independently best-effort (they never throw), so one outage
  // cannot empty the concepts the other two answered.
  const items = (async () => {
    const out: Candidate[] = [];
    for (const concept of NEWS_CONCEPTS) {
      const [hn, papers, posts] = await Promise.all([
        hackerNews(concept),
        includeArxiv ? arxiv(concept) : Promise.resolve([] as Candidate[]),
        bluesky(concept),
      ]);
      out.push(...hn, ...papers, ...posts);
    }
    return out;
  })();

  newsSweeps.set(key, { at: now, items });
  return items;
}

// AI/signal news across three keyless sources, queried with the curated concept
// list rather than with the caller's interest phrase (P5d rule 1). The `query`
// argument is kept because the caller still decides whether arXiv — pinned to
// the cs categories — is asked at all; it no longer reaches the sources.
export async function searchAiNews(
  query: string,
  opts: { includeArxiv?: boolean } = {}
): Promise<Candidate[]> {
  const includeArxiv = opts.includeArxiv !== false;
  void query;
  return newsSweep(includeArxiv);
}
