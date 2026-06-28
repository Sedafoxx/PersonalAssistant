"use client";

import { useEffect } from "react";
import { type Item } from "@/lib/db";
import { linkify } from "@/lib/linkify";

const TYPE_COLORS: Record<string, string> = {
  todo: "bg-blue-500/20 text-blue-300",
  note: "bg-emerald-500/20 text-emerald-300",
  idea: "bg-amber-500/20 text-amber-300",
};

// Read-only detail overlay. Renders the full content with clickable links —
// the gap the edit form can't fill, since URLs in a textarea aren't tappable.
export function ItemDetail({
  item,
  onClose,
  onEdit,
}: {
  item: Item;
  onClose: () => void;
  onEdit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl bg-[#161616] border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 px-5 pt-5 pb-3 border-b border-white/5">
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${TYPE_COLORS[item.type]}`}
          >
            {item.type}
          </span>
          <div className="flex-1" />
          <button
            onClick={onEdit}
            className="text-[11px] text-gray-400 hover:text-indigo-400 px-2 py-1"
          >
            Edit
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-500 hover:text-gray-200"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4">
          <h3 className="text-base font-semibold text-gray-100 leading-snug break-words">
            {linkify(item.title)}
          </h3>

          {item.content ? (
            <p className="mt-3 text-sm text-gray-300 leading-relaxed whitespace-pre-wrap break-words">
              {linkify(item.content)}
            </p>
          ) : (
            <p className="mt-3 text-sm text-gray-600 italic">No additional details.</p>
          )}

          {item.tags?.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {item.tags.map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-gray-400"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-600">
            {item.due_date && <span>Due {new Date(item.due_date).toLocaleString()}</span>}
            <span>Created {new Date(item.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
