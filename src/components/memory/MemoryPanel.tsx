"use client";

import { useCallback, useEffect, useState } from "react";

// "What I remember" — the human override for living memory.
//
// This used to live inside the Coach tab, which is where the assistant's
// notebook happened to be rendered. When the Coach tab was removed, the notebook
// had to survive it: this is the ONLY screen where the user can read what Nova
// knows, correct a value, pin a fact so the assistant stops overwriting it, or
// confirm a removal the assistant proposed. Losing it would have left the memory
// system without a human check — the assistant would write and nothing could
// argue back.
//
// It now lives in the Stats tab (the "record" tab), which is a better home
// anyway: this is not coaching, it is data.
//
// The assistant can add and update facts but NEVER delete them, so nothing here
// is a destructive action: "retire" is a status change that keeps the row, and
// the earlier values stay readable behind "show earlier values".

interface MemFact {
  id: string;
  topic_id: string;
  key: string;
  value: string;
  status: string;
  pinned: boolean;
  updated_at: string;
}

interface MemTopic {
  id: string;
  title: string;
  summary: string | null;
}

export function MemoryPanel() {
  const [topics, setTopics] = useState<MemTopic[]>([]);
  const [facts, setFacts] = useState<MemFact[]>([]);
  const [pending, setPending] = useState<MemFact[]>([]);
  const [history, setHistory] = useState<Record<string, MemFact[]>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setTopics(data?.topics ?? []);
      setFacts(data?.facts ?? []);
      setPending(data?.pending ?? []);
      setError(null);
    } catch {
      // Best-effort on screen: the panel must render even when the store is
      // unreachable, it just says so.
      setError("Could not load memory right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // One write path for edit / pin / retire / resolve-a-proposal. The route
  // returns the refreshed store, so the card never drifts from the server.
  async function patchFact(body: Record<string, unknown>) {
    try {
      const res = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      if (data?.topics) setTopics(data.topics);
      if (data?.facts) setFacts(data.facts);
      if (data?.pending) setPending(data.pending);
      setError(null);
      setEditing(null);
    } catch {
      setError("Could not update memory — try again.");
    }
  }

  // Superseded values are fetched on demand: most of the time the user does not
  // care what a fact used to say, but when they do, it must be there.
  async function toggleHistory(topicId: string) {
    if (history[topicId]) {
      setHistory((prev) => {
        const next = { ...prev };
        delete next[topicId];
        return next;
      });
      return;
    }
    try {
      const res = await fetch(`/api/memory?topic_id=${encodeURIComponent(topicId)}`);
      const data = await res.json();
      if (data?.history) {
        setHistory((prev) => ({ ...prev, [topicId]: data.history }));
      }
    } catch {
      setError("Could not load the earlier values.");
    }
  }

  return (
    <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-gray-500">
          🧠 What I remember
        </p>
        <p className="text-[10px] text-gray-600">
          {facts.length} fact{facts.length === 1 ? "" : "s"} · {topics.length} topic
          {topics.length === 1 ? "" : "s"}
        </p>
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {pending.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
          <p className="text-[11px] text-amber-200 font-medium">
            Nova proposed removing {pending.length} fact
            {pending.length === 1 ? "" : "s"} — it never deletes on its own
          </p>
          {pending.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-xs text-gray-300 truncate">
                {f.key}: {f.value}
              </span>
              <button
                onClick={() => patchFact({ id: f.id, status: "superseded" })}
                className="h-10 px-3 rounded-full bg-red-500/20 text-red-200 text-xs font-medium"
              >
                Remove
              </button>
              <button
                onClick={() => patchFact({ id: f.id, status: "active" })}
                className="h-10 px-3 rounded-full bg-white/10 text-gray-200 text-xs font-medium"
              >
                Keep
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && topics.length === 0 ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : topics.length === 0 ? (
        <p className="text-xs text-gray-600">
          Nothing maintained yet. Tell me something concrete and I will keep it
          current from then on.
        </p>
      ) : (
        topics.map((t) => {
          const live = facts.filter((f) => f.topic_id === t.id);
          const hist = history[t.id];
          const retired = hist ? hist.filter((f) => f.status === "superseded") : [];
          return (
            <div
              key={t.id}
              className="border-t border-white/5 pt-3 first:border-0 first:pt-0"
            >
              <p className="text-xs font-semibold text-gray-200">{t.title}</p>
              {t.summary && (
                <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
                  {t.summary}
                </p>
              )}

              {live.length === 0 ? (
                <p className="text-xs text-gray-600 mt-1.5">No live facts right now.</p>
              ) : (
                <div className="mt-1.5 space-y-1">
                  {live.map((f) =>
                    editing === f.id ? (
                      <div key={f.id} className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 flex-shrink-0">
                          {f.key}:
                        </span>
                        <input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          className="flex-1 min-w-0 bg-transparent text-xs text-gray-100 border border-white/10 rounded-md px-2 py-2 outline-none focus:border-indigo-500/50"
                        />
                        <button
                          onClick={() => patchFact({ id: f.id, value: draft })}
                          className="h-10 px-3 rounded-full bg-indigo-600 text-white text-xs font-medium"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <div key={f.id} className="flex items-center gap-1">
                        <span className="flex-1 min-w-0 text-xs text-gray-300 truncate">
                          <span className="text-gray-500">{f.key}:</span> {f.value}
                          {f.pinned && (
                            <span className="ml-1.5 text-[10px] text-amber-300">
                              pinned
                            </span>
                          )}
                        </span>
                        <button
                          onClick={() => {
                            setEditing(f.id);
                            setDraft(f.value);
                          }}
                          className="h-10 px-2 text-xs text-gray-400"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => patchFact({ id: f.id, pinned: !f.pinned })}
                          className="h-10 px-2 text-xs text-gray-400"
                        >
                          {f.pinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          onClick={() => patchFact({ id: f.id, status: "superseded" })}
                          className="h-10 px-2 text-xs text-gray-500"
                        >
                          Retire
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}

              <button
                onClick={() => toggleHistory(t.id)}
                className="mt-1 text-[10px] text-gray-600"
              >
                {hist
                  ? `hide earlier values${retired.length ? ` (${retired.length})` : ""}`
                  : "show earlier values"}
              </button>
              {hist && retired.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  {retired.map((f) => (
                    <p key={f.id} className="text-[10px] text-gray-600">
                      {f.key}: {f.value} · retired{" "}
                      {new Date(f.updated_at).toLocaleDateString()}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
