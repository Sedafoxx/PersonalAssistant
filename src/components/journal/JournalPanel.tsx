"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { StatsBar, type LifeStatsView } from "./StatsBar";
import type { JournalEntry } from "@/lib/journal";
import type { Goal } from "@/lib/goals";

export function JournalPanel() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [stats, setStats] = useState<LifeStatsView | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const { recording, transcribing, error: voiceError, toggle } = useVoiceInput(
    (t) => setText((prev) => (prev ? `${prev} ${t}` : t).trim())
  );

  async function load() {
    try {
      const res = await fetch("/api/journal");
      const data = await res.json();
      if (data.entries) setEntries(data.entries);
      if (data.stats) setStats(data.stats);
      if (data.goals) setGoals(data.goals);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      const data = await res.json();
      if (data.entry) {
        setEntries((prev) => [data.entry, ...prev]);
        setText("");
      }
      if (data.stats) setStats(data.stats);
      const advanced: Goal[] = data.advancedGoals ?? [];
      if (advanced.length > 0) {
        // Reflect bumped progress + tell the user.
        setGoals((prev) =>
          prev.map((g) => advanced.find((a) => a.id === g.id) ?? g)
        );
        setToast(
          `Progress on: ${advanced.map((g) => g.title).join(", ")} ⬆`
        );
        setTimeout(() => setToast(null), 4000);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full relative">
      {stats && <StatsBar stats={stats} />}

      {/* Goals */}
      {goals.length > 0 && (
        <div className="px-4 py-3 border-b border-white/5 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">
            Goals
          </p>
          {goals.map((g) => {
            const pct =
              g.target && g.target > 0
                ? Math.min(100, Math.round((g.progress / g.target) * 100))
                : null;
            return (
              <div key={g.id} className="text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-gray-200">{g.title}</span>
                  <span className="text-xs text-gray-500">
                    {g.target ? `${g.progress}/${g.target}` : `${g.progress}`}
                  </span>
                </div>
                {pct !== null && (
                  <div className="h-1.5 mt-1 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-emerald-600 text-white text-xs shadow-lg">
          {toast}
        </div>
      )}

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {entries.length === 0 && (
          <p className="text-sm text-gray-600 text-center mt-8">
            No entries yet. Dump a thought below — speak or type.
          </p>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            className="bg-[#1a1a1a] border border-white/5 rounded-xl px-4 py-3"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500">
                {new Date(e.created_at).toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                {e.mood && (
                  <span className="text-xs text-indigo-300">{e.mood}</span>
                )}
                <span className="text-xs text-amber-300">+{e.xp} XP</span>
              </div>
            </div>
            {e.summary && (
              <p className="text-sm text-gray-200">{e.summary}</p>
            )}
            <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap">
              {e.raw_text}
            </p>
            {e.topics.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {e.topics.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-gray-400"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="px-4 pb-4 pt-2 border-t border-white/5">
        <div className="flex gap-2 items-end bg-[#1a1a1a] border border-white/10 rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              recording
                ? "Listening… tap mic to stop"
                : transcribing
                ? "Transcribing…"
                : "What's on your mind? Speak or type…"
            }
            rows={1}
            className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none max-h-40 overflow-y-auto leading-relaxed"
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${t.scrollHeight}px`;
            }}
            disabled={saving}
          />
          <button
            onClick={toggle}
            disabled={saving || (transcribing && !recording)}
            aria-label={recording ? "Stop recording" : "Record voice"}
            className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 ${
              recording
                ? "bg-red-600 hover:bg-red-500 animate-pulse"
                : "bg-white/10 hover:bg-white/20"
            }`}
          >
            {transcribing ? (
              <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
                <path d="M19 11a7 7 0 0 1-14 0H3a9 9 0 0 0 8 8.94V23h2v-3.06A9 9 0 0 0 21 11h-2z" />
              </svg>
            )}
          </button>
          <button
            onClick={save}
            disabled={saving || !text.trim()}
            className="flex-shrink-0 px-3 h-8 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-xs font-medium transition-colors"
          >
            {saving ? "…" : "Log"}
          </button>
        </div>
        {voiceError ? (
          <p className="text-xs text-red-400 mt-1.5 text-center">{voiceError}</p>
        ) : (
          <p className="text-xs text-gray-600 mt-1.5 text-center">
            {recording
              ? "Recording… speak as long as you like, tap mic to finish"
              : transcribing
              ? "Transcribing your last bit…"
              : "Logged entries earn XP and feed your life stats"}
          </p>
        )}
      </div>
    </div>
  );
}
