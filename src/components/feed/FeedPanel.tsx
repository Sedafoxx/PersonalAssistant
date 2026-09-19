"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SmartLink } from "@/components/SmartLink";

// The Feed tab (P4): the day's ranked shortlist, and nothing else.
//
// Everything the panel renders comes from ONE call to /api/feed — the day's
// items, the saved ones, the interests and the volume preferences — so there is
// no sequencing and no invented default. The counts in the header come from that
// payload; NONE of them are hardcoded in this file.
//
// Deliberate absences: no autoplay (a link opens in a new tab, this app is not a
// player), no infinite scroll, no "load more", no counters and no streaks. The
// list is finite and the saved section is finite, and the empty state is the
// product working rather than an error.

type ItemKind = "article" | "video" | "podcast" | "post";
type Bucket = "growth" | "fun";
type Signal = "save" | "not_for_me" | "done";

interface FeedItem {
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

interface RankedItem {
  item: FeedItem;
  score: number;
  reason: string;
  bucket: Bucket;
  /** The goal the item was attributed to, as the ranker named it. */
  goal: string;
  /** The id of that goal, or null when the model named no active goal. */
  goalId: string | null;
  /** That goal's TITLE, resolved server-side; the group heading. */
  goalTitle: string;
}

interface Shortlist {
  items: RankedItem[];
  minutes: number;
  budgetMinutes: number;
}

interface Interest {
  id: string;
  slug: string | null;
  text: string;
  kind: "topic" | "avoid";
  weight: number;
  queries: string[];
  evidence: string | null;
  source: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface FeedView {
  shortlist: Shortlist;
  saved: FeedItem[];
  interests: Interest[];
  prefs: { daily_count: number; daily_minutes: number };
}

// The per-kind length estimate, mirrored from the ranker: a real duration when
// the source gave one, otherwise the same guess the ranking used. Kept in sync
// so the chip and the header budget never disagree.
function itemMinutes(item: FeedItem): number {
  if (item.duration_seconds && item.duration_seconds > 0) {
    return item.duration_seconds / 60;
  }
  switch (item.kind) {
    case "video":
      return 12;
    case "podcast":
      return 30;
    case "post":
      return 3;
    default:
      return 6;
  }
}

// "18 min video", "1h 05 podcast", "12 min read". The kind is spelled as the
// user reads it, not as the database stores it.
function kindLabel(kind: ItemKind): string {
  switch (kind) {
    case "video":
      return "video";
    case "podcast":
      return "podcast";
    case "post":
      return "post";
    default:
      return "read";
  }
}

function lengthLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return `${h}h ${String(m).padStart(2, "0")}`;
  }
  return `${Math.max(1, Math.round(minutes))} min`;
}

function chipLabel(item: FeedItem): string {
  return `${lengthLabel(itemMinutes(item))} ${kindLabel(item.kind)}`;
}

// A host, shown as a quiet hint of where a link goes. Best-effort: an item with
// an odd URL simply shows no host rather than throwing.
function hostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const BUCKET_STYLE: Record<Bucket, string> = {
  growth: "bg-indigo-500/15 text-indigo-300 border-indigo-500/20",
  fun: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/20",
};

