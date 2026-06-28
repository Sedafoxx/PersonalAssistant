"use client";

import { useState, useEffect } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { JournalPanel } from "@/components/journal/JournalPanel";
import { ListsPanel } from "@/components/lists/ListsPanel";
import { ItemsSidebar } from "@/components/sidebar/ItemsSidebar";
import { setupNotifications } from "@/lib/notifications";

type Tab = "chat" | "journal" | "lists";

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    setupNotifications();
    // Honor deep links from notifications, e.g. /?tab=journal
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "journal" || t === "chat" || t === "lists") setTab(t);
  }, []);

  return (
    <div className="flex h-screen bg-[#0f0f0f] text-gray-100">
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
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="Toggle sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
          <h1 className="text-sm font-semibold text-gray-300">Personal Assistant</h1>

          {/* Tabs */}
          <div className="ml-auto flex gap-1 bg-white/5 rounded-lg p-0.5">
            {(["chat", "journal", "lists"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
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
          ) : tab === "journal" ? (
            <JournalPanel />
          ) : (
            <ListsPanel refreshKey={refreshKey} />
          )}
        </div>
      </main>
    </div>
  );
}
