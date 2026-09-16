"use client";

import { useState, useEffect } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { CoachPanel } from "@/components/coach/CoachPanel";
import { ListsPanel } from "@/components/lists/ListsPanel";
import { TodayPanel } from "@/components/today/TodayPanel";
import { FeedPanel } from "@/components/feed/FeedPanel";
import { StatsPanel } from "@/components/stats/StatsPanel";
import { ItemsSidebar } from "@/components/sidebar/ItemsSidebar";
import { setupNotifications } from "@/lib/notifications";

// Journal and Reflection are gone as tabs on purpose: journaling and the evening
// reflection both happen in the conversation now, and the entries they produced
// still live in the database and still feed the assistant's context. Two forms
// asking what a conversation should ask was the whole problem.
type Tab = "chat" | "today" | "feed" | "coach" | "lists" | "stats";

const TABS: Tab[] = ["chat", "today", "feed", "coach", "lists", "stats"];

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  // Chat is the default view: the items sidebar starts collapsed so opening the
  // app lands on chat, not the todo/ideas list. The toggle is remembered.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("pa:sidebarOpen") === "1";
    } catch {
      return false;
    }
  });
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    setupNotifications();
    // Honor deep links from notifications, e.g. /?tab=journal
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && (TABS as string[]).includes(t)) setTab(t as Tab);
  }, []);

  // Remember the sidebar preference across sessions.
  useEffect(() => {
    try {
      localStorage.setItem("pa:sidebarOpen", sidebarOpen ? "1" : "0");
    } catch {
      // ignore (private mode etc.)
    }
  }, [sidebarOpen]);

  return (
    <div className="flex h-dvh bg-[#0f0f0f] text-gray-100">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-72" : "w-0"
        } flex-shrink-0 border-r border-white/5 overflow-hidden transition-all duration-200`}
      >
        <ItemsSidebar refreshKey={refreshKey} />
      </aside>

      {/* Main chat area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="w-10 h-10 -ml-2 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <h1 className="text-sm font-semibold text-gray-300 hidden sm:block">
            Personal Assistant
          </h1>

          {/* Tabs */}
          <div className="ml-auto flex gap-1 bg-white/5 rounded-lg p-0.5 overflow-x-auto max-w-full">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 min-h-[36px] rounded-md text-xs font-medium capitalize whitespace-nowrap transition-colors ${
                  tab === t
                    ? "bg-indigo-600 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {tab === "chat" ? (
            <ChatPanel onItemsChange={() => setRefreshKey((k) => k + 1)} />
          ) : tab === "today" ? (
            <TodayPanel />
          ) : tab === "feed" ? (
            <FeedPanel />
          ) : tab === "coach" ? (
            <CoachPanel />
          ) : tab === "lists" ? (
            <ListsPanel refreshKey={refreshKey} />
          ) : (
            <StatsPanel />
          )}
        </div>
      </main>
    </div>
  );
}
