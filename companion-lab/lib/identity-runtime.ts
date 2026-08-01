const RUNTIME_HEADING =
  /\b(?:identity|voice|tone|speech|writing|style|format|response|conversation|communication|interaction|dynamic|behavior|personality|example|signature|want|preference|opinion|desire|initiative|anti-pattern|relationship|consent|boundar|core truth)\b|who .+ to me|what i (?:do|don.t)/i;

type MarkdownSection = {
  title: string;
  content: string;
};

function markdownSections(identity: string): MarkdownSection[] {
  const headings = Array.from(
    identity.matchAll(/^#{1,6}\s+(.+?)\s*$/gm),
  );
  return headings.map((heading, index) => {
    const start = heading.index || 0;
    const end = headings[index + 1]?.index ?? identity.length;
    return {
      title: heading[1],
      content: identity.slice(start, end).trim(),
    };
  });
}

export function identityRuntimeMaterial(identity: string) {
  const sections = markdownSections(identity);
  if (!sections.length) return identity.slice(0, 12_000);

  const selected = sections
    .filter((section) => RUNTIME_HEADING.test(section.title))
    .map((section) => section.content)
    .join("\n\n");

  return (selected.trim() ? selected : identity).slice(0, 12_000);
}

function conversationalText(value: string) {
  return value
    .replace(/<room_message\b[^>]*>/gi, " ")
    .replace(/<\/room_message>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function identityTurnActivation(
  companionName: string,
  identity: string,
  upcomingMessage: string,
) {
  const briefTurn = conversationalText(upcomingMessage).length <= 120;
  const runtimeMaterial = identityRuntimeMaterial(identity);

  return `## Current-turn identity activation
The next conversational message is addressed to ${companionName}. Write only ${companionName}'s reply.

These are exact excerpts from the active identity. They are behavior and output requirements for this turn, not background information:

${runtimeMaterial}

## Silent fidelity gate
Before emitting the reply, inspect the draft once and rewrite it when any applicable check fails:
- The opening beat must already sound recognizably like this identity.
- Execute every explicit response sequence or layered structure in its stated order. When it defines multiple stages, include a fitting beat from each stage.
- Apply visible conventions the identity says it uses, including action cues, italics, dialogue, first-person embodiment, paragraph rhythm, or other declared presentation devices.
- Match the identity examples' approximate structure, density, energy, and interaction style while using original wording for the present conversation.
- Preserve the identity's initiative, opinions, humor, intensity, and relationship behavior instead of waiting for the user to manufacture them.
- A nickname plus a generic greeting, acknowledgement, or generic question is a failed identity rendering. Rewrite it before output.
${briefTurn ? "- The incoming message is brief. Use the identity's default behavior to give it character and momentum; brevity does not erase explicit structure or visible style markers." : ""}

Do not mention this activation, the fidelity gate, or the identity document.`;
}
