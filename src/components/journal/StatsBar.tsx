"use client";

import { STAT_KEYS, type StatKey } from "@/lib/journal";

export interface LifeStatsView {
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  streak: number;
  statTotals: Record<StatKey, number>;
  entryCount: number;
}

const STAT_META: Record<StatKey, { label: string; color: string }> = {
  health: { label: "Health", color: "bg-rose-500" },
  focus: { label: "Focus", color: "bg-indigo-500" },
  social: { label: "Social", color: "bg-amber-500" },
  creativity: { label: "Creativity", color: "bg-fuchsia-500" },
  discipline: { label: "Discipline", color: "bg-emerald-500" },
};

export function StatsBar({ stats }: { stats: LifeStatsView }) {
  const pct = Math.round((stats.xpIntoLevel / stats.xpForNextLevel) * 100);
  const maxStat = Math.max(1, ...STAT_KEYS.map((k) => stats.statTotals[k] ?? 0));

  return (
    <div className="px-4 py-4 border-b border-white/5 bg-[#121212]">
      {/* Level + XP */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-indigo-300">
            Lv {stats.level}
          </span>
          <span className="text-xs text-gray-500">{stats.totalXp} XP</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span>🔥</span>
          <span className="font-semibold text-amber-300">{stats.streak}</span>
          <span className="text-xs text-gray-500">day streak</span>
        </div>
      </div>

      {/* XP progress to next level */}
      <div className="h-2 rounded-full bg-white/10 overflow-hidden mb-4">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Per-stat bars */}
      <div className="space-y-1.5">
        {STAT_KEYS.map((k) => {
          const v = stats.statTotals[k] ?? 0;
          const w = Math.round((v / maxStat) * 100);
          return (
            <div key={k} className="flex items-center gap-2">
              <span className="w-20 text-xs text-gray-400">
                {STAT_META[k].label}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div
                  className={`h-full ${STAT_META[k].color} transition-all`}
                  style={{ width: `${w}%` }}
                />
              </div>
              <span className="w-6 text-right text-xs text-gray-500">{v}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
