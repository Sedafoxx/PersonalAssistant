"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { STAT_KEYS, type StatKey } from "@/lib/stats";

// The Stats tab: milestones CRUD per active goal plus a hand-rolled metrics
// dashboard (SVG / CSS only — no chart dependency). One call to
// /api/stats/overview on mount, with explicit loading + error states so the
// panel never renders against undefined data.

interface Milestone {
  id: string;
  goal_id: string;
  title: string;
  target_date: string | null;
  position: number;
  done: boolean;
  done_at: string | null;
  created_at: string;
}

interface GoalWithMilestones {
  id: string;
  title: string;
  description: string | null;
  cadence: string | null;
  target: number | null;
  progress: number;
  status: string;
  created_at: string;
  updated_at: string;
  milestones: Milestone[];
}

interface Overview {
  life: {
    totalXp: number;
    level: number;
    xpIntoLevel: number;
    xpForNextLevel: number;
    streak: number;
    statTotals: Record<StatKey, number>;
    entryCount: number;
    tasksXp: number;
    tasksCompleted: number;
  };
  journalStreak: number;
  reflectionStreak: number;
  goals: GoalWithMilestones[];
  taskTrend: { day: string; planned: number; done: number }[];
  mood: { day: string; mood: number | null }[];
  today: { planned: number; done: number };
  movementToday: DayMovement;
}

interface GoalMovement {
  goal_id: string;
  goal_title: string;
  tasks_done: number;
  tasks_open: number;
  milestones_done: number;
}

interface DayMovement {
  day: string;
  goals: GoalMovement[];
  goalsMoved: number;
  tasksDone: number;
  milestonesDone: number;
}

const STAT_META: Record<StatKey, { label: string; color: string }> = {
  health: { label: "Health", color: "bg-rose-500" },
  focus: { label: "Focus", color: "bg-indigo-500" },
  social: { label: "Social", color: "bg-amber-500" },
  creativity: { label: "Creativity", color: "bg-fuchsia-500" },
  discipline: { label: "Discipline", color: "bg-emerald-500" },
};

