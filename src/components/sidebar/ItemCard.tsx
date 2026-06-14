"use client";

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

export function ItemCard({
  item,
  onToggleDone,
  onDelete,
}: {
  item: Item;
  onToggleDone: (id: string, done: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const isDone = item.status === "done";

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

      {/* Delete */}
      <button
        onClick={() => onDelete(item.id)}
        className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 transition-all mt-0.5"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
