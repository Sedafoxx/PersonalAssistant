"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Item } from "@/lib/db";
import { ItemDetail } from "@/components/sidebar/ItemDetail";
import { countdownLabel, logicalDay } from "@/lib/dates";

// The Today window: the agreed tasks for the day, the auto-surfaced due /
// overdue items, and the collapsed backlog you can pull from in one tap.
//
// Every write goes through the existing /api/day route (or /api/items/[id]
// for the ItemDetail edit affordance) — no new endpoints. Mobile-first: the
// whole panel scrolls with momentum, and every control is at least ~40px.

interface DayView {
  date: string;
  today: Item[];
  due: Item[];
  backlog: Item[];
  counts: { total: number; done: number; open: number; requiredOpen: number };
}

interface MilestoneRef {
  id: string;
  title: string;
}

type Filter = "all" | "needed" | "optional";

const PRIORITY_LABEL: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
  5: "P5",
};

const PRIORITY_COLOR: Record<number, string> = {
  1: "bg-red-500/20 text-red-300",
  2: "bg-orange-500/20 text-orange-300",
  3: "bg-indigo-500/20 text-indigo-300",
  4: "bg-white/10 text-gray-400",
  5: "bg-white/10 text-gray-500",
};

// The day the user is living, from the shared rule in dates.ts. Before 04:00
// local this is the day that just ended, so a late night does not silently start
// planning tomorrow's list while you are still finishing today's.
function localDay(): string {
  return logicalDay();
}

