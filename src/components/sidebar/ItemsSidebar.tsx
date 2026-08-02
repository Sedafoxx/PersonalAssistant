"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { type Item, type ItemType } from "@/lib/db";
import { ItemCard, type ItemEdit } from "./ItemCard";
import { ItemDetail } from "./ItemDetail";

type Filter = "all" | ItemType;
type SortKey = "created_at" | "priority" | "due_date";

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Todos", value: "todo" },
  { label: "Notes", value: "note" },
  { label: "Ideas", value: "idea" },
];

type XpView = { level: number; totalXp: number; xpIntoLevel: number; xpForNextLevel: number };

export function ItemsSidebar({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<Item[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("created_at");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [detail, setDetail] = useState<Item | null>(null);
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [xp, setXp] = useState<XpView | null>(null);
  const [reward, setReward] = useState<{ amount: number; levelUp: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      const data = await res.json();
      if (typeof data.level === "number") setXp(data);
    } catch {
      // non-essential
    }
  }, []);

  // Keep the open detail panel in sync if the underlying item changes.
  const detailItem = detail ? items.find((i) => i.id === detail.id) ?? detail : null;

  const fetchItems = useCallback(
    async (q?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (filter !== "all") params.set("type", filter);
        params.set("sort_by", sort);
        if (q) params.set("q", q);
        const res = await fetch(`/api/items?${params}`);
        const data = await res.json();
        setItems(Array.isArray(data) ? data : []);
      } finally {
        setLoading(false);
      }
    },
    [filter, sort]
  );

  useEffect(() => {
    if (search) {
      if (searchTimeout) clearTimeout(searchTimeout);
      const t = setTimeout(() => fetchItems(search), 300);
      setSearchTimeout(t);
    } else {
      fetchItems();
    }
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sort, search, refreshKey]);

  // Open the list at the top instead of inheriting a restored scroll position.
  useEffect(() => {
    const raf = requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(raf);
  }, []);

  async function handleToggleDone(id: string, done: boolean) {
    const prevLevel = xp?.level ?? 1;
    const res = await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: done ? "done" : "active" }),
    });
    // Reward feedback: server returns xpGained on the active->done transition.
    try {
      const updated = await res.json();
      const gained = updated?.xpGained ?? 0;
      if (done && gained > 0) {
        const fresh = await fetch("/api/stats").then((r) => r.json());
        const leveledUp = typeof fresh.level === "number" && fresh.level > prevLevel;
        if (typeof fresh.level === "number") setXp(fresh);
        setReward({ amount: gained, levelUp: leveledUp });
        setTimeout(() => setReward(null), leveledUp ? 3200 : 1800);
      } else {
        fetchStats();
      }
    } catch {
      fetchStats();
    }
    fetchItems(search || undefined);
  }

  async function handleDelete(id: string) {
    await fetch(`/api/items/${id}`, { method: "DELETE" });
    fetchItems(search || undefined);
  }

  async function handleSave(id: string, patch: ItemEdit) {
    await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    fetchItems(search || undefined);
  }

  const todoCount = items.filter((i) => i.type === "todo" && i.status === "active").length;

  const xpPct = xp
    ? Math.round((xp.xpIntoLevel / xp.xpForNextLevel) * 100)
    : 0;

  return (
    <div className="flex flex-col h-full relative">
      {/* Reward toast */}
      {reward && (
        <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 z-20">
          <div
            className={`px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg animate-bounce ${
              reward.levelUp
                ? "bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-white"
                : "bg-amber-500 text-black"
            }`}
          >
            {reward.levelUp
              ? `🎉 Level up! +${reward.amount} XP`
              : `+${reward.amount} XP`}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
            Items
            {todoCount > 0 && (
              <span className="text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded-full">
                {todoCount}
              </span>
            )}
          </h2>
          {xp && (
            <div
              className="flex items-center gap-1.5"
              title={`${xp.totalXp} XP · ${xp.xpIntoLevel}/${xp.xpForNextLevel} to next level`}
            >
              <span className="text-[11px] font-bold text-indigo-300">
                Lv {xp.level}
              </span>
              <div className="w-12 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
                  style={{ width: `${xpPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-full bg-[#1a1a1a] border border-white/10 rounded-lg pl-7 pr-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`flex-1 text-[10px] font-medium py-1 rounded-md transition-colors ${
                filter === f.value
                  ? "bg-indigo-600 text-white"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] text-gray-600">Sort:</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="flex-1 text-[10px] bg-transparent text-gray-400 outline-none cursor-pointer"
          >
            <option value="created_at">Newest</option>
            <option value="priority">Priority</option>
            <option value="due_date">Due date</option>
          </select>
        </div>
      </div>

      {/* Items list */}
      <div ref={listRef} className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="flex items-center justify-center h-20">
            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 px-4">
            <p className="text-gray-600 text-xs">
              {search ? "No results found" : "Nothing here yet"}
            </p>
            {!search && (
              <p className="text-gray-700 text-[10px] mt-1">
                Chat to create items
              </p>
            )}
          </div>
        ) : (
          [...items]
            // Keep completed items in the list but sink them below active ones.
            // Stable sort preserves the server-chosen order within each group.
            .sort(
              (a, b) =>
                (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0)
            )
            .map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onToggleDone={handleToggleDone}
              onDelete={handleDelete}
              onSave={handleSave}
              onOpen={setDetail}
              autoEdit={autoEditId === item.id}
              onConsumeAutoEdit={() => setAutoEditId(null)}
            />
          ))
        )}
      </div>

      {detailItem && (
        <ItemDetail
          item={detailItem}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setAutoEditId(detailItem.id);
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}
