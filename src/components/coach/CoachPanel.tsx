"use client";

import { useEffect, useState } from "react";
import { logicalDay } from "@/lib/dates";
import type { Checkin, CheckinKind, DayPlan } from "@/lib/coach";

interface MoodPoint {
  day: string;
  mood: number | null;
}

type Phase =
  | { name: "loading" }
  | { name: "question"; question: string; checkin: Checkin | null }
  | { name: "answered"; checkin: Checkin }
  | { name: "error"; message: string };

// The day the user is living, from the shared rule in dates.ts: before 04:00
// local this is the day that just ended, so opening the Coach tab at 1am still
// shows the day you are actually finishing.
function localDay(): string {
  return logicalDay();
}

// (Mood is no longer picked from buttons here — it is inferred from the
// conversation and recorded through the save_reflection tool.)

function moodColor(m: number | null): string {
  if (m == null) return "bg-white/10";
  return ["", "bg-rose-500", "bg-orange-400", "bg-amber-400", "bg-lime-400", "bg-emerald-400"][m] ?? "bg-white/10";
}

export function CoachPanel() {
  const [kind, setKind] = useState<CheckinKind>("morning");
  const [day] = useState(localDay);
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [focus, setFocus] = useState("");
  const [wentWell, setWentWell] = useState("");
  const [couldImprove, setCouldImprove] = useState("");
  const [feedback, setFeedback] = useState("");
  const [moodHistory, setMoodHistory] = useState<MoodPoint[]>([]);
  const [goals, setGoals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Day planner
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  // Living memory: the maintained fact store, grouped by topic. The assistant
  // may add and update facts but never delete, so "removal" here is a status
  // change the human confirms — and superseded values stay as history.
  type MemFact = {
    id: string;
    topic_id: string;
    key: string;
    value: string;
    status: string;
    pinned: boolean;
    updated_at: string;
  };
  const [memTopics, setMemTopics] = useState<
    { id: string; title: string; summary: string | null }[]
  >([]);
  const [memFacts, setMemFacts] = useState<MemFact[]>([]);
  const [memPending, setMemPending] = useState<MemFact[]>([]);
  const [memHistory, setMemHistory] = useState<Record<string, MemFact[]>>({});
  const [memEditing, setMemEditing] = useState<string | null>(null);
  const [memDraft, setMemDraft] = useState("");
  const [memError, setMemError] = useState<string | null>(null);
  const [wins, setWins] = useState<{
    lines: string[];
    habits_done: number;
    habits_total: number;
    reflection_streak: number;
    todos_completed: number;
    planned: number;
    planned_done: number;
    planned_open: number;
    // Optional: the check-in payload may carry today's XP. Read defensively so
    // the card still renders when the field is absent.
    xp?: number;
  } | null>(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, day]);

  async function load() {
    setPhase({ name: "loading" });
    setFeedback("");
    try {
      const [g, c] = await Promise.all([
        fetch("/api/journal").then((r) => r.json()).catch(() => ({})),
        fetch(`/api/coach/checkin?kind=${kind}&day=${day}`).then((r) => r.json()).catch(() => ({})),
      ]);
      const gl = (g?.goals ?? []) as { title: string }[];
      setGoals(gl.map((x) => x.title));
      fetch("/api/memory")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("memory unavailable"))))
        .then((m) => {
          if (m?.topics) setMemTopics(m.topics);
          if (m?.facts) setMemFacts(m.facts);
          if (m?.pending) setMemPending(m.pending);
        })
        .catch(() => {
          // Best-effort on screen too — the panel must still work without it.
        });
      if (c?.moodHistory) setMoodHistory(c.moodHistory);
      if (c?.wins) setWins(c.wins);
      const ci: Checkin | undefined = c?.checkin;
      if (ci) {
        setMood(ci.mood ?? null);
        setEnergy(ci.energy ?? null);
        setFocus(ci.focus ?? "");
        setWentWell(ci.went_well ?? "");
        setCouldImprove(ci.could_improve ?? "");
        if (ci.answer || ci.status === "done" || ci.status === "skipped" || ci.status === "failed") {
          setPhase({ name: "answered", checkin: ci });
        } else if (ci.question) {
          setPhase({ name: "question", question: ci.question, checkin: ci });
        } else {
          setPhase({ name: "question", question: "What's the one thing you want to move forward today?", checkin: ci });
        }
      } else {
        setPhase({ name: "question", question: "", checkin: ci ?? null });
      }
    } catch {
      setPhase({ name: "error", message: "Couldn't reach the coach — try again in a moment." });
    }
  }

  async function save(extra: Record<string, unknown> = {}) {
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        day,
        mood,
        energy,
        ...extra,
      };
      if (kind === "morning") body.focus = focus;
      if (kind === "evening") {
        body.went_well = wentWell;
        body.could_improve = couldImprove;
      }
      const res = await fetch("/api/coach/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // Surface a server-side failure instead of leaving the UI looking as
      // though nothing happened (the old code swallowed a 500 silently).
      if (!res.ok || !data.checkin) {
        throw new Error(data?.error ?? `Save failed (${res.status})`);
      }
      if (data.checkin) setPhase({ name: "answered", checkin: data.checkin });
      if (data.moodHistory) setMoodHistory(data.moodHistory);
    } catch {
      setPhase({ name: "error", message: "Save failed — please retry." });
    } finally {
      setSaving(false);
    }
  }

  // (The mood/focus/reflection form is gone: check-ins and the reflection happen
  // in the conversation now. See the hand-off card in the render below.)

  async function resolveAction(status: "done" | "skipped" | "failed") {
    const extra: Record<string, unknown> = { status };
    if (kind === "evening" && status === "done") extra.went_well = wentWell;
    if (feedback.trim()) extra.feedback = feedback;
    await save(extra);
    load();
  }

  // --- day planner ---
  async function loadPlan(fresh = false) {
    setPlanLoading(true);
    setPlanMsg(null);
    try {
      const res = await fetch(`/api/coach/plan-day?day=${day}${fresh ? "&fresh=1" : ""}`);
      const data = await res.json();
      if (data.plan) {
        setPlan(data.plan);
        // default: select everything except breaks and already-fixed events
        setSelected(
          new Set(
            (data.plan.blocks as DayPlan["blocks"])
              .map((b, i) => (b.type === "break" || b.type === "event" ? -1 : i))
              .filter((i) => i >= 0)
          )
        );
      }
    } catch {
      setPlanMsg("Could not build a plan — try again.");
    } finally {
      setPlanLoading(false);
    }
  }

  function toggleBlock(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function applySelected(asCalendar: boolean, asTodos: boolean) {
    if (!plan || applying) return;
    const blocks = plan.blocks.filter((_, i) => selected.has(i));
    if (blocks.length === 0) {
      setPlanMsg("Select at least one block first.");
      return;
    }
    setApplying(true);
    setPlanMsg(null);
    try {
      const res = await fetch("/api/coach/plan-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, blocks, asCalendar, asTodos }),
      });
      const data = await res.json();
      if (data.ok) {
        const bits = [];
        if (data.events) bits.push(`${data.events} to calendar`);
        if (data.todos) bits.push(`${data.todos} as todos`);
        setPlanMsg(`Added ${bits.join(" and ") || "nothing"} ✓`);
      } else {
        setPlanMsg(data.error ?? "Could not apply.");
      }
    } catch {
      setPlanMsg("Could not apply — try again.");
    } finally {
      setApplying(false);
    }
  }

  // --- living memory (the human override) ---------------------------------

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
        setMemError(data?.error ?? `Request failed (${res.status})`);
        return;
      }
      if (data?.topics) setMemTopics(data.topics);
      if (data?.facts) setMemFacts(data.facts);
      if (data?.pending) setMemPending(data.pending);
      setMemError(null);
      setMemEditing(null);
    } catch {
      setMemError("Could not update memory — try again.");
    }
  }

  // Superseded values are fetched on demand: most of the time the user does not
  // care what a fact used to say, but when they do, it must be there.
  async function toggleMemoryHistory(topicId: string) {
    if (memHistory[topicId]) {
      setMemHistory((prev) => {
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
        setMemHistory((prev) => ({ ...prev, [topicId]: data.history }));
      }
    } catch {
      setMemError("Could not load the earlier values.");
    }
  }

  const cur: Checkin | null | undefined =
    phase.name === "question" || phase.name === "answered" ? phase.checkin : undefined;

  return (
    <div className="h-full overflow-y-auto relative">
      <div className="px-4 py-4 space-y-4 pb-10 max-w-xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">🎯 Coach</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(day + "T00:00:00").toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </p>
          </div>
          <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
            {(["morning", "evening"] as CheckinKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                  kind === k ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {k === "morning" ? "🌅 Morning" : "🌙 Evening"}
              </button>
            ))}
          </div>
        </div>

        {/* Mood sparkline */}
        {moodHistory.length > 0 && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
              Mood — last {moodHistory.length} days
            </p>
            <div className="flex items-end gap-1.5 h-16">
              {moodHistory.map((p) => (
                <div key={p.day} className="flex-1 flex flex-col items-center gap-1" title={`${p.day} · ${p.mood ?? "–"}/5`}>
                  <div
                    className={`w-full rounded ${moodColor(p.mood)}`}
                    style={{
                      height: p.mood == null ? "4px" : `${(p.mood / 5) * 100}%`,
                      minHeight: "4px",
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Goals strip */}
        {goals.length > 0 && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">Goals for today</p>
            <div className="flex flex-wrap gap-1.5">
              {goals.map((g) => (
                <span
                  key={g}
                  className="text-[11px] px-2.5 py-1 rounded-full bg-indigo-600/15 border border-indigo-500/25 text-indigo-200"
                >
                  {g}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Progress card (evening wrap-up) */}
        {kind === "evening" && wins && (
          <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">📊 Progress today</p>
            {wins.planned > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-100 tabular-nums">
                    {wins.planned_done} of {wins.planned} planned tasks done
                  </p>
                  <p className="text-xs text-gray-400 tabular-nums">
                    {wins.planned - wins.planned_done} left
                  </p>
                </div>
                <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-indigo-500"
                    style={{
                      width: `${Math.round((wins.planned_done / wins.planned) * 100)}%`,
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                  {wins.xp != null && (
                    <span className="tabular-nums">⚡ {wins.xp} XP earned today</span>
                  )}
                  {wins.reflection_streak > 0 && (
                    <span className="tabular-nums">
                      🔥 {wins.reflection_streak}-day reflection streak
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400">
                  {wins.planned_open > 0 ? (
                    <span className="text-amber-300">
                      {wins.planned_open} still open and needed before the day ends
                    </span>
                  ) : (
                    <span className="text-emerald-300">Nothing left that needs doing today ✓</span>
                  )}
                </p>
              </>
            ) : (
              <p className="text-xs text-gray-400">
                Nothing was planned for today — that is fine. Every day is a fresh start.
              </p>
            )}
            <button
              onClick={() => {
                window.location.href = "/?tab=chat&mode=coach";
              }}
              className="w-full h-11 rounded-full bg-amber-600 hover:bg-amber-500 text-xs font-medium transition-colors"
            >
              Reflect with the coach →
            </button>
          </div>
        )}

        {/* Daily wins / habits */}
        {wins && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] uppercase tracking-wide text-gray-500">🌟 Wins today</p>
              <p className="text-[10px] text-gray-600">
                {wins.habits_done}/{wins.habits_total} habits
                {wins.reflection_streak > 1 ? ` · 🔥 ${wins.reflection_streak}` : ""}
              </p>
            </div>
            {wins.lines.length > 0 ? (
              <div className="space-y-1">
                {wins.lines.map((l, i) => (
                  <p key={i} className="text-xs text-gray-300">
                    {l}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-600">
                Nothing logged yet today — small wins count. Journal, tick a habit, or finish your coach action.
              </p>
            )}
          </div>
        )}

        {/* Living memory — maintained facts, grouped by topic, human-editable */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              🧠 What I remember
            </p>
            <p className="text-[10px] text-gray-600">
              {memFacts.length} fact{memFacts.length === 1 ? "" : "s"} ·{" "}
              {memTopics.length} topic{memTopics.length === 1 ? "" : "s"}
            </p>
          </div>

          {memError && <p className="text-xs text-red-300">{memError}</p>}

          {memPending.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
              <p className="text-[11px] text-amber-200 font-medium">
                The coach proposed removing {memPending.length} fact
                {memPending.length === 1 ? "" : "s"} — it never deletes on its own
              </p>
              {memPending.map((f) => (
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

          {memTopics.length === 0 ? (
            <p className="text-xs text-gray-600">
              Nothing maintained yet. Tell the coach something concrete and it will
              keep it current from then on.
            </p>
          ) : (
            memTopics.map((t) => {
              const facts = memFacts.filter((f) => f.topic_id === t.id);
              const hist = memHistory[t.id];
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

                  {facts.length === 0 ? (
                    <p className="text-xs text-gray-600 mt-1.5">No live facts right now.</p>
                  ) : (
                    <div className="mt-1.5 space-y-1">
                      {facts.map((f) =>
                        memEditing === f.id ? (
                          <div key={f.id} className="flex items-center gap-2">
                            <span className="text-xs text-gray-500 flex-shrink-0">
                              {f.key}:
                            </span>
                            <input
                              value={memDraft}
                              onChange={(e) => setMemDraft(e.target.value)}
                              className="flex-1 min-w-0 bg-transparent text-xs text-gray-100 border border-white/10 rounded-md px-2 py-2 outline-none focus:border-indigo-500/50"
                            />
                            <button
                              onClick={() => patchFact({ id: f.id, value: memDraft })}
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
                                setMemEditing(f.id);
                                setMemDraft(f.value);
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
                    onClick={() => toggleMemoryHistory(t.id)}
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
        </div>

        {/* Plan my day */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">🗓️ Plan my day</p>
            <button
              onClick={() => loadPlan(!!plan)}
              disabled={planLoading || applying}
              className="text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-40"
            >
              {planLoading ? "thinking…" : plan ? "regenerate" : ""}
            </button>
          </div>

          {!plan && (
            <button
              onClick={() => loadPlan(false)}
              disabled={planLoading}
              className="w-full h-9 rounded-full bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-xs font-medium transition-colors"
            >
              {planLoading ? "Building your day…" : "Build my day plan"}
            </button>
          )}

          {plan && (
            <>
              <div>
                <p className="text-sm text-gray-200 font-medium">{plan.headline}</p>
              </div>
              <div className="space-y-1">
                {plan.blocks.map((b, i) => {
                  const isFixed = b.type === "break" || b.type === "event";
                  const on = selected.has(i) || isFixed;
                  return (
                    <button
                      key={i}
                      onClick={() => !isFixed && toggleBlock(i)}
                      className={`w-full flex items-start gap-2.5 text-left py-1.5 rounded-lg px-2 transition-colors ${
                        isFixed ? "opacity-70" : "hover:bg-white/5"
                      }`}
                    >
                      <span
                        className={`w-4 h-4 mt-0.5 rounded-md border flex-shrink-0 flex items-center justify-center text-[10px] ${
                          on ? "bg-emerald-600 border-emerald-500 text-white" : "border-white/20"
                        }`}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="text-xs text-gray-400 tabular-nums mr-2">
                          {b.start}–{b.end}
                        </span>
                        <span className={`text-sm ${b.type === "break" ? "text-gray-500 italic" : "text-gray-100"}`}>
                          {b.title}
                        </span>
                        {(b.goal || b.why) && (
                          <span className="block text-[11px] text-gray-500 mt-0.5 truncate">
                            {b.goal ? `🎯 ${b.goal}` : ""}
                            {b.goal && b.why ? " · " : ""}
                            {b.why}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              {plan.note && <p className="text-xs text-gray-500">{plan.note}</p>}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => applySelected(true, false)}
                  disabled={applying}
                  className="flex-1 h-9 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium transition-colors"
                >
                  {applying ? "…" : "Add to calendar"}
                </button>
                <button
                  onClick={() => applySelected(false, true)}
                  disabled={applying}
                  className="flex-1 h-9 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 text-xs font-medium transition-colors"
                >
                  {applying ? "…" : "Add as todos"}
                </button>
              </div>
              {planMsg && <p className="text-xs text-emerald-300">{planMsg}</p>}
            </>
          )}
        </div>

        {/* The check-in is a conversation now, not a form */}
        {phase.name === "question" && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              {kind === "morning" ? "Your morning" : "Your evening"}
            </p>
            <p className="text-sm text-gray-100 leading-relaxed">
              {phase.question || "What's the one thing you want to move forward today?"}
            </p>
            <p className="text-xs text-gray-500 leading-relaxed">
              Mood, energy and the reflection all happen in the conversation now — say it
              however you like and it gets recorded and tracked for you.
            </p>
            <button
              onClick={() => {
                window.location.href =
                  kind === "evening" ? "/?tab=chat&prompt=reflection" : "/?tab=chat";
              }}
              className="w-full h-11 rounded-full bg-indigo-600 hover:bg-indigo-500 text-xs font-medium transition-colors"
            >
              {kind === "evening"
                ? "Do my reflection in the conversation →"
                : "Answer in the conversation →"}
            </button>
          </div>
        )}

        {/* Phase: answered (action + resolve) */}
        {phase.name === "answered" && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              {kind === "morning" ? "Suggested for today" : "Wrapped up"}
            </p>
            <div>
              <p className="text-sm text-gray-200 leading-relaxed">{cur?.question}</p>
              {cur?.next_action && (
                <div className="mt-3 bg-indigo-600/10 border border-indigo-500/25 rounded-lg px-3 py-2.5">
                  <p className="text-sm text-indigo-100 font-medium">{cur.next_action}</p>
                  {cur.next_action_domain && (
                    <span className="inline-block mt-1.5 text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-gray-300 capitalize">
                      {cur.next_action_domain}
                    </span>
                  )}
                </div>
              )}
            </div>

            {(cur?.status === "proposed" || cur?.status == null) && (
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => resolveAction("done")}
                  disabled={saving}
                  className="flex-1 h-9 rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-xs font-medium transition-colors"
                >
                  {saving ? "…" : "Done ✓"}
                </button>
                <button
                  onClick={() => resolveAction("skipped")}
                  disabled={saving}
                  className="flex-1 h-9 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 text-xs font-medium transition-colors"
                >
                  Skip
                </button>
              </div>
            )}

            {kind === "evening" && (cur?.status === "done" || cur?.status === "skipped") && (
              <p className="text-xs text-gray-500 text-center">
                {cur?.status === "done" ? "Nice — logged ✓" : "Skipped — no problem."} See you tomorrow.
              </p>
            )}

            {cur?.status !== "done" && cur?.status !== "skipped" && kind === "evening" && (
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1.5">
                  Anything you would want the coach to change? (optional)
                </label>
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  rows={1}
                  placeholder="e.g. too much at once, or great suggestion…"
                  className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none border border-white/10 rounded-lg px-3 py-2 focus:border-indigo-500/50 transition-colors leading-relaxed"
                />
              </div>
            )}

            <button
              onClick={() => setKind(kind === "morning" ? "evening" : "morning")}
              className="w-full text-xs text-gray-500 hover:text-gray-300"
            >
              {kind === "morning" ? "Skip to evening check-in →" : "← Back to morning"}
            </button>
          </div>
        )}

        {/* Phase: error */}
        {phase.name === "error" && (
          <div className="bg-red-600/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
            {phase.message}
            <button onClick={load} className="mt-2 block text-xs underline">
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
