"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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
            <ul className="space-y-2">
              {items.map((r) => (
                <li key={r.item.id}>
                  <FeedCard
                    ranked={r}
                    onOpen={() => window.open(r.item.url, "_blank", "noopener,noreferrer")}
                    onSave={() => send(r.item.id, "save")}
                    onDismiss={() => send(r.item.id, "not_for_me")}
                  />
                </li>
              ))}
            </ul>
          )}
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
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0 h-9 px-3 flex items-center rounded-lg bg-white/5 text-gray-300 text-xs font-medium hover:bg-white/10 transition-colors"
                  >
                    Open
                  </a>
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

function FeedCard({
  ranked,
  onOpen,
  onSave,
  onDismiss,
}: {
  ranked: RankedItem;
  onOpen: () => void;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const { item, reason, bucket } = ranked;
  const host = hostLabel(item.url);

  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-3.5">
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-sm font-medium text-gray-100 leading-snug hover:text-indigo-300 transition-colors"
      >
        {item.title}
      </a>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300">
          {chipLabel(item)}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${BUCKET_STYLE[bucket]}`}
        >
          {bucket}
        </span>
        {item.creator && (
          <span className="text-[11px] text-gray-500 truncate">{item.creator}</span>
        )}
        {host && <span className="text-[11px] text-gray-600 truncate">· {host}</span>}
      </div>

      <p className="text-xs text-gray-500 mt-2 leading-snug">because {reason}</p>

      <div className="flex gap-2 mt-3">
        <button
          onClick={onOpen}
          className="flex-1 h-10 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
        >
          Open
        </button>
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
