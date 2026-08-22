"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSpec } from "@/lib/anthropic";
import Sidebar from "./Sidebar";
import Composer from "./Composer";
import MessageList, { type ViewMessage } from "./MessageList";
import IdentityEditor from "./IdentityEditor";

export type Companion = {
  id: string;
  slug: string;
  name: string;
  identity: string | null;
  identity_source?: "file" | "app" | "none";
  model: string;
  accent: string;
};

export type Thread = {
  id: string;
  title: string;
  companion_id: string | null;
  archived: boolean;
  updated_at: string;
};

type Usage = { in: number; out: number; cached: number };

export default function Chat({ models }: { models: ModelSpec[] }) {
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [unregistered, setUnregistered] = useState<string[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeCompanion, setActiveCompanion] = useState<Companion | null>(null);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string>(models[0].id);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = closed; {companion: null} = creating someone new.
  const [editing, setEditing] = useState<{ companion: Companion | null } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll when she's already at the bottom — yanking the view while
  // she's reading back through a long conversation is infuriating.
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback((force = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (force || pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/companions");
      if (!res.ok) return;
      const data = (await res.json()) as { companions: Companion[]; unregistered: string[] };
      setCompanions(data.companions);
      setUnregistered(data.unregistered);
      if (data.companions.length) {
        setActiveCompanion(data.companions[0]);
        setModel(data.companions[0].model);
      }
    })();
  }, []);

  const refreshThreads = useCallback(async () => {
    const res = await fetch("/api/threads");
    if (res.ok) setThreads((await res.json()) as Thread[]);
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const openThread = useCallback(
    async (thread: Thread) => {
      setSidebarOpen(false);
      setError(null);
      setActiveThread(thread);
      const res = await fetch(`/api/threads/${thread.id}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        thread: Thread;
        messages: { id: string; role: "user" | "assistant"; content: unknown[] }[];
      };
      setMessages(
        data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: extractText(m.content),
          tools: extractToolNames(m.content),
        })),
      );
      const companion = companions.find((c) => c.id === data.thread.companion_id);
      if (companion) {
        setActiveCompanion(companion);
        setModel(companion.model);
      }
      requestAnimationFrame(() => scrollToBottom(true));
    },
    [companions, scrollToBottom],
  );

  const newThread = useCallback(
    async (companion: Companion) => {
      setSidebarOpen(false);
      setError(null);
      setActiveCompanion(companion);
      setModel(companion.model);
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companionId: companion.id }),
      });
      if (!res.ok) return;
      const thread = (await res.json()) as Thread;
      setActiveThread(thread);
      setMessages([]);
      setUsage(null);
      void refreshThreads();
    },
    [refreshThreads],
  );

  const refreshCompanions = useCallback(async (): Promise<Companion[]> => {
    const res = await fetch("/api/companions");
    if (!res.ok) return [];
    const data = (await res.json()) as { companions: Companion[]; unregistered: string[] };
    setCompanions(data.companions);
    setUnregistered(data.unregistered);
    return data.companions;
  }, []);

  const registerCompanion = useCallback(async (slug: string) => {
    const name = slug.charAt(0).toUpperCase() + slug.slice(1);
    const res = await fetch("/api/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, name }),
    });
    if (!res.ok) return;
    const companion = (await res.json()) as Companion;
    setCompanions((prev) => [...prev, companion]);
    setUnregistered((prev) => prev.filter((s) => s !== slug));
    setActiveCompanion(companion);
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!activeCompanion || streaming) return;

      let thread = activeThread;
      if (!thread) {
        const res = await fetch("/api/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companionId: activeCompanion.id }),
        });
        if (!res.ok) return;
        thread = (await res.json()) as Thread;
        setActiveThread(thread);
      }

      setError(null);
      setStreaming(true);
      pinnedRef.current = true;

      const userMessage: ViewMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text,
        tools: [],
      };
      const pending: ViewMessage = {
        id: `pending-${Date.now()}`,
        role: "assistant",
        text: "",
        tools: [],
        streaming: true,
      };
      setMessages((prev) => [...prev, userMessage, pending]);
      requestAnimationFrame(() => scrollToBottom(true));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: thread.id,
            companionId: activeCompanion.id,
            model,
            content: [{ type: "text", text }],
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(res.status === 401 ? "Session expired — reload and log in." : await res.text());
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!eventLine || !dataLine) continue;

            const event = eventLine.slice(7).trim();
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (event === "text") {
              const delta = String(payload.delta ?? "");
              setMessages((prev) =>
                prev.map((m) => (m.id === pending.id ? { ...m, text: m.text + delta } : m)),
              );
              scrollToBottom();
            } else if (event === "tool") {
              const name = String(payload.name ?? "");
              setMessages((prev) =>
                prev.map((m) => (m.id === pending.id ? { ...m, tools: [...m.tools, name] } : m)),
              );
              scrollToBottom();
            } else if (event === "done") {
              setUsage((payload.usage as Usage | null) ?? null);
            } else if (event === "error") {
              setError(String(payload.message ?? "Something went wrong."));
            }
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setMessages((prev) =>
          prev.map((m) => (m.id === pending.id ? { ...m, streaming: false } : m)),
        );
        setStreaming(false);
        void refreshThreads();
      }
    },
    [activeCompanion, activeThread, model, streaming, refreshThreads, scrollToBottom],
  );

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        onNewCompanion={() => setEditing({ companion: null })}
        onEditCompanion={(c) => setEditing({ companion: c })}
        companions={companions}
        unregistered={unregistered}
        threads={threads}
        activeCompanion={activeCompanion}
        activeThread={activeThread}
        onPickCompanion={(c) => {
          setActiveCompanion(c);
          setModel(c.model);
        }}
        onNewThread={newThread}
        onOpenThread={openThread}
        onRegister={registerCompanion}
      />
      {sidebarOpen && <button className="scrim" onClick={() => setSidebarOpen(false)} aria-label="Close menu" />}

      {editing && (
        <IdentityEditor
          companion={editing.companion}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            const all = await refreshCompanions();
            const fresh = all.find((c) => c.id === saved.id) ?? saved;
            setActiveCompanion(fresh);
            setModel(fresh.model);
          }}
        />
      )}

      <div className="main">
        <div className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <div className="topbar-title">
            {activeThread?.title ?? (activeCompanion ? activeCompanion.name : "Companions")}
          </div>
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          <div className="messages-inner">
            {messages.length === 0 && !streaming ? (
              <div className="empty">
                {companions.length === 0 ? (
                  <>
                    <div>No one lives here yet.</div>
                    <button
                      className="btn"
                      style={{ width: "auto", marginTop: 6 }}
                      onClick={() => setEditing({ companion: null })}
                    >
                      Write someone
                    </button>
                  </>
                ) : (
                  <div>{activeCompanion ? `Say something to ${activeCompanion.name}.` : "Pick someone."}</div>
                )}
              </div>
            ) : (
              <MessageList
                messages={messages}
                companionName={activeCompanion?.name ?? "them"}
                accent={activeCompanion?.accent ?? "var(--accent)"}
              />
            )}
            {error && <div className="error-note">{error}</div>}
          </div>
        </div>

        <div className="composer">
          <Composer disabled={!activeCompanion || streaming} onSend={send} />
          {usage && (
            <div className="usage">
              {usage.in.toLocaleString()} in · {usage.out.toLocaleString()} out
              {usage.cached > 0 && ` · ${usage.cached.toLocaleString()} cached`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function extractText(content: unknown[]): string {
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function extractToolNames(content: unknown[]): string[] {
  return content
    .filter(
      (b): b is { type: "tool_use"; name: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use",
    )
    .map((b) => b.name);
}