function prettyDate(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function TodayPanel() {
  const [view, setView] = useState<DayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [priority, setPriority] = useState(3);
  const [required, setRequired] = useState(true);
  const [adding, setAdding] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [detail, setDetail] = useState<Item | null>(null);
  const [milestones, setMilestones] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const date = useMemo(localDay, []);

  // Milestone id → title, so a row attached to a milestone can show its name
  // instead of a generic "Goal" chip. Best-effort: a failure just means the
  // chips fall back to the goal marker.
  const fetchMilestones = useCallback(async () => {
    try {
      const res = await fetch("/api/milestones");
      if (!res.ok) return;
      const list = (await res.json()) as MilestoneRef[];
      const map: Record<string, string> = {};
      for (const m of list) map[m.id] = m.title;
      setMilestones(map);
    } catch {
      // ignore — the chips degrade gracefully
    }
  }, []);

  const fetchDay = useCallback(async () => {
    try {
      const res = await fetch(`/api/day?date=${date}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as DayView;
      setView(data);
      setError(null);
      // Keep an open detail overlay in sync with the refreshed server row.
      setDetail((prev) =>
        prev ? data.today.find((i) => i.id === prev.id) ?? prev : null
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchDay();
    fetchMilestones();
  }, [fetchDay, fetchMilestones]);

  async function patchDay(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch("/api/day", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  async function addTask() {
    const clean = title.trim();
    if (!clean || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: clean,
          priority,
          required,
          planned_time: time || undefined,
          planned_for: date,
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setTitle("");
      setTime("");
      setPriority(3);
      setRequired(true);
      await fetchDay();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function toggleDone(item: Item) {
    const next = item.status === "done" ? "active" : "done";
    // Optimistic flip so the checkbox feels instant; the refetch reconciles.
    setView((prev) =>
      prev
        ? {
            ...prev,
            today: prev.today.map((i) =>
              i.id === item.id ? { ...i, status: next } : i
            ),
          }
        : prev
    );
    await patchDay({ id: item.id, status: next });
    await fetchDay();
  }

  async function moveToBacklog(item: Item) {
    await patchDay({ id: item.id, planned_for: null, day_order: null });
    await fetchDay();
  }

  async function planForToday(item: Item) {
    await patchDay({ id: item.id, planned_for: date });
    await fetchDay();
  }

  // Up/down chevrons rather than HTML5 drag: reliable on touch, and testable.
  async function move(index: number, delta: number) {
    if (!view) return;
    const ids = view.today.map((i) => i.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const reordered = [...ids];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    // Update local state immediately, then persist the whole order.
    setView((prev) => {
      if (!prev) return prev;
      const byId = new Map(prev.today.map((i) => [i.id, i]));
      return {
        ...prev,
        today: reordered.map((id) => byId.get(id)!).filter(Boolean),
      };
    });
    await patchDay({ order: reordered, date });
    await fetchDay();
  }

  const visibleToday = useMemo(() => {
    if (!view) return [];
    if (filter === "needed") return view.today.filter((i) => i.required);
    if (filter === "optional") return view.today.filter((i) => !i.required);
    return view.today;
  }, [view, filter]);

  const counts = view?.counts;
  const pct = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain">
      <div className="px-4 py-4 pb-16 max-w-xl mx-auto space-y-4">
        {/* Header */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-200">Today</h2>
              <p className="text-xs text-gray-400 mt-0.5 truncate">{prettyDate(date)}</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="text-right">
                <p className="text-lg font-bold text-indigo-300 tabular-nums leading-none">
                  {counts ? `${counts.done}/${counts.total}` : "–"}
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5">done</p>
              </div>
              <ProgressRing pct={pct} />
            </div>
          </div>

          {/* Thin progress bar (redundant on purpose — glancable on a phone). */}
          <div className="mt-3 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* Filter chips */}
          <div className="mt-3 flex gap-1">
            {(
              [
                { label: "All", value: "all" },
                { label: "Needed", value: "needed" },
                { label: "Optional", value: "optional" },
              ] as { label: string; value: Filter }[]
            ).map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`flex-1 h-10 rounded-lg text-xs font-medium transition-colors ${
                  filter === f.value
                    ? "bg-indigo-600 text-white"
                    : "bg-white/5 text-gray-400 hover:text-gray-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Quick add */}
        <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-3 space-y-2">
          <div className="flex gap-2 items-center">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTask()}
              placeholder="Add a task for today…"
              className="flex-1 min-w-0 h-11 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none border border-white/10 rounded-lg px-3 focus:border-indigo-500/50 transition-colors"
            />
            <button
              onClick={addTask}
              disabled={!title.trim() || adding}
              className="flex-shrink-0 w-11 h-11 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 flex items-center justify-center transition-colors"
              aria-label="Add task"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-1.5 h-10 px-2.5 rounded-lg bg-white/5 text-xs text-gray-400">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" strokeLinecap="round" />
              </svg>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="bg-transparent text-xs text-gray-300 outline-none w-[74px]"
              />
            </label>
            <label className="flex items-center gap-1.5 h-10 px-2.5 rounded-lg bg-white/5 text-xs text-gray-400 flex-1">
              Priority
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="bg-transparent text-xs text-gray-300 outline-none flex-1"
              >
                {[1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p} className="bg-[#1a1a1a] text-gray-200">
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => setRequired((r) => !r)}
              className={`h-10 px-3 rounded-lg text-xs font-medium transition-colors ${
                required
                  ? "bg-indigo-600/20 text-indigo-200 border border-indigo-500/30"
                  : "bg-white/5 text-gray-400"
              }`}
            >
              {required ? "Needed" : "Optional"}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-600/10 border border-red-500/30 rounded-xl p-3 text-xs text-red-300 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button onClick={fetchDay} className="underline flex-shrink-0">
              Retry
            </button>
          </div>
        )}

        {/* Today list */}
        <section>
          <h3 className="text-[11px] uppercase tracking-wide text-gray-500 px-1 mb-2">
            Planned
          </h3>
          {loading && !view ? (
            <div className="flex items-center justify-center h-20">
              <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : visibleToday.length === 0 ? (
            <div className="bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-8 text-center">
              <p className="text-sm text-gray-500">
                {view && view.today.length > 0
                  ? "Nothing matches this filter."
                  : "Nothing planned yet today."}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                Add a task above, or pull one from the backlog.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visibleToday.map((item) => {
                const index = view ? view.today.findIndex((i) => i.id === item.id) : -1;
                return (
                  <TodoRow
                    key={item.id}
                    item={item}
                    milestoneTitle={
                      item.milestone_id ? milestones[item.milestone_id] : undefined
                    }
                    onToggle={() => toggleDone(item)}
                    onOpen={() => setDetail(item)}
                    onMoveUp={() => move(index, -1)}
                    onMoveDown={() => move(index, 1)}
                    canMoveUp={index > 0}
                    canMoveDown={view ? index >= 0 && index < view.today.length - 1 : false}
                    onBacklog={() => moveToBacklog(item)}
                  />
                );
              })}
            </ul>
          )}
        </section>

        {/* Due / overdue */}
        {view && view.due.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-wide text-amber-400/80 px-1 mb-2">
              Due / overdue
            </h3>
            <ul className="space-y-1.5">
              {view.due.map((item) => {
                const overdue = item.due_date != null && item.due_date < date;
                const countdown = countdownLabel(item.due_date);
                return (
                  <li
                    key={item.id}
                    className="bg-[#1a1a1a] border border-amber-500/20 rounded-xl px-3 py-2.5 flex items-center gap-3"
                  >
                    <button
                      onClick={() => setDetail(item)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <span className="block text-sm text-gray-200 truncate">
                        {item.title}
                      </span>
                      <span
                        className={`block text-[11px] mt-0.5 ${
                          overdue ? "text-red-400" : "text-amber-400/80"
                        }`}
                      >
                        {countdown ?? item.due_date}
                      </span>
                    </button>
                    <button
                      onClick={() => planForToday(item)}
                      className="flex-shrink-0 h-10 px-3 rounded-lg bg-amber-600/20 text-amber-200 border border-amber-500/30 text-xs font-medium hover:bg-amber-600/30 transition-colors"
                    >
                      Plan for today
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Backlog (collapsed by default) */}
        <section>
          <button
            onClick={() => setBacklogOpen((o) => !o)}
            className="w-full flex items-center justify-between bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-3 min-h-[44px] text-left"
          >
            <span className="flex items-center gap-2 text-sm text-gray-300">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`transition-transform ${backlogOpen ? "rotate-90" : ""}`}
              >
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Backlog
            </span>
            <span className="text-xs text-gray-500">
              {view ? view.backlog.length : "–"}
            </span>
          </button>

          {backlogOpen && (
            <div className="mt-2">
              {view && view.backlog.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-6">
                  Backlog is empty — you are all caught up.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {(view?.backlog ?? []).map((item) => (
                    <li
                      key={item.id}
                      className="bg-[#1a1a1a] border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-3"
                    >
                      <button
                        onClick={() => setDetail(item)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <span className="block text-sm text-gray-300 truncate">
                          {item.title}
                        </span>
                        {item.due_date && (
                          <span className="block text-[11px] text-gray-500 mt-0.5">
                            Due {item.due_date}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => planForToday(item)}
                        className="flex-shrink-0 h-10 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
                      >
                        Today
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>

      {detail && (
        <ItemDetail
          item={detail}
          onClose={() => setDetail(null)}
          onEdit={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const offset = c - (Math.min(100, Math.max(0, pct)) / 100) * c;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="4" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="#6366f1"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 20 20)"
        className="transition-all"
      />
      <text
        x="20"
        y="20"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-gray-300"
        fontSize="10"
        fontWeight="600"
      >
        {pct}%
      </text>
    </svg>
  );
}

function TodoRow({
  item,
  milestoneTitle,
  onToggle,
  onOpen,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onBacklog,
}: {
  item: Item;
  milestoneTitle?: string;
  onToggle: () => void;
  onOpen: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onBacklog: () => void;
}) {
  const done = item.status === "done";
  const priority = item.priority ?? 3;

  return (
    <li className="bg-[#1a1a1a] border border-white/10 rounded-xl p-2 flex items-center gap-2">
      <button
        onClick={onToggle}
        className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
          done ? "text-indigo-400" : "text-gray-500 hover:text-gray-300"
        }`}
        aria-label={done ? "Mark not done" : "Mark done"}
      >
        <span
          className={`w-5 h-5 rounded-md border flex items-center justify-center ${
            done ? "bg-indigo-600 border-indigo-600" : "border-gray-600"
          }`}
        >
          {done && (
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

      {/* Row body opens the existing detail overlay. */}
      <button onClick={onOpen} className="flex-1 min-w-0 text-left py-1.5">
        <span
          className={`block text-sm truncate ${
            done ? "line-through text-gray-600" : "text-gray-100"
          }`}
        >
          {item.title}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 mt-1">
          {item.planned_time && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
              {item.planned_time}
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              PRIORITY_COLOR[priority] ?? PRIORITY_COLOR[3]
            }`}
          >
            {PRIORITY_LABEL[priority] ?? "P3"}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              item.required
                ? "bg-indigo-500/20 text-indigo-300"
                : "bg-white/5 text-gray-500"
            }`}
          >
            {item.required ? "Needed" : "Optional"}
          </span>
          {milestoneTitle ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 max-w-[10rem] truncate">
              {milestoneTitle}
            </span>
          ) : (
            item.goal_id && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300">
                Goal
              </span>
            )
          )}
        </span>
      </button>

      {/* Reorder + backlog controls */}
      <div className="flex-shrink-0 flex flex-col items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={!canMoveUp}
          aria-label="Move up"
          className="w-9 h-8 rounded-md bg-white/5 text-gray-400 hover:text-gray-200 disabled:opacity-25 flex items-center justify-center transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onMoveDown}
          disabled={!canMoveDown}
          aria-label="Move down"
          className="w-9 h-8 rounded-md bg-white/5 text-gray-400 hover:text-gray-200 disabled:opacity-25 flex items-center justify-center transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <button
        onClick={onBacklog}
        aria-label="Move to backlog"
        title="Move to backlog"
        className="flex-shrink-0 w-10 h-10 rounded-lg bg-white/5 text-gray-400 hover:text-amber-300 flex items-center justify-center transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 7h18v12H3z" strokeLinejoin="round" />
          <path d="M3 11h18" />
          <path d="M9 3v4M15 3v4" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}
