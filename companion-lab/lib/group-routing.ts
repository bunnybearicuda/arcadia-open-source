export type GroupRoutingMember = {
  id: string;
  name: string;
};

export const MAX_GROUP_HANDOFFS = 2;

export type GroupReplyReference = {
  messageId: string;
  speakerName: string;
};

type ToolCallState = {
  name: string;
  arguments: string;
};

export function providerToolTracker(
  provider: "anthropic" | "openai" | "openrouter",
  allowedCompanionIds: Set<string>,
) {
  const calls = new Map<string, ToolCallState>();
  const upsert = (key: string, name?: unknown, argumentsDelta?: unknown, replace = false) => {
    const existing = calls.get(key) || { name: "", arguments: "" };
    if (typeof name === "string" && name) existing.name = name;
    if (typeof argumentsDelta === "string") {
      existing.arguments = replace ? argumentsDelta : existing.arguments + argumentsDelta;
    } else if (argumentsDelta && typeof argumentsDelta === "object") {
      const serialized = JSON.stringify(argumentsDelta);
      if (serialized !== "{}") existing.arguments = serialized;
    }
    calls.set(key, existing);
  };
  return {
    consume(event: Record<string, unknown>) {
      if (provider === "anthropic") {
        if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            upsert(String(event.index ?? block.id ?? calls.size), block.name, block.input);
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "input_json_delta") {
            upsert(String(event.index ?? calls.size), undefined, delta.partial_json);
          }
        }
        return;
      }
      if (provider === "openai") {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          (event.type === "response.output_item.added" ||
            event.type === "response.output_item.done") &&
          item?.type === "function_call"
        ) {
          upsert(
            String(item.id ?? event.output_index ?? calls.size),
            item.name,
            item.arguments,
            event.type === "response.output_item.done",
          );
        } else if (
          event.type === "response.function_call_arguments.delta" ||
          event.type === "response.function_call_arguments.done"
        ) {
          upsert(
            String(event.item_id ?? event.output_index ?? calls.size),
            undefined,
            event.type === "response.function_call_arguments.done"
              ? event.arguments
              : event.delta,
            event.type === "response.function_call_arguments.done",
          );
        }
        return;
      }
      const choices = Array.isArray(event.choices)
        ? (event.choices as Array<Record<string, unknown>>)
        : [];
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      const toolCalls = Array.isArray(delta?.tool_calls)
        ? (delta.tool_calls as Array<Record<string, unknown>>)
        : [];
      for (const toolCall of toolCalls) {
        const fn = toolCall.function as Record<string, unknown> | undefined;
        upsert(String(toolCall.index ?? toolCall.id ?? calls.size), fn?.name, fn?.arguments);
      }
    },
    results() {
      const seen = new Set<string>();
      const result: Array<{ companionId: string }> = [];
      for (const call of calls.values()) {
        if (call.name !== "call_companion") continue;
        try {
          const value = JSON.parse(call.arguments || "{}") as { companion_id?: unknown };
          const companionId =
            typeof value.companion_id === "string" ? value.companion_id : "";
          if (companionId && allowedCompanionIds.has(companionId) && !seen.has(companionId)) {
            seen.add(companionId);
            result.push({ companionId });
          }
        } catch {
          // Incomplete provider tool payloads are ignored rather than guessed.
        }
      }
      return result;
    },
    // Every accumulated call, for callers that route tools other than
    // call_companion (connectors).
    allCalls() {
      return [...calls.values()]
        .filter((call) => call.name)
        .map((call) => ({ name: call.name, arguments: call.arguments }));
    },
  };
}

export function groupReplyTarget(
  source: "becca" | "companion",
  queuedTarget: GroupReplyReference,
  beccaMessageId: string,
  previousCompanionReply: GroupReplyReference | null,
) {
  void previousCompanionReply;
  if (source === "companion") return queuedTarget;
  return {
    messageId: beccaMessageId,
    speakerName: "Becca",
  };
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionedGroupMemberIds(
  text: string,
  members: GroupRoutingMember[],
) {
  if (mentionsEveryone(text)) {
    return members.map((member) => member.id);
  }
  return members
    .map((member) => {
      const match = new RegExp(
        `(^|\\s)@${escapedPattern(member.name)}(?=\\s|[.,!?;:]|$)`,
        "i",
      ).exec(text);
      return { id: member.id, index: match?.index ?? -1 };
    })
    .filter((mention) => mention.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((mention) => mention.id);
}

export function mentionsEveryone(text: string) {
  return /(^|\s)@everyone(?=\s|[.,!?;:]|$)/i.test(text);
}
