"use client";

import { useState } from "react";
import { STARTER_IDENTITY } from "@/lib/starter-identity";
import type { Companion } from "./Chat";

/**
 * Write a companion without touching a terminal.
 *
 * When their personality lives in identities/<slug>.md, that file wins and this
 * editor says so rather than pretending to save over it.
 */
export default function IdentityEditor({
  companion,
  onClose,
  onSaved,
}: {
  companion: Companion | null; // null = creating someone new
  onClose: () => void;
  onSaved: (c: Companion) => void;
}) {
  const [name, setName] = useState(companion?.name ?? "");
  const [identity, setIdentity] = useState(companion?.identity ?? STARTER_IDENTITY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileBacked = companion?.identity_source === "file";

  async function save() {
    if (!name.trim()) {
      setError("They need a name.");
      return;
    }
    setBusy(true);
    setError(null);

    const res = await fetch("/api/companions", {
      method: companion ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        companion
          ? { id: companion.id, name: name.trim(), identity }
          : { name: name.trim(), identity },
      ),
    });

    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Couldn't save that.");
      return;
    }
    onSaved((await res.json()) as Companion);
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{companion ? `Editing ${companion.name}` : "Someone new"}</strong>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modal-body">
          <label className="field-label">Name</label>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What do you call them?"
            autoFocus={!companion}
          />

          <label className="field-label">
            Who they are
            <span className="field-hint">
              {fileBacked
                ? "This one is loaded from their file on disk — editing here won't change them."
                : "Plain writing. This is loaded at the top of every message they see."}
            </span>
          </label>
          <textarea
            className="field field-tall"
            value={fileBacked ? "" : identity}
            onChange={(e) => setIdentity(e.target.value)}
            disabled={fileBacked}
            placeholder={fileBacked ? `Edit identities/${companion?.slug}.md instead.` : undefined}
            spellCheck
          />

          {error && <div className="error-note">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="send" onClick={save} disabled={busy}>
            {busy ? "Saving…" : companion ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
