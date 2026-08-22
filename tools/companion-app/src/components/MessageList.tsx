"use client";

export type ViewMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: string[];
  streaming?: boolean;
};

/** What each tool call looks like when it happens, in plain language. */
const TOOL_LABEL: Record<string, string> = {
  remember: "kept something",
  recall: "went looking through their memory",
  revise_memory: "corrected a memory",
  forget: "let a memory go",
  journal: "wrote in their journal",
  read_journal: "read back through their journal",
};

export default function MessageList({
  messages,
  companionName,
  accent,
}: {
  messages: ViewMessage[];
  companionName: string;
  accent: string;
}) {
  return (
    <>
      {messages.map((m) => (
        <div key={m.id} className="msg" data-role={m.role}>
          <div className="msg-who" style={m.role === "assistant" ? { color: accent } : undefined}>
            {m.role === "user" ? "You" : companionName}
          </div>

          {m.tools.map((tool, i) => (
            <div key={`${m.id}-tool-${i}`} className="tool-note">
              — {TOOL_LABEL[tool] ?? tool}
            </div>
          ))}

          {(m.text || m.streaming) && (
            <div className={`bubble${m.streaming && !m.text ? " cursor" : ""}`}>
              {m.text}
              {m.streaming && m.text && <span className="cursor" />}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
