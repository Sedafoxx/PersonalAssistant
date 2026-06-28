"use client";

import { useEffect, useState, useCallback } from "react";
import { type ListItem, type ListKind } from "@/lib/lists";

const TABS: { label: string; value: ListKind }[] = [
  { label: "Grocery", value: "grocery" },
  { label: "Shopping", value: "shopping" },
];

export function ListsPanel({ refreshKey }: { refreshKey: number }) {
  const [list, setList] = useState<ListKind>("grocery");
  const [items, setItems] = useState<ListItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/lists?list=${list}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, [list]);

  // Refetch on tab switch and whenever the assistant edits lists (refreshKey).
  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, refreshKey]);

  async function add() {
    const name = input.trim();
    if (!name) return;
    setInput("");
    // Optimistic: show immediately; dedup handled server-side.
    await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, name }),
    });
    fetchList();
  }

  async function toggle(item: ListItem) {
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i))
    );
    await fetch("/api/lists", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, checked: !item.checked }),
    });
    fetchList();
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await fetch(`/api/lists?id=${id}`, { method: "DELETE" });
  }

  async function clearChecked() {
    await fetch(`/api/lists?list=${list}&clearChecked=1`, { method: "DELETE" });
    fetchList();
  }

  const checkedCount = items.filter((i) => i.checked).length;

  return (
    <div className="flex flex-col h-full max-w-xl mx-auto w-full">
      {/* Tabs */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setList(t.value)}
              className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${
                list === t.value
                  ? "bg-indigo-600 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Add row */}
      <div className="px-4 pb-3">
        <div className="flex gap-2 items-center bg-[#1a1a1a] border border-white/10 rounded-xl px-3 py-2 focus-within:border-indigo-500/50 transition-colors">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={`Add to ${list}…`}
            className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 outline-none"
          />
          <button
            onClick={add}
            disabled={!input.trim()}
            className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 flex items-center justify-center transition-colors"
            aria-label="Add"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center h-20">
            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600 text-sm">Nothing on your {list} list</p>
            <p className="text-gray-700 text-xs mt-1">
              Add above, or just tell the assistant in chat
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-white/5"
              >
                <button
                  onClick={() => toggle(item)}
                  className={`flex-shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${
                    item.checked
                      ? "bg-indigo-600 border-indigo-600"
                      : "border-gray-600 hover:border-indigo-400"
                  }`}
                  aria-label={item.checked ? "Uncheck" : "Check"}
                >
                  {item.checked && (
                    <svg width="12" height="10" viewBox="0 0 10 8" fill="none">
                      <path d="M1 4l3 3 5-6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                <span
                  className={`flex-1 text-sm ${
                    item.checked ? "line-through text-gray-600" : "text-gray-200"
                  }`}
                >
                  {item.name}
                </span>
                <button
                  onClick={() => remove(item.id)}
                  className="flex-shrink-0 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  aria-label="Remove"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Clear checked */}
      {checkedCount > 0 && (
        <div className="px-4 pb-4">
          <button
            onClick={clearChecked}
            className="w-full py-2 rounded-xl bg-white/5 hover:bg-white/10 text-sm text-gray-300 transition-colors"
          >
            Clear {checkedCount} checked
          </button>
        </div>
      )}
    </div>
  );
}
