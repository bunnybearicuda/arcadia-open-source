"use client";

import { useEffect, useRef, useState } from "react";

export default function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to the CSS max-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    setValue("");
    onSend(text);
  }

  return (
    <div className="composer-inner">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends on desktop; Shift+Enter is a newline. On touch the
          // on-screen keyboard's return key should just be a return key.
          if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Say something…"
        rows={1}
      />
      <button className="send" onClick={submit} disabled={disabled || !value.trim()}>
        Send
      </button>
    </div>
  );
}
