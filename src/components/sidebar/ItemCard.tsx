"use client";

import { useState } from "react";
import { type Item } from "@/lib/db";

const TYPE_COLORS: Record<string, string> = {
  todo: "bg-blue-500/20 text-blue-300",
  note: "bg-emerald-500/20 text-emerald-300",
  idea: "bg-amber-500/20 text-amber-300",
};

const PRIORITY_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-yellow-500",
  "bg-blue-500",
  "bg-gray-500",
];

export interface ItemEdit {
  title: string;
  content: string;
  priority: number;
}

export function ItemCard({
  item,
  onToggleDone,
  onDelete,
  onSave,
}: {
  item: Item;
  onToggleDone: (id: string, done: boolean) => void;
  onDelete: (id: string) => void;
  onSave: (id: string, patch: ItemEdit) => Promise<void> | void;
}) {
  const isDone = item.status === "done";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content ?? "");
  const [priority, setPriority] = useState(item.priority ?? 3);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setTitle(item.title);
    setContent(item.content ?? "");
    setPriority(item.priority ?? 3);
    setEditing(true);
  }

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSave(item.id, { title: title.trim(), content: content.trim(), priority });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2.5 rounded-xl bg-white/5">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="Title"
          className="w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500/50"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Notes (optional)"
          rows={2}
          className="w-full resize-none bg-[#1a1a1a] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-300 placeholder-gray-600 outline-none focus:border-indigo-500/50"
        />
        <div className="flex items-center gap-2">
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="text-[10px] bg-[#1a1a1a] border border-white/10 rounded-md px-1.5 py-1 text-gray-300 outline-none cursor-pointer"
          >
            <option value={1}>P1 · Critical</option>
            <option value={2}>P2 · High</option>
            <option value={3}>P3 · Normal</option>
            <option value={4}>P4 · Low</option>
            <option value={5}>P5 · Someday</option>
          </select>
          <div className="flex-1" />
          <button
            onClick={() => setEditing(false)}
            className="text-[11px] text-gray-500 hover:text-gray-300 px-2 py-1"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !title.trim()}
            className="text-[11px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md px-2.5 py-1 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group flex items-start gap-3 px-3 py-2.5 rounded-xl transition-colors hover:bg-white/5 ${
        isDone ? "opacity-50" : ""
      }`}
    >
      {/* Checkbox */}
      {item.type === "todo" && (
        <button
          onClick={() => onToggleDone(item.id, !isDone)}
          className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border transition-colors ${
            isDone
              ? "bg-indigo-600 border-indigo-600"
              : "border-gray-600 hover:border-indigo-400"
          } flex items-center justify-center`}
        >
          {isDone && (
            <svg width="10" height="8" viewBox="0 0 10 8" fill="currentColor">
              <path d="M1 4l3 3 5-6" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
      {item.type !== "todo" && (
        <div
          className={`mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full ${
            PRIORITY_COLORS[(item.priority ?? 3) - 1]
          }`}
        />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${TYPE_COLORS[item.type]}`}
          >
            {item.type}
          </span>
          {item.type === "todo" && (
            <div
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                PRIORITY_COLORS[(item.priority ?? 3) - 1]
              }`}
            />
          )}
        </div>
        <p
          className={`text-sm text-gray-200 leading-snug truncate ${
            isDone ? "line-through text-gray-500" : ""
          }`}
        >
          {item.title}
        </p>
        {item.content && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{item.content}</p>
        )}
        {item.due_date && (
          <p className="text-[10px] text-gray-600 mt-0.5">
            Due {new Date(item.due_date).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 flex items-center gap-1.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-all">
        <button
          onClick={startEdit}
          className="text-gray-600 hover:text-indigo-400 transition-colors"
          aria-label="Edit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9" strokeLinecap="round" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={() => onDelete(item.id)}
          className="text-gray-600 hover:text-red-400 transition-colors"
          aria-label="Delete"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
