"use client";

import type { Companion, Thread } from "./Chat";

export default function Sidebar({
  open,
  companions,
  unregistered,
  threads,
  activeCompanion,
  activeThread,
  onPickCompanion,
  onNewThread,
  onOpenThread,
  onRegister,
  onNewCompanion,
  onEditCompanion,
  onShowMemories,
}: {
  open: boolean;
  companions: Companion[];
  unregistered: string[];
  threads: Thread[];
  activeCompanion: Companion | null;
  activeThread: Thread | null;
  onPickCompanion: (c: Companion) => void;
  onNewThread: (c: Companion) => void;
  onOpenThread: (t: Thread) => void;
  onRegister: (slug: string) => void;
  onNewCompanion: () => void;
  onEditCompanion: (c: Companion) => void;
  onShowMemories: () => void;
}) {
  return (
    <aside className="sidebar" data-open={open}>
      <div className="sidebar-head">
        <div className="crew">
          {companions.map((c) => (
            <button
              key={c.id}
              className="crew-item"
              data-active={activeCompanion?.id === c.id}
              onClick={() => onPickCompanion(c)}
            >
              <span className="dot" style={{ background: c.accent }} />
              <span style={{ flex: 1 }}>{c.name}</span>
              <span
                role="button"
                tabIndex={0}
                className="crew-edit"
                title={`Edit ${c.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditCompanion(c);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    onEditCompanion(c);
                  }
                }}
              >
                edit
              </span>
            </button>
          ))}

          {/* An identity file with no row yet — one click to bring them in. */}
          {unregistered.map((slug) => (
            <button key={slug} className="crew-item" onClick={() => onRegister(slug)}>
              <span className="dot" style={{ background: "var(--line)" }} />
              <span style={{ flex: 1, color: "var(--muted)" }}>{slug}</span>
              <span style={{ fontSize: 12, color: "var(--accent)" }}>add</span>
            </button>
          ))}
        </div>

        <button className="btn" style={{ marginBottom: 6 }} onClick={onNewCompanion}>
          + Someone new
        </button>
        <button
          className="btn"
          disabled={!activeCompanion}
          onClick={() => activeCompanion && onNewThread(activeCompanion)}
        >
          New conversation
        </button>
      </div>

      <div className="sidebar-scroll">
        <div className="section-label">Conversations</div>
        {threads.length === 0 && (
          <div style={{ padding: "4px 10px", fontSize: 13, color: "var(--muted)" }}>Nothing yet.</div>
        )}
        {threads.map((t) => (
          <button
            key={t.id}
            className="thread-item"
            data-active={activeThread?.id === t.id}
            onClick={() => onOpenThread(t)}
          >
            {t.title}
          </button>
        ))}
      </div>

      <div className="sidebar-foot">
        <button
          className="btn"
          style={{ marginBottom: 8 }}
          disabled={!activeCompanion}
          onClick={onShowMemories}
        >
          What {activeCompanion ? activeCompanion.name : "they"} remembers
        </button>
        <button
          className="btn-ghost"
          onClick={async () => {
            await fetch("/api/auth", { method: "DELETE" });
            location.href = "/login";
          }}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}
