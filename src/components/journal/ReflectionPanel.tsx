"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_CHECKLIST,
  type ChecklistItem,
  type DailyReflection,
} from "@/lib/reflection";

// READ-ONLY on purpose.
//
// This used to be a form: a fixed checklist to tick and two text areas to fill
// in. The reflection now happens as a conversation - you tell your assistant you
// want to do your reflection and it listens, infers the mood, and records it (see
// the save_reflection tool). A form cannot do that, and asking you to fill one in
// duplicates work the conversation already did.
//
// So this view shows what was recorded and the streak, and hands you to the chat
// to actually write today's.
export function ReflectionPanel() {
  const [checklist, setChecklist] = useState<ChecklistItem[]>(DEFAULT_CHECKLIST);
  const [wentWell, setWentWell] = useState("");
  const [couldImprove, setCouldImprove] = useState("");
  const [completed, setCompleted] = useState(false);
  const [journaledToday, setJournaledToday] = useState(false);
  const [journalStreak, setJournalStreak] = useState(0);
  const [reflectStreak, setReflectStreak] = useState(0);
  const [history, setHistory] = useState<DailyReflection[]>([]);
  const [loading, setLoading] = useState(true);

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
      // ignore — the view degrades to the empty state
    } finally {
      setLoading(false);
    }
  }

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Anything the conversation recorded today. The checklist is shown only for the
  // items that were actually ticked, so this never reads as a to-do list.
  const doneItems = checklist.filter((c) => c.done);
  const hasToday = completed || wentWell.trim().length > 0 || couldImprove.trim().length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-4 py-4 space-y-4 pb-8 max-w-xl mx-auto">
        {/* Header */}
        <div>
          <h2 className="text-sm font-semibold text-gray-200">🌙 Reflections</h2>
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

        {/* Today, as recorded by the conversation */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4 space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">
            {hasToday ? "Today, as you told it" : "Today"}
          </p>

          {loading ? (
            <p className="text-xs text-gray-500">Loading…</p>
          ) : hasToday ? (
            <>
              {wentWell.trim().length > 0 && (
                <div>
                  <p className="text-[10px] text-emerald-300/80 uppercase tracking-wide">
                    Went well
                  </p>
                  <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                    {wentWell}
                  </p>
                </div>
              )}
              {couldImprove.trim().length > 0 && (
                <div>
                  <p className="text-[10px] text-amber-300/80 uppercase tracking-wide">
                    Could be better
                  </p>
                  <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                    {couldImprove}
                  </p>
                </div>
              )}
              {doneItems.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {doneItems.map((c) => (
                    <span
                      key={c.id}
                      className="text-[11px] px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-gray-300"
                    >
                      ✓ {c.label}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[10px] text-gray-600">
                {completed ? "Marked complete — your streak counted it." : "Saved so far."}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-400">
              Nothing for today yet. You do not need to fill anything in.
            </p>
          )}

          <button
            onClick={() => {
              window.location.href = "/?tab=chat&prompt=reflection";
            }}
            className="w-full h-11 rounded-full bg-amber-600 hover:bg-amber-500 text-xs font-medium transition-colors"
          >
            {hasToday ? "Continue in the conversation →" : "Do my reflection in the conversation →"}
          </button>
        </div>

        {/* Earlier reflections */}
        <div className="bg-[#1a1a1a] border border-white/5 rounded-xl p-4">
          <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
            Earlier reflections
          </p>
          {history.length === 0 ? (
            <p className="text-xs text-gray-600">None yet.</p>
          ) : (
            <div className="space-y-2.5 max-h-80 overflow-y-auto">
              {history.slice(0, 14).map((h) => (
                <div key={h.id} className="border-t border-white/5 pt-2.5 first:border-0 first:pt-0">
                  <p className="text-[11px] text-gray-500">
                    {new Date(`${h.day}T00:00:00`).toLocaleDateString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                  {h.went_well && (
                    <p className="text-xs text-gray-300 leading-relaxed">👍 {h.went_well}</p>
                  )}
                  {h.could_improve && (
                    <p className="text-xs text-gray-400 leading-relaxed">
                      🔧 {h.could_improve}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
