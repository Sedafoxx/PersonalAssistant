"use client";

import { useState, useRef, useEffect } from "react";
import { MessageBubble, type Message, type Choices } from "./MessageBubble";
import { useVoiceInput } from "@/lib/useVoiceInput";

const CHOICES_MARKER = "[[CHOICES]]";

// Split a raw assistant payload into visible text + optional choice buttons.
function splitChoices(raw: string): { text: string; choices?: Choices } {
  const idx = raw.indexOf(CHOICES_MARKER);
  if (idx === -1) return { text: raw };
  const text = raw.slice(0, idx).trim();
  const json = raw.slice(idx + CHOICES_MARKER.length).trim();
  try {
    const parsed = JSON.parse(json) as Choices;
    if (Array.isArray(parsed.options) && parsed.options.length > 0) {
      return { text, choices: parsed };
    }
  } catch {
    // marker not fully streamed yet — show text, hold buttons
  }
  return { text };
}

const WELCOME: Message = {
  role: "assistant",
  content:
    "Hey! I'm your personal assistant. Tell me what's on your mind — I'll help you capture todos, notes, and ideas, set reminders, keep everything organized, and now I can also search the web and read files.",
};

// A stable per-browser id so the assistant remembers this conversation.
function getClientId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem("pa:clientId");
    if (!id) {
      id = window.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem("pa:clientId", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

const TEXT_EXTS = /\.(txt|md|csv|json|ts|tsx|js|jsx|py|sql|html|css|log|ini|yml|yaml|xml)$/i;
const MAX_ATTACH_CHARS = 50000;

export function ChatPanel({ onItemsChange }: { onItemsChange: () => void }) {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachedFile, setAttachedFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientIdRef = useRef<string | null>(null);

  const {
    recording,
    transcribing,
    error: voiceError,
    toggle: toggleRecording,
  } = useVoiceInput((t) =>
    setInput((prev) => (prev ? `${prev} ${t}` : t).trim())
  );

  useEffect(() => {
    clientIdRef.current = getClientId();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const [multiSel, setMultiSel] = useState<Record<number, string[]>>({});

  function send() {
    const text = input.trim();
    if ((!text && !attachedFile) || loading) return;
    setInput("");
    sendText(text);
  }

  // Reads a file into text: plain-text types client-side, everything else
  // (PDF/DOCX/…) via the server parser at /api/upload.
  async function handleFile(file: File) {
    setFileError(null);
    try {
      let text: string;
      if (TEXT_EXTS.test(file.name)) {
        if (file.size > 4 * 1024 * 1024) {
          setFileError("Text file too large (max 4 MB).");
          return;
        }
        text = await file.text();
      } else {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) {
          setFileError(data.error ?? "Upload failed");
          return;
        }
        text = data.text ?? "";
      }
      if (!text.trim()) {
        setFileError("No readable text found in that file.");
        return;
      }
      setAttachedFile({
        name: file.name,
        text: text.slice(0, MAX_ATTACH_CHARS),
      });
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "Could not read file");
    }
  }

  async function sendText(raw: string) {
    if (loading) return;

    const attach = attachedFile;
    if (attach) setAttachedFile(null);
    const displayText =
      raw.trim() || (attach ? `(attached file: ${attach.name})` : "");
    if (!displayText) return;

    // Fold the file content into the user message as context for the model.
    let message = raw.trim();
    if (attach) {
      const fileBlock = `[Attached file: ${attach.name}]\n\`\`\`\n${attach.text}\n\`\`\`\n\n`;
      message = message
        ? `${fileBlock}${message}`
        : `${fileBlock}Please read the attached file and help me with it.`;
    }

    // Mark any pending choice prompt as answered so its buttons disappear.
    const cleared = messages.map((m) =>
      m.choices && !m.answered ? { ...m, answered: true } : m
    );
    const userMessage: Message = { role: "user", content: displayText };
    setMessages([...cleared, userMessage]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Server reconstructs the conversation from per-client memory, so we
        // only send the new message + the stable client id.
        body: JSON.stringify({ message, client_id: clientIdRef.current }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        const { text: visible, choices } = splitChoices(assistantText);
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", content: visible, choices },
        ]);
      }

      onItemsChange();
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function pickSingle(option: string) {
    if (loading) return;
    sendText(option);
  }

  function toggleMulti(idx: number, option: string) {
    setMultiSel((prev) => {
      const cur = prev[idx] ?? [];
      const next = cur.includes(option)
        ? cur.filter((o) => o !== option)
        : [...cur, option];
      return { ...prev, [idx]: next };
    });
  }

  function confirmMulti(idx: number) {
    const sel = multiSel[idx] ?? [];
    if (sel.length === 0 || loading) return;
    setMultiSel((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
    sendText(sel.join(", "));
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((m, i) => (
          <div key={i}>
            <MessageBubble message={m} />
            {m.choices && !m.answered && (
              <div className="ml-9 mb-3 -mt-1 flex flex-wrap gap-2">
                {m.choices.mode === "single"
                  ? m.choices.options.map((opt) => (
                      <button
                        key={opt}
                        onClick={() => pickSingle(opt)}
                        disabled={loading}
                        className="px-3 py-1.5 rounded-full text-sm bg-indigo-600/20 border border-indigo-500/40 text-indigo-200 hover:bg-indigo-600/40 disabled:opacity-40 transition-colors"
                      >
                        {opt}
                      </button>
                    ))
                  : (
                    <>
                      {m.choices.options.map((opt) => {
                        const sel = (multiSel[i] ?? []).includes(opt);
                        return (
                          <button
                            key={opt}
                            onClick={() => toggleMulti(i, opt)}
                            disabled={loading}
                            className={`px-3 py-1.5 rounded-full text-sm border transition-colors disabled:opacity-40 ${
                              sel
                                ? "bg-indigo-600 border-indigo-500 text-white"
                                : "bg-indigo-600/10 border-indigo-500/40 text-indigo-200 hover:bg-indigo-600/30"
                            }`}
                          >
                            {sel ? "✓ " : ""}
                            {opt}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => confirmMulti(i)}
                        disabled={loading || (multiSel[i] ?? []).length === 0}
                        className="px-3 py-1.5 rounded-full text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-30 transition-colors"
                      >
                        Confirm
                      </button>
                    </>
                  )}
              </div>
            )}
          </div>
        ))}
        {loading && messages[messages.length - 1]?.content === "" && (
          <div className="flex justify-start mb-3">
            <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0 mt-1">
              AI
            </div>
            <div className="bg-[#1a1a1a] border border-white/5 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-white/5">
        {/* Attached file chip */}
        {attachedFile && (
          <div className="mb-2 flex items-center gap-2 bg-indigo-600/10 border border-indigo-500/30 rounded-lg px-3 py-1.5 text-xs text-indigo-200">
            <span>📎 {attachedFile.name}</span>
            <span className="text-indigo-400/70">
              ({Math.round(attachedFile.text.length / 1024)} KB loaded)
            </span>
            <button
              onClick={() => setAttachedFile(null)}
              className="ml-auto text-indigo-300 hover:text-white"
              aria-label="Remove file"
            >
              ✕
            </button>
          </div>
        )}
        {fileError && (
          <div className="mb-2 text-xs text-red-400">{fileError}</div>
        )}

        <div className="flex gap-2 items-end bg-[#1a1a1a] border border-white/10 rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            aria-label="Attach file"
            title="Attach a file (txt, pdf, docx, csv, code…)"
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              recording
                ? "Listening… tap mic to stop"
                : transcribing
                ? "Transcribing…"
                : "Message your assistant…"
            }
            rows={1}
            className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none max-h-40 overflow-y-auto leading-relaxed"
            style={{ height: "auto" }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${t.scrollHeight}px`;
            }}
            disabled={loading}
          />
          <button
            onClick={toggleRecording}
            disabled={loading || (transcribing && !recording)}
            aria-label={recording ? "Stop recording" : "Record voice"}
            className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
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
            onClick={send}
            disabled={loading || (!input.trim() && !attachedFile)}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
        <p
          className={`text-xs mt-1.5 text-center ${
            voiceError || fileError ? "text-red-400" : "text-gray-600"
          }`}
        >
          {(voiceError ?? fileError) ??
            "Enter to send · Shift+Enter for new line · 🎤 to dictate · 📎 to attach a file"}
        </p>
      </div>
    </div>
  );
}
