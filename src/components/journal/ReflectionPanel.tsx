"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_CHECKLIST,
  type ChecklistItem,
  type DailyReflection,
} from "@/lib/reflection";

export function ReflectionPanel() {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(DEFAULT_CHECKLIST);
  const [wentWell, setWentWell] = useState("");
  const [couldImprove, setCouldImprove] = useState("");
  const [completed, setCompleted] = useState(false);
  const [journaledToday, setJournaledToday] = useState(false);
  const [journalStreak, setJournalStreak] = useState(0);
  const [reflectStreak, setReflectStreak] = useState(0);
  const [history, setHistory] = useState<DailyReflection[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const res = await fetch("/api/reflection");
      const data = await res.json();
      if (data.today) {
        setChecklist(data.today.checklist ?? DEFAULT_CHECKLIST);
        setWentWell(data.today.went_well ?? "");
        setCouldImprove(data.today.could_improve ?? "");
        setCompleted(!!data.today.completed);
      }
      setJournaledToday(!!data.journaledToday);
      setJournalStreak(data.journalStreak ?? 0);
      setReflectStreak(data.reflectStreak ?? 0);
      setHistory(data.history ?? []);
    } catch {
      // ignore
    }
  }

  function toggle(id: string) {
    setChecklist((prev) =>
      prev.map((c) => (c.id === id ? { ...c, done: !c.done } : c))
    );
  }

  function notify(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function save(markDone?: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/reflection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checklist,
          went_well: wentWell,
          could_improve: couldImprove,
          completed: markDone ?? completed,
        }),
      });
      const data = await res.json();
      if (data.today) {
        setChecklist(data.today.checklist ?? checklist);
        setCompleted(!!data.today.completed);
      }
      setReflectStreak(data.reflectStreak ?? reflectStreak);
      setHistory(data.history ?? history);
      notify(markDone ? "Day wrapped ✨" : "Saved ✓");
    } catch {
      notify("Couldn't save — try again");
    } finally {
      setSaving(false);
    }
  }

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="h-full overflow-y-auto relative">
      {toast && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-emerald-600 text-white text-xs shadow-lg">
          {toast}
        </div>
      )}

      <div className="px-4 py-4 space-y-4 pb-8 max-w-xl mx-auto">
        {/* Header */}
        <div>
          <h2 className="text-sm font-semibold text-gray-200">
            🌙 Evening reflection
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">{dateLabel}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span
              className={`text-[11px] px-2.5 py-1 rounded-full border ${
                journaledToday
                  ? "bg-emerald-600/15 border-emerald-500/30 text-emerald-200"
                  : "bg-white/5 border-white/10 text-gray-400"
              }`}
            >
              {journaledToday ? "✍️ Journaled today" : "✍️ Journal missing today"}
            </span>
            <span className="text-[11px] px-2.5 py-1 rounded-full bg-indigo-600/15 border border-indigo-500/30 text-indigo-200">
              🔥 Journal streak {journalStreak}
            </span>
            <span className="text-[11px] px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200">
              🌙 Reflection streak {reflectStreak}
            </span>
          </div>
        </div>

        {/* Evening checklist */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
              Evening checklist
            </p>
            <p className="text-[10px] text-gray-600">
              {checklist.filter((c) => c.done).length}/{checklist.length}
            </p>
          </div>
          <div className="space-y-1">
            {checklist.map((c) => (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                className="w-full flex items-center gap-2.5 text-left py-1.5 group"
              >
                <span
                  className={`w-4 h-4 rounded-md border flex-shrink-0 flex items-center justify-center text-[10px] transition-colors ${
                    c.done
                      ? "bg-emerald-600 border-emerald-500 text-white"
                      : "border-white/20 group-hover:border-indigo-400/50"
                  }`}
                >
                  {c.done ? "✓" : ""}
                </span>
                <span
                  className={`text-sm ${
                    c.done ? "text-gray-500 line-through" : "text-gray-200"
                  }`}
                >
                  {c.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Reflection fields */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1.5">
              Was lief heute gut?
            </label>
            <textarea
              value={wentWell}
              onChange={(e) => setWentWell(e.target.value)}
              rows={3}
              placeholder="What went well today…"
              className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none border border-white/10 rounded-lg px-3 py-2 focus:border-indigo-500/50 transition-colors leading-relaxed"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 font-medium mb-1.5">
              Was kann besser werden?
            </label>
            <textarea
              value={couldImprove}
              onChange={(e) => setCouldImprove(e.target.value)}
              rows={3}
              placeholder="What could be better…"
              className="w-full bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none border border-white/10 rounded-lg px-3 py-2 focus:border-indigo-500/50 transition-colors leading-relaxed"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => save(false)}
            disabled={saving}
            className="flex-shrink-0 px-4 h-9 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-40 flex items-center justify-center text-xs font-medium transition-colors"
          >
            {saving ? "…" : "Save"}
          </button>
          <button
            onClick={() => save(true)}
            disabled={saving}
            className={`flex-1 px-4 h-9 rounded-full disabled:opacity-40 flex items-center justify-center text-xs font-medium transition-colors ${
              completed
                ? "bg-emerald-600 hover:bg-emerald-500"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {saving ? "…" : completed ? "Day wrapped ✨" : "Wrap up the day ✓"}
          </button>
        </div>
        <p className="text-xs text-gray-600 text-center">
          Once a day, in the evening before sleep — tied to your journaling habit.
        </p>

        {/* Recent history */}
        {history.length > 0 && (
          <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
              Recent reflections
            </p>
            <div className="space-y-2.5">
              {history.slice(0, 7).map((h) => {
                const checked = h.checklist.filter((c) => c.done).length;
                return (
                  <div key={h.id} className="text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-gray-300 font-medium">
                        {h.day}
                      </span>
                      <span className="text-gray-600">
                        {checked}/{h.checklist.length} ✓
                      </span>
                    </div>
                    {(h.went_well || h.could_improve) && (
                      <p className="text-gray-500 mt-0.5 line-clamp-1">
                        {h.went_well ? `👍 ${h.went_well}` : ""}
                        {h.went_well && h.could_improve ? " · " : ""}
                        {h.could_improve ? `↗ ${h.could_improve}` : ""}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