const MOOD_EMOJI = ["", "😞", "🙁", "😐", "🙂", "😄"];

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function StatsPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/stats/overview");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json()) as Overview;
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="px-4 py-4 max-w-xl mx-auto">
          <div className="bg-red-600/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
            <p>Could not load your stats: {error}</p>
            <button
              onClick={() => {
                setLoading(true);
                fetchOverview();
              }}
              className="mt-2 text-xs underline"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { life } = data;
  const xpPct =
    life.xpForNextLevel > 0
      ? Math.round((life.xpIntoLevel / life.xpForNextLevel) * 100)
      : 0;
  const maxStat = Math.max(1, ...STAT_KEYS.map((k) => life.statTotals[k] ?? 0));
  const maxTrend = Math.max(1, ...data.taskTrend.map((t) => Math.max(t.planned, t.done)));

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="px-4 py-4 pb-16 max-w-xl mx-auto space-y-4">
        {/* Level + XP */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-indigo-300">Lv {life.level}</span>
              <span className="text-xs text-gray-500">{life.totalXp} XP total</span>
            </div>
            <span className="text-xs text-gray-500 tabular-nums">
              {life.xpIntoLevel}/{life.xpForNextLevel} to next
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
              style={{ width: `${xpPct}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Metric label="Todo XP" value={life.tasksXp} />
            <Metric label="Todos done" value={life.tasksCompleted} />
            <Metric label="Entries" value={life.entryCount} />
          </div>
        </section>

        {/* Streaks */}
        <section className="grid grid-cols-2 gap-3">
          <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 text-center">
            <p className="text-2xl">🔥</p>
            <p className="text-2xl font-bold text-amber-300 tabular-nums">
              {data.journalStreak}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">Journal streak</p>
          </div>
          <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 text-center">
            <p className="text-2xl">🌙</p>
            <p className="text-2xl font-bold text-indigo-300 tabular-nums">
              {data.reflectionStreak}
            </p>
            <p className="text-[11px] text-gray-500 mt-0.5">Reflection streak</p>
          </div>
        </section>

        {/* Today at a glance */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
            Today — planned vs done
          </p>
          <p className="text-sm text-gray-300">
            <span className="font-semibold text-indigo-300 tabular-nums">
              {data.today.done}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-gray-200 tabular-nums">
              {data.today.planned}
            </span>{" "}
            tasks complete.
          </p>
        </section>

        {/* Moved forward today — across life dimensions */}
        <MovementToday movement={data.movementToday} />
        {/* Milestones */}
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
            Goals and milestones
          </h3>
          {data.goals.length === 0 ? (
            <div className="bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-8 text-center">
              <p className="text-sm text-gray-500">No active goals yet.</p>
              <p className="text-xs text-gray-600 mt-1">
                Add milestones once a goal exists to break it into steps.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.goals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  onChanged={fetchOverview}
                />
              ))}
            </div>
          )}
        </section>

        {/* Planned vs done — 14 days */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              Planned vs done — 14 days
            </p>
            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-indigo-500" />
                planned
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                done
              </span>
            </div>
          </div>
          {data.taskTrend.length === 0 ? (
            <p className="text-xs text-gray-600">No task activity in this window.</p>
          ) : (
            <>
              <div className="flex items-end gap-1 h-24">
                {data.taskTrend.map((t) => (
                  <div
                    key={t.day}
                    className="flex-1 flex items-end justify-center gap-0.5 h-full"
                    title={`${t.day} · planned ${t.planned}, done ${t.done}`}
                  >
                    <div
                      className="w-1/2 bg-indigo-500/70 rounded-t"
                      style={{ height: `${(t.planned / maxTrend) * 100}%`, minHeight: "2px" }}
                    />
                    <div
                      className="w-1/2 bg-emerald-500/80 rounded-t"
                      style={{ height: `${(t.done / maxTrend) * 100}%`, minHeight: "2px" }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1 text-[10px] text-gray-600">
                <span>{shortDay(data.taskTrend[0].day)}</span>
                <span>{shortDay(data.taskTrend[data.taskTrend.length - 1].day)}</span>
              </div>
              <p className="mt-2 text-xs text-gray-500 tabular-nums">
                {data.taskTrend.reduce((s, t) => s + t.planned, 0)} planned ·{" "}
                {data.taskTrend.reduce((s, t) => s + t.done, 0)} done over 14 days.
              </p>
            </>
          )}
        </section>

        {/* Life stats */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-3">
            Life stats
          </p>
          <div className="space-y-2">
            {STAT_KEYS.map((k) => {
              const v = life.statTotals[k] ?? 0;
              const w = Math.round((v / maxStat) * 100);
              return (
                <div key={k} className="flex items-center gap-2">
                  <span className="w-20 text-xs text-gray-400">{STAT_META[k].label}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className={`h-full ${STAT_META[k].color} transition-all`}
                      style={{ width: `${w}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-xs text-gray-500 tabular-nums">
                    {v}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {/* Mood */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              Mood — last 14 days
            </p>
            <span className="text-[10px] text-gray-500">1 😞 → 5 😄</span>
          </div>
          {data.mood.length === 0 ? (
            <p className="text-xs text-gray-600">No mood check-ins yet.</p>
          ) : (
            <>
              <MoodLine mood={data.mood} />
              <div className="flex justify-between mt-1 text-[10px] text-gray-600">
                <span>{shortDay(data.mood[0].day)}</span>
                <span>{shortDay(data.mood[data.mood.length - 1].day)}</span>
              </div>
              <p className="mt-2 text-xs text-gray-500 tabular-nums">
                {data.mood.filter((m) => m.mood != null).length} of {data.mood.length} days
                logged
                {(() => {
                  const logged = data.mood.filter((m) => m.mood != null);
                  if (logged.length === 0) return "";
                  const avg =
                    logged.reduce((s, m) => s + (m.mood ?? 0), 0) / logged.length;
                  return ` · average ${avg.toFixed(1)} ${MOOD_EMOJI[Math.round(avg)] ?? ""}`;
                })()}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Plain-text rendering of a goal's counts — the accessible fallback so the
// numbers stay readable without relying on the coloured chips.
function movementSummary(g: GoalMovement): string {
  const parts: string[] = [];
  if (g.tasks_done > 0) parts.push(`${g.tasks_done} done`);
  if (g.tasks_open > 0) parts.push(`${g.tasks_open} open`);
  if (g.milestones_done > 0) parts.push(plural(g.milestones_done, "milestone"));
  return `${g.goal_title}: ${parts.join(", ")}`;
}

const CHIP_TONES = {
  done: "bg-emerald-500/15 text-emerald-300",
  open: "bg-white/10 text-gray-400",
  milestone: "bg-indigo-500/15 text-indigo-300",
} as const;

function Chip({
  tone,
  children,
}: {
  tone: keyof typeof CHIP_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] tabular-nums ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

// Which parts of life moved today — one compact, full-width row per goal, so
// the counts read at a glance on a phone. Only non-zero counts render as chips,
// the list is capped so it stays scannable, and every row has a text fallback.
const MOVEMENT_CAP = 6;

function MovementToday({ movement }: { movement: DayMovement }) {
  const shown = movement.goals.slice(0, MOVEMENT_CAP);
  const hidden = Math.max(0, movement.goals.length - shown.length);

  return (
    <section className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
        Moved forward today
      </p>

      {movement.goalsMoved === 0 ? (
        <p className="text-sm text-gray-400">
          Nothing has moved yet today — there is still time. One small step will
          show up here.
        </p>
      ) : (
        <>
          <p className="text-sm text-gray-300">
            <span className="font-semibold text-indigo-300 tabular-nums">
              {movement.goalsMoved} dimension
              {movement.goalsMoved === 1 ? "" : "s"} moved today
            </span>
          </p>
          <p className="mt-1 text-xs text-gray-500 tabular-nums">
            {plural(movement.tasksDone, "task")} done
            {movement.milestonesDone > 0
              ? ` · ${plural(movement.milestonesDone, "milestone")} done`
              : ""}
          </p>

          <ul className="mt-3 space-y-1">
            {shown.map((g) => (
              <li
                key={g.goal_id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 min-h-[40px] rounded-lg bg-white/[0.03] px-3 py-2"
              >
                <span className="text-sm text-gray-200 leading-snug flex-1 min-w-0 break-words">
                  {g.goal_title}
                </span>
                <span className="sr-only">{movementSummary(g)}</span>
                <span
                  aria-hidden="true"
                  className="flex flex-wrap items-center gap-1"
                >
                  {g.tasks_done > 0 && (
                    <Chip tone="done">{g.tasks_done} done</Chip>
                  )}
                  {g.tasks_open > 0 && (
                    <Chip tone="open">{g.tasks_open} open</Chip>
                  )}
                  {g.milestones_done > 0 && (
                    <Chip tone="milestone">
                      {plural(g.milestones_done, "milestone")}
                    </Chip>
                  )}
                </span>
              </li>
            ))}
          </ul>

          {hidden > 0 && (
            <p className="mt-2 text-xs text-gray-500">+{hidden} more</p>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white/5 rounded-lg py-2">
      <p className="text-sm font-semibold text-gray-200 tabular-nums">{value}</p>
      <p className="text-[10px] text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

function GoalCard({
  goal,
  onChanged,
}: {
  goal: GoalWithMilestones;
  onChanged: () => Promise<void> | void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDate, setEditDate] = useState("");

  const total = goal.target && goal.target > 0 ? goal.target : goal.milestones.length;
  const progress = goal.progress ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;

  async function addMilestone() {
    const clean = input.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await fetch("/api/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal_id: goal.id, title: clean }),
      });
      setInput("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(m: Milestone) {
    setBusy(true);
    try {
      await fetch(`/api/milestones/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !m.done }),
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: Milestone) {
    setBusy(true);
    try {
      await fetch(`/api/milestones/${m.id}`, { method: "DELETE" });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  function startEdit(m: Milestone) {
    setEditingId(m.id);
    setEditTitle(m.title);
    setEditDate(m.target_date ?? "");
  }

  async function saveEdit(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/milestones/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim() || undefined,
          target_date: editDate || null,
        }),
      });
      setEditingId(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-gray-200 leading-snug">{goal.title}</h4>
        <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
          {progress}/{total}
        </span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      {goal.milestones.length > 0 && (
        <ul className="mt-3 space-y-1">
          {goal.milestones.map((m) => (
            <li key={m.id} className="rounded-lg bg-white/[0.03] px-2 py-1.5">
              {editingId === m.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Milestone title"
                    className="h-10 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none border border-white/10 rounded-lg px-3 focus:border-indigo-500/50"
                  />
                  <div className="flex gap-2 items-center">
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="h-10 flex-1 bg-transparent text-xs text-gray-300 outline-none border border-white/10 rounded-lg px-2"
                    />
                    <button
                      onClick={() => saveEdit(m.id)}
                      disabled={busy}
                      className="h-10 px-3 rounded-lg bg-indigo-600 text-white text-xs font-medium disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="h-10 px-3 rounded-lg bg-white/5 text-gray-400 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggle(m)}
                    aria-label={m.done ? "Mark undone" : "Mark done"}
                    className="flex-shrink-0 w-10 h-10 -my-1.5 flex items-center justify-center"
                  >
                    <span
                      className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                        m.done ? "bg-indigo-600 border-indigo-600" : "border-gray-600"
                      }`}
                    >
                      {m.done && (
                        <svg width="12" height="10" viewBox="0 0 10 8" fill="none">
                          <path
                            d="M1 4l3 3 5-6"
                            stroke="white"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                  </button>
                  <button
                    onClick={() => startEdit(m)}
                    className="flex-1 min-w-0 text-left py-1"
                  >
                    <span
                      className={`block text-sm truncate ${
                        m.done ? "line-through text-gray-600" : "text-gray-200"
                      }`}
                    >
                      {m.title}
                    </span>
                    {m.target_date && (
                      <span className="block text-[10px] text-gray-500 mt-0.5">
                        Target {m.target_date}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => remove(m)}
                    aria-label="Delete milestone"
                    className="flex-shrink-0 w-10 h-10 flex items-center justify-center text-gray-600 hover:text-red-400 transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex gap-2 items-center">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addMilestone()}
          placeholder="Add a milestone…"
          className="flex-1 min-w-0 h-10 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none border border-white/10 rounded-lg px-3 focus:border-indigo-500/50"
        />
        <button
          onClick={addMilestone}
          disabled={!input.trim() || busy}
          className="flex-shrink-0 h-10 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-xs font-medium text-white transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// Hand-rolled SVG line chart for mood. Gaps (null) break the line; each logged
// point gets a dot so a glance still reads the shape.
function MoodLine({ mood }: { mood: { day: string; mood: number | null }[] }) {
  const W = 320;
  const H = 80;
  const pad = 6;
  const n = mood.length;
  const x = (i: number) => (n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - ((v - 1) / 4) * (H - pad * 2);

  // Build contiguous segments so null days do not draw a misleading line.
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  mood.forEach((m, i) => {
    if (m.mood == null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ x: x(i), y: y(m.mood) });
    }
  });
  if (current.length) segments.push(current);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-20"
      preserveAspectRatio="none"
      role="img"
      aria-label="Mood over the last 14 days"
    >
      {[1, 3, 5].map((v) => (
        <line
          key={v}
          x1={0}
          x2={W}
          y1={y(v)}
          y2={y(v)}
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="1"
        />
      ))}
      {segments.map((seg, i) => (
        <polyline
          key={i}
          fill="none"
          stroke="#818cf8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
        />
      ))}
      {mood.map((m, i) =>
        m.mood == null ? null : (
          <circle key={m.day} cx={x(i)} cy={y(m.mood)} r="2.5" fill="#c7d2fe" />
        )
      )}
    </svg>
  );
}
