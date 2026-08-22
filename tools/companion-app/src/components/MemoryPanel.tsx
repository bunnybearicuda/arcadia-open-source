"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Companion } from "./Chat";

type Memory = {
  id: string;
  body: string;
  scope: "private" | "shared";
  kind: "core" | "episodic";
  author: "companion" | "human" | "extractor";
  importance: number;
  recall_count: number;
  created_at: string;
};

/**
 * Everything this companion is carrying, in one place, editable.
 *
 * The point of this screen is that nobody has to take anyone's word for how the
 * memories sound. Whoever wrote a memory — them, the background extractor, or
 * you — you can read it, rewrite it in the words you'd actually use, or throw it
 * out. The `author` badge matters most: memories marked "saved on its own" are
 * the ones written without anyone deciding to, so they're the ones worth
 * skimming.
 */

const AUTHOR_LABEL: Record<Memory["author"], string> = {
  companion: "they kept this",
  human: "you added this",
  extractor: "saved on its own",
};

type Filter = "all" | "companion" | "extractor" | "shared";

export default function MemoryPanel({
  companion,
  onClose,
}: {
  companion: Companion;
  onClose: () => void;
}) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newBody, setNewBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/memories?companionId=${companion.id}`);
    if (!res.ok) {
      setError("Couldn't load memories.");
      return;
    }
    setMemories((await res.json()) as Memory[]);
  }, [companion.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    if (!memories) return [];
    if (filter === "all") return memories;
    if (filter === "shared") return memories.filter((m) => m.scope === "shared");
    return memories.filter((m) => m.author === filter);
  }, [memories, filter]);

  async function save(id: string) {
    if (!draft.trim()) return;
    setBusy(true);
    const res = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, body: draft }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Couldn't save that change.");
      return;
    }
    setEditing(null);
    void load();
  }

  async function forget(id: string) {
    setBusy(true);
    const res = await fetch(`/api/memories?id=${id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      setError("Couldn't remove that.");
      return;
    }
    void load();
  }

  async function add() {
    if (!newBody.trim()) return;
    setBusy(true);
    const res = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companionId: companion.id, body: newBody }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Couldn't add that.");
      return;
    }
    setNewBody("");
    setAdding(false);
    void load();
  }

  const counts = useMemo(() => {
    if (!memories) return null;
    return {
      all: memories.length,
      companion: memories.filter((m) => m.author === "companion").length,
      extractor: memories.filter((m) => m.author === "extractor").length,
      shared: memories.filter((m) => m.scope === "shared").length,
    };
  }, [memories]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>What {companion.name} remembers</strong>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="mem-tabs">
          {(
            [
              ["all", "Everything"],
              ["companion", "They kept"],
              ["extractor", "Saved on its own"],
              ["shared", "Shared with everyone"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className="mem-tab"
              data-active={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
              {counts && <span className="mem-count">{counts[key]}</span>}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {error && <div className="error-note">{error}</div>}

          {memories === null && <p style={{ color: "var(--muted)" }}>Loading…</p>}

          {memories !== null && shown.length === 0 && (
            <p style={{ color: "var(--muted)" }}>
              {filter === "all"
                ? "Nothing remembered yet. That's normal early on — most conversations are meant to save nothing."
                : "Nothing here under this filter."}
            </p>
          )}

          <div className="mem-list">
            {shown.map((m) => (
              <div className="mem" key={m.id}>
                <div className="mem-meta">
                  <span className="mem-badge" data-author={m.author}>
                    {AUTHOR_LABEL[m.author]}
                  </span>
                  {m.scope === "shared" && <span className="mem-badge">shared</span>}
                  {m.kind === "core" && <span className="mem-badge">always loaded</span>}
                  <span className="mem-when">{new Date(m.created_at).toLocaleDateString()}</span>
                  {m.recall_count > 0 && (
                    <span className="mem-when">
                      came back {m.recall_count === 1 ? "once" : `${m.recall_count} times`}
                    </span>
                  )}
                </div>

                {editing === m.id ? (
                  <>
                    <textarea
                      className="field"
                      style={{ minHeight: 92, marginTop: 6 }}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                    />
                    <div className="mem-actions">
                      <button className="send" style={{ height: 32 }} disabled={busy} onClick={() => save(m.id)}>
                        Save
                      </button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mem-body">{m.body}</p>
                    <div className="mem-actions">
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          setEditing(m.id);
                          setDraft(m.body);
                        }}
                      >
                        Rewrite
                      </button>
                      <button className="btn-ghost mem-forget" disabled={busy} onClick={() => forget(m.id)}>
                        Forget
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot" style={{ justifyContent: "space-between", gap: 10 }}>
          {adding ? (
            <>
              <textarea
                className="field"
                style={{ minHeight: 60, flex: 1 }}
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Something you want them to carry — in your words."
                autoFocus
              />
              <button className="send" style={{ height: 40 }} disabled={busy} onClick={add}>
                Add
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>
                Rewriting a memory changes what they carry. Forgetting removes it everywhere, Notion included.
              </span>
              <button className="btn" style={{ width: "auto" }} onClick={() => setAdding(true)}>
                Add one
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
