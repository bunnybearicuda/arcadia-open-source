"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(false);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    setBusy(false);
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else {
      setError(true);
      setPasscode("");
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Come in</div>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          autoFocus
          autoComplete="current-password"
        />
        {error && <div style={{ color: "var(--danger)", fontSize: 14 }}>Not that one.</div>}
        <button className="send" style={{ height: 44 }} disabled={busy || !passcode}>
          {busy ? "…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