export function FeedPanel() {
  const [view, setView] = useState<FeedView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The cards the user just answered, hidden immediately while the write is in
  // flight. The list is finite and removing an answered card IS the interaction,
  // so this is the optimistic half of it.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  // --- the scrollable pool (P8) -------------------------------------------
  //
  // Separate from the day's shortlist on purpose. The shortlist is today's six
  // curated picks; the pool is every other item that cleared the SAME bar (3+,
  // unanswered), ordered by score. Keeping them apart is what lets the tab be
  // honest: "today's picks" first, then "more of the same quality" — never a
  // prettied-up second helping passed off as a first.
  const [pageItems, setPageItems] = useState<RankedItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [started, setStarted] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreNote, setMoreNote] = useState("");
  const [drained, setDrained] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch("/api/feed");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as FeedView;
      setView(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  // One page of the pool, and then one more when the bottom comes into view.
  //
  // The order matters for cost: page the pool first (free, it is already stored),
  // and only ask for new material when the pool is genuinely empty. /api/feed/more
  // is the only call that can spend money, so it is never on a timer and never on
  // a page turn.
  const loadMore = useCallback(async () => {
    if (moreBusy || drained) return;
    setMoreBusy(true);
    try {
      const wantOffset = started ? nextOffset : 0;

      if (wantOffset !== null) {
        const res = await fetch(`/api/feed?offset=${wantOffset}&limit=12`);
        const data = (await res.json()) as {
          page?: { items: RankedItem[]; nextOffset: number | null; poolSize: number };
        };
        const page = data.page;
        if (!page) {
          setMoreNote("Could not load more right now.");
          return;
        }
        setPageItems((prev) => {
          const seen = new Set(prev.map((p) => p.item.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.item.id))];
        });
        setNextOffset(page.nextOffset);
        setPoolSize(page.poolSize);
        setStarted(true);
        if (page.nextOffset === null) {
          setMoreNote("That is the whole pool above your bar.");
        }
        return;
      }

      // The pool is exhausted, so look for more material. The answer says what it
      // did (judged stored candidates, or ran a real discovery round), and that is
      // shown rather than hidden — it is also the moment money is spent.
      const res = await fetch("/api/feed/more", { method: "POST" });
      const data = (await res.json()) as {
        exhausted?: boolean;
        added?: number;
        discovered?: number;
        detail?: string;
      };
      setMoreNote(data.detail ?? "");

      if (data.exhausted) {
        setDrained(true);
        return;
      }

      const after = await fetch(`/api/feed?offset=${pageItems.length}&limit=12`);
      const afterData = (await after.json()) as {
        page?: { items: RankedItem[]; nextOffset: number | null; poolSize: number };
      };
      const page = afterData.page;
      if (!page || page.items.length === 0) {
        // Nothing new cleared the bar. That is the honest end of the scroll, and it
        // is said plainly rather than filled with something weaker.
        setDrained(true);
        return;
      }
      setPageItems((prev) => {
        const seen = new Set(prev.map((p) => p.item.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.item.id))];
      });
      setNextOffset(page.nextOffset);
      setPoolSize(page.poolSize);
    } catch (err) {
      setMoreNote((err as Error).message);
    } finally {
      setMoreBusy(false);
    }
  }, [moreBusy, drained, started, nextOffset, pageItems.length]);

  // The visible bottom IS the trigger, with a margin so the next page is usually
  // there before it is reached.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // The single write path: every card action is a POST of (item_id, signal).
  // On success the card leaves the list; on failure it comes back with the
  // error, because pretending an answer was recorded is worse than showing it
  // was not.
  const send = useCallback(
    async (itemId: string, signal: Signal) => {
      setAnswered((prev) => new Set(prev).add(itemId));
      try {
        const res = await fetch("/api/feed/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_id: itemId, signal }),
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
      } catch (err) {
        setAnswered((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
        setError((err as Error).message);
      }
    },
    []
  );

  // Removing an interest is a PATCH that sets active=false. The row is never
  // deleted, so this hides the area from the discovery pool without destroying
  // it.
  const removeInterest = useCallback(async (id: string) => {
    try {
      const res = await fetch("/api/feed/interests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active: false }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setView((prev) =>
        prev
          ? { ...prev, interests: prev.interests.filter((i) => i.id !== id) }
          : prev
      );
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // The quiet refresh control: the same daily refresh the cron runs, offered as
  // a text link rather than a button with a badge.
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/feed/refresh", { method: "POST" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      await fetchFeed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, fetchFeed]);

  const items = useMemo(
    () => (view?.shortlist.items ?? []).filter((r) => !answered.has(r.item.id)),
    [view, answered]
  );

  // The shortlist grouped under its goal heading. A goal is the product's unit
  // of judgement, so the day reads as "this serves that goal" rather than as a
  // stream. Groups keep the ranker's order (best score first) and so do the
  // items within a group; a goal appears at the position of its best item.
  const groups = useMemo(() => {
    const byTitle = new Map<string, RankedItem[]>();
    for (const r of items) {
      const title = r.goalTitle || "Everything else";
      const list = byTitle.get(title);
      if (list) list.push(r);
      else byTitle.set(title, [r]);
    }
    return [...byTitle.entries()].map(([title, list]) => ({ title, items: list }));
  }, [items]);

  const minutes = Math.round(view?.shortlist.minutes ?? 0);
  const budgetMinutes = view?.shortlist.budgetMinutes ?? 0;
  const count = items.length;
  const pct =
    budgetMinutes > 0 ? Math.min(100, Math.round((minutes / budgetMinutes) * 100)) : 0;

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="px-4 py-4 pb-16 max-w-xl mx-auto space-y-4">
        {/* Header */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-200">
                {view ? `Your ${count} for today` : "Your feed"}
                {view && (
                  <span className="text-gray-400 font-normal">
                    {" "}
                    · about {minutes} minutes
                  </span>
                )}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Links open in a new tab. Nothing plays on its own.
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Only what scores 3 or more, grouped by the goal it serves.
              </p>
            </div>
          </div>

          {/* Thin budget bar (used / total minutes). */}
          <div className="mt-3 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[11px] text-gray-500 mt-1.5 tabular-nums">
            {minutes} of {budgetMinutes} minutes
          </p>
        </div>

        {error && (
          <div className="bg-red-600/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-300 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button onClick={fetchFeed} className="underline flex-shrink-0">
              Retry
            </button>
          </div>
        )}

        {/* The day's shortlist */}
        <section>
          {loading && !view ? (
            <div className="flex items-center justify-center h-20">
              <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-8 text-center">
              <p className="text-sm text-gray-400">That is everything for today.</p>
              <button
                onClick={refresh}
                disabled={refreshing}
                className="mt-2 text-xs text-gray-500 hover:text-gray-300 underline disabled:opacity-50 transition-colors"
              >
                {refreshing ? "Looking again…" : "Look for more"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.title}>
                  <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
                    {group.title}
                  </h3>
                  <ul className="space-y-2">
                    {group.items.map((r) => (
                      <li key={r.item.id}>
                        <FeedCard
                          ranked={r}
                          onSave={() => send(r.item.id, "save")}
                          onDismiss={() => send(r.item.id, "not_for_me")}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* More of the same quality: the rest of the pool, paged.
            The heading states the count, and the line at the very bottom says
            plainly when there is nothing left above the bar. */}
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
            More, same bar
            {poolSize > 0 && (
              <span className="text-gray-600 normal-case tracking-normal">
                {" "}
                · {pageItems.length} of {poolSize}
              </span>
            )}
          </h3>

          <ul className="space-y-2">
            {pageItems.map((r) => (
              <li key={r.item.id}>
                <FeedCard
                  ranked={r}
                  onSave={() => send(r.item.id, "save")}
                  onDismiss={() => send(r.item.id, "not_for_me")}
                />
              </li>
            ))}
          </ul>

          {/* The trigger. Kept in the DOM while there is more to come. */}
          <div ref={sentinelRef} className="h-6" aria-hidden="true" />

          <p className="text-center text-[11px] text-gray-500 py-2 leading-relaxed">
            {moreBusy
              ? "Looking for more…"
              : !started
                ? ""
                : drained
                  ? "That is everything above your bar. Nothing was padded in."
                  : moreNote || "Keep scrolling for the rest."}
          </p>
        </section>

        {/* Saved — finite on purpose. */}
        {view && view.saved.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
              Saved
            </h3>
            <ul className="space-y-1.5">
              {view.saved.map((item) => (
                <li
                  key={item.id}
                  className="bg-[#1a1a1a] border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <span className="block text-sm text-gray-200 truncate">
                      {item.title}
                    </span>
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                      {chipLabel(item)}
                    </span>
                  </div>
                  {/* Opens in the YouTube/Spotify APP on Android, in the browser
                      everywhere else — see SmartLink. */}
                  <SmartLink
                    href={item.url}
                    className="flex-shrink-0 h-9 px-3 flex items-center rounded-lg bg-white/5 text-gray-300 text-xs font-medium hover:bg-white/10 transition-colors"
                  >
                    Open
                  </SmartLink>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* What I think you are into — quiet, and removable in one tap. */}
        {view && view.interests.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
              What I think you are into
            </h3>
            <ul className="space-y-1.5">
              {view.interests.map((interest) => (
                <li
                  key={interest.id}
                  className="bg-[#1a1a1a] border border-white/10 rounded-xl px-3 py-2.5 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <span
                      className={`block text-sm ${
                        interest.kind === "avoid" ? "text-gray-400 line-through" : "text-gray-200"
                      }`}
                    >
                      {interest.text}
                    </span>
                    {interest.evidence && (
                      <span className="block text-[11px] text-gray-500 mt-0.5 leading-snug">
                        {interest.evidence}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => removeInterest(interest.id)}
                    aria-label={`Remove ${interest.text}`}
                    className="flex-shrink-0 h-9 w-9 flex items-center justify-center rounded-lg text-gray-500 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * One item, readable where it is.
 *
 * THE POINT: a feed of doors is not a feed you can scroll. So a card carries the
 * substance — the coach's reason, and on open the actual text — and only falls back
 * to a plain link when there is genuinely nothing to read (a video's description is
 * a description; playing happens in the app, and saying so is better than an empty
 * reader).
 *
 * The text is fetched ONCE, on first open, and kept server-side, so re-opening costs
 * nothing and the feed stops depending on a live page.
 */
function FeedCard({
  ranked,
  onSave,
  onDismiss,
}: {
  ranked: RankedItem;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { item, reason, bucket, score } = ranked;
  const host = hostLabel(item.url);
  const [reading, setReading] = useState(false);
  const [reader, setReader] = useState<{
    text: string | null;
    source: string;
    chars: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const isMedia = item.kind === "video" || item.kind === "podcast";

  const toggleReader = useCallback(async () => {
    if (reading) {
      setReading(false);
      return;
    }
    setReading(true);
    if (reader) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/feed/text?id=${encodeURIComponent(item.id)}`);
      const data = await res.json();
      setReader({
        text: typeof data.text === "string" ? data.text : null,
        source: String(data.source ?? "unavailable"),
        chars: Number(data.chars ?? 0),
      });
    } catch {
      setReader({ text: null, source: "unavailable", chars: 0 });
    } finally {
      setBusy(false);
    }
  }, [reading, reader, item.id]);

  // Say where the words came from. A snippet is not an article and a description is
  // not a transcript, and calling them what they are costs nothing.
  const sourceLabel = !reader
    ? ""
    : reader.source === "fetched"
      ? "read from the page just now"
      : reader.text && isMedia
        ? "the description — playing happens in the app"
        : reader.text
          ? "the stored snippet; the page itself could not be read (paywall or bot wall)"
          : "this one could not be read here";

  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-3.5">
      <SmartLink
        href={item.url}
        className="block text-sm font-medium text-gray-100 leading-snug hover:text-indigo-300 transition-colors"
      >
        {item.title}
      </SmartLink>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300">
          {chipLabel(item)}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${BUCKET_STYLE[bucket]}`}
        >
          {bucket}
        </span>
        {/* The 1-5 score, as a chip, right beside the bucket tag. */}
        <span
          title={`Scores ${score} of 5 for this goal`}
          className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300 tabular-nums"
        >
          {score}/5
        </span>
        {item.creator && (
          <span className="text-[11px] text-gray-500 truncate">{item.creator}</span>
        )}
        {host && <span className="text-[11px] text-gray-600 truncate">· {host}</span>}
      </div>

      <p className="text-xs text-gray-500 mt-2 leading-snug">because {reason}</p>

      {/* The text itself, in place. */}
      {item.summary && !reading && (
        <p className="text-xs text-gray-400 mt-2 leading-relaxed line-clamp-3">
          {item.summary}
        </p>
      )}

      {reading && (
        <div className="mt-3 border-t border-white/10 pt-3">
          {busy ? (
            <p className="text-xs text-gray-500">Getting the text…</p>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1.5">
                {sourceLabel}
              </p>
              {reader?.text ? (
                <div className="max-h-[60vh] overflow-y-auto pr-1">
                  <p className="text-[13px] text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {reader.text}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  Nothing readable was stored for this one.
                </p>
              )}
              <SmartLink
                href={item.url}
                className="inline-block mt-2 text-[11px] text-indigo-400 underline underline-offset-2"
              >
                {isMedia ? "Open in the app" : "Open the original"}
              </SmartLink>
            </>
          )}
        </div>
      )}

      <div className="flex gap-2 mt-3">
        {/* For a video or a podcast the primary action IS the app handoff, so it has
            to be a real LINK carrying the intent URL. It used to be a button calling
            window.open(item.url) with the plain https URL — which is why tapping it
            always opened the browser even though the title link did the right thing.
            The user hit exactly that. */}
        {isMedia ? (
          <SmartLink
            href={item.url}
            className="flex-1 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors flex items-center justify-center"
          >
            {item.kind === "podcast" ? "Play in the app" : "Watch in the app"}
          </SmartLink>
        ) : (
          <button
            onClick={toggleReader}
            disabled={busy}
            className="flex-1 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {reading ? "Close" : "Read here"}
          </button>
        )}
        {isMedia && item.summary && (
          <button
            onClick={toggleReader}
            disabled={busy}
            className="h-10 px-3 rounded-lg bg-white/5 text-gray-300 text-xs font-medium hover:bg-white/10 transition-colors"
          >
            {reading ? "Hide" : "About"}
          </button>
        )}
        <button
          onClick={onSave}
          className="h-10 px-3 rounded-lg bg-indigo-600/20 text-indigo-200 border border-indigo-500/30 text-xs font-medium hover:bg-indigo-600/30 transition-colors"
        >
          Save
        </button>
        <button
          onClick={onDismiss}
          className="h-10 px-3 rounded-lg bg-white/5 text-gray-400 text-xs font-medium hover:text-gray-200 hover:bg-white/10 transition-colors"
        >
          Not for me
        </button>
      </div>
    </div>
  );
}
