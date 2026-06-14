"use client";

import { useState, useEffect } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { ItemsSidebar } from "@/components/sidebar/ItemsSidebar";
import { setupNotifications } from "@/lib/notifications";

export default function Home() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    setupNotifications();
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
        </div>

        <div className="flex-1 overflow-hidden">
          <ChatPanel onItemsChange={() => setRefreshKey((k) => k + 1)} />
        </div>
      </main>
    </div>
  );
}
