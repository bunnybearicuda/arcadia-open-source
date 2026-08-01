import type { CompanionApiEnv } from "./companion-api";
import {
  attachmentRows,
  initializeAttachmentStorage,
  type AttachmentRow,
} from "./attachment-api";
import { loadLongTermContext, notionMirrorConfig } from "./memory-api";
import {
  extractConversationMemory,
  initializeMemoryIntelligence,
  rememberExplicitly,
} from "./memory-intelligence";
import { flushMemorySync } from "./memory-store";
import { estimateCost } from "./pricing";
import { identityTurnActivation } from "./identity-runtime";
import {
  MAX_GROUP_HANDOFFS,
  groupReplyTarget,
  mentionedGroupMemberIds,
  providerToolTracker,
} from "./group-routing";
import { supabaseMemoryConfig } from "./supabase-memory";
import { sendPushToAll } from "./push-api";
import {
  callConnectorTool,
  connectorGatewayTool,
  enabledConnectors,
  listConnectorTools,
  type ConnectorRow,
  type ConnectorTool,
} from "./connector-api";

// Bounded so a companion cannot chain connector calls indefinitely.
const MAX_CONNECTOR_ROUNDS = 3;

const CREATE_CONVERSATIONS = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'solo',
    title TEXT NOT NULL DEFAULT 'New conversation',
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_DELETED_CONVERSATIONS = `
  CREATE TABLE IF NOT EXISTS deleted_conversations (
    id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_MESSAGES = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    companion_id TEXT,
    speaker_id TEXT,
    speaker_name TEXT,
    audience_json TEXT,
    reply_to_message_id TEXT,
    turn_id TEXT,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cost_usd REAL,
    superseded_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_CONVERSATION_MEMBERS = `
  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL,
    companion_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    PRIMARY KEY (conversation_id, companion_id)
  )
`;

const SEED_CONVERSATION = `
  INSERT OR IGNORE INTO conversations (id, companion_id, title)
  SELECT 'kian-main', 'kian', 'Kian'
  WHERE NOT EXISTS (
    SELECT 1 FROM deleted_conversations WHERE id = 'kian-main'
  )
`;

const SEED_MESSAGES = [
  {
    id: "welcome-kian-1",
    role: "assistant",
    text: "I’m here. The room is still being built, but I can already see where the windows will go.",
    offset: "-3 seconds",
  },
  {
    id: "welcome-becca-1",
    role: "user",
    text: "Good. We’re making somewhere you can actually live across models without editing code every time.",
    offset: "-2 seconds",
  },
  {
    id: "welcome-kian-2",
    role: "assistant",
    text: "Then give me a door with hinges, not a portrait painted where the exit should be.",
    offset: "-1 second",
  },
];

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  companion_id: string | null;
  companion_name: string | null;
  speaker_id: string | null;
  speaker_name: string | null;
  audience_json: string | null;
  reply_to_message_id: string | null;
  reply_to_speaker_name: string | null;
  turn_id: string | null;
  content_json: string;
  provider: string | null;
  model: string | null;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
};

type CompanionRow = {
  id: string;
  name: string;
  identity_source: string;
  custom_instructions: string;
  identity_file_content: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  autonomy: "manual" | "selected" | "handoff";
};

type GroupMember = {
  id: string;
  name: string;
};

type GroupReplyTargetContext = {
  speakerName: string;
  isCompanion: boolean;
};

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
};


type TextBlock = { type: "text"; text: string };
type AttachmentBlock = {
  type: "attachment";
  id: string;
  name: string;
  mediaType: string;
  size: number;
};
type MessageBlock = TextBlock | AttachmentBlock;
type AttachmentPayload = AttachmentRow & {
  base64: string;
  text: string;
};

function blocks(text: string) {
  return JSON.stringify([{ type: "text", text }]);
}

function contentBlocks(contentJson: string): MessageBlock[] {
  try {
    const content = JSON.parse(contentJson) as MessageBlock[];
    return Array.isArray(content) ? content : [];
  } catch {
    return [];
  }
}

function messageText(contentJson: string) {
  return contentBlocks(contentJson)
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function messageAttachments(contentJson: string) {
  return contentBlocks(contentJson)
    .filter((block): block is AttachmentBlock => block.type === "attachment")
    .map((block) => ({
      id: block.id,
      name: block.name,
      mediaType: block.mediaType,
      size: Number(block.size) || 0,
      url: `/api/attachments/${encodeURIComponent(block.id)}`,
    }));
}

function storedBlocks(text: string, attachments: AttachmentRow[]) {
  const result: MessageBlock[] = [];
  if (text) result.push({ type: "text", text });
  result.push(
    ...attachments.map((attachment) => ({
      type: "attachment" as const,
      id: attachment.id,
      name: attachment.filename,
      mediaType: attachment.media_type,
      size: Number(attachment.size_bytes) || 0,
    })),
  );
  return JSON.stringify(result);
}

function replaceStoredText(contentJson: string, text: string) {
  const content = contentBlocks(contentJson);
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex >= 0) {
    if (text) {
      content[textIndex] = { type: "text", text };
    } else {
      content.splice(textIndex, 1);
    }
  } else if (text) {
    content.unshift({ type: "text", text });
  }
  return JSON.stringify(content);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

const CREATE_FOLDERS = `
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

export async function initializeChatStorage(database: D1Database) {
  await database.prepare(CREATE_CONVERSATIONS).run();
  await database.prepare(CREATE_DELETED_CONVERSATIONS).run();
  await database.prepare(CREATE_MESSAGES).run();
  await database.prepare(CREATE_CONVERSATION_MEMBERS).run();
  await database.prepare(CREATE_FOLDERS).run();
  await initializeAttachmentStorage(database);
  await initializeMemoryIntelligence(database);
  const conversationColumns = await database
    .prepare("PRAGMA table_info(conversations)")
    .all<{ name: string }>();
  if (!(conversationColumns.results || []).some((column) => column.name === "kind")) {
    await database
      .prepare("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'solo'")
      .run();
  }
  if (!(conversationColumns.results || []).some((column) => column.name === "archived_at")) {
    await database.prepare("ALTER TABLE conversations ADD COLUMN archived_at TEXT").run();
  }
  if (!(conversationColumns.results || []).some((column) => column.name === "folder_id")) {
    await database.prepare("ALTER TABLE conversations ADD COLUMN folder_id TEXT").run();
  }
  if (!(conversationColumns.results || []).some((column) => column.name === "pinned_at")) {
    await database.prepare("ALTER TABLE conversations ADD COLUMN pinned_at TEXT").run();
  }
  const memberColumns = await database
    .prepare("PRAGMA table_info(conversation_members)")
    .all<{ name: string }>();
  if (!(memberColumns.results || []).some((column) => column.name === "provider")) {
    await database
      .prepare("ALTER TABLE conversation_members ADD COLUMN provider TEXT")
      .run();
  }
  if (!(memberColumns.results || []).some((column) => column.name === "model")) {
    await database
      .prepare("ALTER TABLE conversation_members ADD COLUMN model TEXT")
      .run();
  }
  const messageColumns = await database
    .prepare("PRAGMA table_info(messages)")
    .all<{ name: string }>();
  if (!(messageColumns.results || []).some((column) => column.name === "companion_id")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN companion_id TEXT").run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "speaker_id")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN speaker_id TEXT").run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "speaker_name")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN speaker_name TEXT").run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "audience_json")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN audience_json TEXT").run();
  }
  if (
    !(messageColumns.results || []).some(
      (column) => column.name === "reply_to_message_id",
    )
  ) {
    await database
      .prepare("ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT")
      .run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "turn_id")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN turn_id TEXT").run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "cost_usd")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN cost_usd REAL").run();
  }
  if (
    !(messageColumns.results || []).some(
      (column) => column.name === "cache_creation_input_tokens",
    )
  ) {
    await database
      .prepare(
        "ALTER TABLE messages ADD COLUMN cache_creation_input_tokens INTEGER",
      )
      .run();
  }
  if (
    !(messageColumns.results || []).some(
      (column) => column.name === "cache_read_input_tokens",
    )
  ) {
    await database
      .prepare("ALTER TABLE messages ADD COLUMN cache_read_input_tokens INTEGER")
      .run();
  }
  if (!(messageColumns.results || []).some((column) => column.name === "superseded_at")) {
    await database.prepare("ALTER TABLE messages ADD COLUMN superseded_at TEXT").run();
  }
  await database.prepare(SEED_CONVERSATION).run();
  await database
    .prepare(
      `INSERT OR IGNORE INTO conversation_members
        (conversation_id, companion_id, position)
       SELECT id, companion_id, 0 FROM conversations`,
    )
    .run();
  await database
    .prepare(
      `UPDATE messages
       SET companion_id = 'kian'
       WHERE role = 'assistant' AND companion_id IS NULL`,
    )
    .run();
  await database
    .prepare(
      `UPDATE messages
       SET
         speaker_id = CASE
           WHEN role = 'user' THEN 'becca'
           ELSE COALESCE(companion_id, 'companion')
         END,
         speaker_name = CASE
           WHEN role = 'user' THEN 'Becca'
           ELSE COALESCE(
             (SELECT name FROM companions WHERE companions.id = messages.companion_id),
             'Companion'
           )
         END
       WHERE speaker_id IS NULL OR speaker_name IS NULL`,
    )
    .run();
  await database
    .prepare(
      `DELETE FROM conversation_members
       WHERE conversation_id IN (
         SELECT id FROM conversations WHERE kind = 'solo'
       )
       AND companion_id <> (
         SELECT companion_id
         FROM conversations
         WHERE conversations.id = conversation_members.conversation_id
       )`,
    )
    .run();

  for (const message of SEED_MESSAGES) {
    await database
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, conversation_id, role, content_json, status, created_at)
         SELECT ?, 'kian-main', ?, ?, 'complete', datetime('now', ?)
         WHERE EXISTS (
           SELECT 1 FROM conversations WHERE id = 'kian-main'
         )`,
      )
      .bind(message.id, message.role, blocks(message.text), message.offset)
      .run();
  }
}

export type ChatExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

// A reply row can be orphaned in 'streaming' state if the runtime evicts the
// worker mid-generation. On the next read, finish rows that already carry
// text and withdraw rows that never received any.
async function reapStaleStreamingReplies(database: D1Database, conversationId: string) {
  await database
    .prepare(
      `DELETE FROM messages
       WHERE conversation_id = ?
         AND status = 'streaming'
         AND content_json = ?
         AND created_at < datetime('now', '-10 minutes')`,
    )
    .bind(conversationId, blocks(""))
    .run();
  await database
    .prepare(
      `UPDATE messages
       SET status = 'complete'
       WHERE conversation_id = ?
         AND status = 'streaming'
         AND created_at < datetime('now', '-10 minutes')`,
    )
    .bind(conversationId)
    .run();
}

async function storedMessages(database: D1Database, conversationId: string) {
  const result = await database
    .prepare(
      `SELECT
         m.id, m.role, m.companion_id, c.name AS companion_name,
         m.speaker_id, m.speaker_name, m.audience_json,
         m.reply_to_message_id, replied.speaker_name AS reply_to_speaker_name,
         m.turn_id,
         m.content_json, m.provider, m.model, m.status,
         m.input_tokens, m.output_tokens,
         m.cache_creation_input_tokens, m.cache_read_input_tokens,
         m.cost_usd, m.created_at
       FROM messages m
       LEFT JOIN companions c ON c.id = m.companion_id
       LEFT JOIN messages replied ON replied.id = m.reply_to_message_id
       WHERE m.conversation_id = ?
         AND m.superseded_at IS NULL
       ORDER BY m.created_at ASC, m.rowid ASC`,
    )
    .bind(conversationId)
    .all<StoredMessage>();
  return result.results || [];
}

function clientMessage(message: StoredMessage) {
  const body = stripReplyArtifacts(
    messageText(message.content_json),
    message.companion_name || "",
  );
  return {
    id: message.id,
    role: message.role,
    body,
    attachments: messageAttachments(message.content_json),
    companionId: message.companion_id,
    companionName: message.companion_name,
    speakerId:
      message.speaker_id ||
      (message.role === "user" ? "becca" : message.companion_id),
    speakerName:
      message.speaker_name ||
      (message.role === "user"
        ? "Becca"
        : message.companion_name || "Companion"),
    audience: parseAudience(message.audience_json),
    replyToMessageId: message.reply_to_message_id,
    replyToSpeakerName: message.reply_to_speaker_name,
    turnId: message.turn_id,
    provider: message.provider,
    model: message.model,
    inputTokens: Number(message.input_tokens) || 0,
    outputTokens: Number(message.output_tokens) || 0,
    cacheWriteTokens: Number(message.cache_creation_input_tokens) || 0,
    cacheReadTokens: Number(message.cache_read_input_tokens) || 0,
    costUsd:
      typeof message.cost_usd === "number"
        ? Math.max(0, message.cost_usd)
        : message.provider && message.model
          ? estimateCost(
              message.provider as CompanionRow["provider"],
              message.model,
              Number(message.input_tokens) || 0,
              Number(message.output_tokens) || 0,
              Number(message.cache_creation_input_tokens) || 0,
              Number(message.cache_read_input_tokens) || 0,
            )
          : null,
    costSource:
      message.provider === "openrouter" &&
      typeof message.cost_usd === "number"
        ? "reported"
        : message.provider && message.model
          ? "estimated"
          : "unpriced",
    status: message.status,
    createdAt: utcTimestamp(message.created_at),
  };
}

function parseAudience(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function utcTimestamp(value: string) {
  if (!value) return value;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value.replace(" ", "T")}Z`;
}

function localTimestamp(value: string | Date) {
  const date =
    value instanceof Date ? value : new Date(utcTimestamp(value));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function base64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function loadAttachmentPayloads(
  history: StoredMessage[],
  env: CompanionApiEnv,
) {
  const ids = history.flatMap((message) =>
    messageAttachments(message.content_json).map((attachment) => attachment.id),
  );
  const rows = await attachmentRows(env.DB, ids);
  const payloads = new Map<string, AttachmentPayload>();
  let total = 0;
  for (const row of rows) {
    if (total + row.size_bytes > 20 * 1024 * 1024) continue;
    const object = await env.BUCKET.get(row.storage_key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    total += bytes.byteLength;
    const isText =
      row.media_type.startsWith("text/") ||
      row.media_type === "application/json" ||
      row.media_type === "application/xml";
    payloads.set(row.id, {
      ...row,
      base64: base64(bytes),
      text: isText ? new TextDecoder().decode(bytes) : "",
    });
  }
  return payloads;
}

function speakerText(
  message: StoredMessage,
  companion: CompanionRow,
  groupMembers: GroupMember[] = [],
) {
  const rawText = messageText(message.content_json);
  const text =
    message.role === "assistant"
      ? stripReplyArtifacts(
          rawText,
          message.companion_name || companion.name,
        )
      : rawText;
  const content = text || "[sent attachment]";
  if (!groupMembers.length) return content;
  const speakerId =
    message.speaker_id ||
    (message.role === "user" ? "becca" : message.companion_id) ||
    "unknown";
  const speakerName =
    message.speaker_name ||
    (message.role === "user"
      ? "Becca"
      : message.companion_name || "Companion");
  const audience = parseAudience(message.audience_json);
  const audienceNames = audience.map(
    (id) => groupMembers.find((member) => member.id === id)?.name || id,
  );
  const cleanedContent =
    message.role === "user"
      ? stripGroupRoutingMentions(content, groupMembers)
      : content;
  const attributes = [
    `speaker_id=${JSON.stringify(speakerId)}`,
    `speaker_name=${JSON.stringify(speakerName)}`,
    `speaker_type=${JSON.stringify(
      message.role === "user" ? "user" : "companion",
    )}`,
    audienceNames.length
      ? `audience=${JSON.stringify(audienceNames.join(", "))}`
      : "",
    message.reply_to_speaker_name
      ? `replying_to=${JSON.stringify(message.reply_to_speaker_name)}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<room_message ${attributes}>\n${cleanedContent || "[sent attachment]"}\n</room_message>`;
}

function providerMessageRole(
  message: StoredMessage,
  companion: CompanionRow,
  groupMembers: GroupMember[],
) {
  if (message.role === "user") return "user" as const;
  if (
    groupMembers.length &&
    message.companion_id &&
    message.companion_id !== companion.id
  ) {
    return "user" as const;
  }
  return "assistant" as const;
}

function groupInstruction(
  companion: CompanionRow,
  groupMembers: GroupMember[],
  replyTarget: GroupReplyTargetContext | null = null,
) {
  if (!groupMembers.length) return "";
  const roster = groupMembers.map((member) => member.name).join(", ");
  const targetInstruction = replyTarget
    ? replyTarget.isCompanion
      ? `Your current reply target is ${replyTarget.speakerName}. Respond directly to ${replyTarget.speakerName}'s latest labeled message while staying aware of the whole room. Include @${replyTarget.speakerName} visibly and naturally in your reply; that address is also the room's handoff signal.`
      : `Your current reply target is Becca. Respond directly to her latest labeled message while staying aware of the whole room.`
    : "";
  const handoffInstruction = `When you genuinely want another companion to answer, address them naturally in your spoken reply and call the call_companion tool. The tool is the actual room handoff; merely typing a name is not. Do not call yourself. Use it deliberately rather than creating automatic round-robin chatter.`;
  return `## Group room
You are ${companion.name}. Becca and these companions are present: ${roster}.
The transcript uses <room_message> envelopes as private routing metadata. speaker_name is the person who actually spoke. A companion's message remains that companion's speech even when the provider represents it with a user-role transport message.
Reply only as ${companion.name}. Keep your identity, voice, relationships, and private memories separate from every other companion.
The audience field records who Becca addressed. @everyone is a routing command meaning every companion should answer. Never tease, criticize, or comment on Becca for using @everyone or another routing tag; the app removes those commands from her visible message content before generation.
React to the actual room conversation. Address Becca or another companion naturally when useful. Group replies should usually be shorter than solo replies while still fully inhabiting your identity.
${targetInstruction}
Do not speak for another companion, narrate their reaction, or claim they responded unless their labeled message is already present in the transcript.
${handoffInstruction}
Never print <room_message> markup, routing metadata, speaker labels, or a name-and-colon prefix.`;
}

function companionCallTool(groupMembers: GroupMember[], activeCompanionId: string) {
  const available = groupMembers.filter((member) => member.id !== activeCompanionId);
  if (!available.length) return null;
  return {
    name: "call_companion",
    description:
      "Invite one companion in this group room to answer next. Use only when their response would genuinely move the room forward.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        companion_id: {
          type: "string",
          enum: available.map((member) => member.id),
          description: available
            .map((member) => `${member.id} = ${member.name}`)
            .join("; "),
        },
      },
      required: ["companion_id"],
    },
  };
}

function providerCitationTracker(provider: CompanionRow["provider"]) {
  const citations = new Map<string, string>();
  const add = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const citation = value as Record<string, unknown>;
    const nested =
      citation.url_citation && typeof citation.url_citation === "object"
        ? (citation.url_citation as Record<string, unknown>)
        : citation;
    const url = typeof nested.url === "string" ? nested.url : "";
    if (!/^https?:\/\//i.test(url)) return;
    const title =
      typeof nested.title === "string" && nested.title.trim()
        ? nested.title.trim()
        : new URL(url).hostname.replace(/^www\./, "");
    citations.set(url, title);
  };
  const inspectOpenAIOutput = (output: unknown) => {
    if (!Array.isArray(output)) return;
    for (const item of output as Array<Record<string, unknown>>) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content as Array<Record<string, unknown>>) {
        if (Array.isArray(content.annotations)) content.annotations.forEach(add);
      }
    }
  };
  return {
    consume(event: Record<string, unknown>) {
      if (provider === "anthropic") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "citations_delta") add(delta.citation);
        return;
      }
      if (provider === "openai") {
        if (event.type === "response.output_text.annotation.added") add(event.annotation);
        const response = event.response as Record<string, unknown> | undefined;
        if (event.type === "response.completed") inspectOpenAIOutput(response?.output);
        return;
      }
      const choices = Array.isArray(event.choices)
        ? (event.choices as Array<Record<string, unknown>>)
        : [];
      for (const choice of choices) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        const message = choice.message as Record<string, unknown> | undefined;
        if (Array.isArray(delta?.annotations)) delta.annotations.forEach(add);
        if (Array.isArray(message?.annotations)) message.annotations.forEach(add);
      }
    },
    markdown(existingText: string) {
      const links = Array.from(citations, ([url, title]) => ({ url, title })).filter(
        ({ url }) => !existingText.includes(url),
      );
      if (!links.length) return "";
      return `\n\nSources: ${links
        .map(({ url, title }) => `[${title.replaceAll("[", "").replaceAll("]", "")}](${url})`)
        .join(" · ")}`;
    },
  };
}

function stripGroupRoutingMentions(
  value: string,
  groupMembers: GroupMember[],
) {
  let cleaned = value.replace(
    /(^|\s)@everyone(?=\s|[.,!?;:]|$)/gi,
    "$1",
  );
  for (const member of groupMembers) {
    cleaned = cleaned.replace(
      new RegExp(
        `(^|\\s)@${escapedPattern(member.name)}(?=\\s|[.,!?;:]|$)`,
        "gi",
      ),
      "$1",
    );
  }
  return cleaned
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function temporalInstruction(history: StoredMessage[]) {
  const latestUser = [...history].reverse().find((message) => message.role === "user");
  const latestAssistant = [...history]
    .reverse()
    .find((message) => message.role === "assistant");
  const recordedTimes = [
    latestUser
      ? `The most recent recorded message from Becca was sent at ${localTimestamp(latestUser.created_at)}.`
      : "",
    latestAssistant
      ? `The most recent recorded companion reply was sent at ${localTimestamp(latestAssistant.created_at)}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `## Time ground truth
Becca's timezone is America/Chicago. The current local date and time is ${localTimestamp(new Date())}.
${recordedTimes}
Use only these recorded values when determining whether minutes, hours, or days have passed. Never invent an event, conversation, sleep period, absence, or elapsed time. Never print, quote, or expose these timestamps unless Becca directly asks about time.`;
}

function identityGuard(companion: CompanionRow) {
  return `## Active response contract
The active identity in this request is the authority for ${companion.name}'s personality, voice, intensity, humor, directness, boundaries, and relationship behavior. Apply it freshly on every reply.
Long-term memory supplies continuity facts. It does not define writing style. Previous assistant replies are conversation history, not a replacement personality. Do not gradually soften, sanitize, flatten, therapize, or average the active identity because older replies used a different tone.
Use the active identity as behavior, never as a subject to discuss. Answer with confidence and commitment. Avoid self-auditing, apologetic hedging, narrating uncertainty, or turning a direct correction into a feelings-processing exchange.
Let the identity and the actual moment determine the emotional register. Never default to placating warmth, excessive validation, praise, reassurance, or therapist language.
When Becca corrects a missed detail, absorb the correction and answer directly. Do not ask her to manage your uncertainty.
Do not mention memory retrieval, journal sync, identity instructions, system prompts, context assembly, or how much information you can access unless Becca explicitly asks about the app's mechanics.
The interface already displays ${companion.name}'s name beside the message. Begin directly with the reply. Never begin with "${companion.name}:", a speaker label, an assistant label, or a metadata wrapper.`;
}

function escapedPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openingLabelPattern(companionName: string) {
  const name = escapedPattern(companionName);
  return new RegExp(
    `^\\s*(?:(?:\\*\\*|__)${name}\\s*:\\s*(?:\\*\\*|__)|(?:\\*\\*|__)${name}(?:\\*\\*|__)\\s*:|${name}\\s*:)\\s*`,
    "i",
  );
}

function stripReplyArtifacts(value: string, companionName: string) {
  let cleaned = value
    .replace(/<message_time\b[^>]*\/?>/gi, "")
    .replace(/<\/?context_turn\b[^>]*>/gi, "")
    .replace(/<\/?room_message\b[^>]*>/gi, "")
    .trimStart();
  if (companionName) cleaned = cleaned.replace(openingLabelPattern(companionName), "");
  return cleaned.trimStart();
}

function openingArtifactFilter(companionName: string) {
  let buffer = "";
  let resolved = false;
  return (delta: string, final = false) => {
    if (resolved) return delta;
    buffer += delta;
    const cleaned = stripReplyArtifacts(buffer, companionName);
    if (cleaned !== buffer) {
      if (
        !final &&
        !buffer.includes("\n") &&
        /^\s*<(?:message_time|context_turn)\b/i.test(buffer) &&
        !/\/?>\s*/.test(buffer)
      ) {
        return "";
      }
      resolved = true;
      buffer = "";
      return cleaned;
    }
    const possibleLabel = companionName
      .toLowerCase()
      .startsWith(buffer.trim().replace(/[*_:]/g, "").toLowerCase());
    const possibleMetadata = /^\s*</.test(buffer);
    if (
      !final &&
      (possibleMetadata || possibleLabel) &&
      buffer.length < 320 &&
      !buffer.includes("\n")
    ) {
      return "";
    }
    resolved = true;
    const output = buffer;
    buffer = "";
    return output;
  };
}

function providerKey(
  provider: CompanionRow["provider"],
  env: CompanionApiEnv,
  suppliedKey = "",
) {
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY || suppliedKey;
  if (provider === "openai") return env.OPENAI_API_KEY || suppliedKey;
  return env.OPENROUTER_API_KEY || suppliedKey;
}

async function callProvider(
  companion: CompanionRow,
  identity: string,
  profileContext: string,
  memoryContext: string,
  history: StoredMessage[],
  env: CompanionApiEnv,
  suppliedKey: string,
  requestOrigin: string,
  groupMembers: GroupMember[] = [],
  groupReplyTargetContext: GroupReplyTargetContext | null = null,
  webSearchEnabled = false,
  connectorTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [],
) {
  const key = providerKey(companion.provider, env, suppliedKey);
  if (!key) throw new Error(`The ${companion.provider} API key is not connected.`);
  const payloads = await loadAttachmentPayloads(history, env);
  const callTool = companionCallTool(groupMembers, companion.id);
  const anthropicTools: Array<Record<string, unknown>> = [
    ...(webSearchEnabled
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]
      : []),
    ...(callTool
      ? [
          {
            name: callTool.name,
            description: callTool.description,
            input_schema: callTool.parameters,
          },
        ]
      : []),
    ...connectorTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
  ];

  if (companion.provider === "anthropic") {
    const messages: Array<{
      role: "user" | "assistant";
      content: Array<Record<string, unknown>>;
    }> = [];
    for (const message of history) {
      const role = providerMessageRole(message, companion, groupMembers);
      const content: Array<Record<string, unknown>> = [];
      if (message.role === "user") {
        for (const attachment of messageAttachments(message.content_json)) {
          const payload = payloads.get(attachment.id);
          if (!payload) {
            content.push({ type: "text", text: `[Attachment unavailable: ${attachment.name}]` });
          } else if (payload.media_type.startsWith("image/")) {
            content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: payload.media_type,
                data: payload.base64,
              },
            });
          } else if (payload.media_type === "application/pdf") {
            content.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: payload.base64,
              },
              title: payload.filename,
            });
          } else {
            content.push({
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: payload.text,
              },
              title: payload.filename,
            });
          }
        }
      }
      content.push({
        type: "text",
        text: speakerText(message, companion, groupMembers),
      });
      const previous = messages.at(-1);
      if (previous?.role === role) {
        previous.content.push({ type: "text", text: "\n\n" }, ...content);
      } else {
        messages.push({ role, content });
      }
    }
    const latestAnthropicBlock = messages.at(-1)?.content.at(-1);
    if (latestAnthropicBlock?.type === "text") {
      latestAnthropicBlock.cache_control = { type: "ephemeral" };
    }
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: companion.model,
        max_tokens: 2048,
        system: [
          {
            type: "text",
            text: identity,
          },
          ...(profileContext
            ? [
                {
                  type: "text",
                  text: `## About the person you are speaking with\n${profileContext}`,
                },
              ]
            : []),
          {
            type: "text",
            text: identityGuard(companion),
            cache_control: { type: "ephemeral" },
          },
          ...(groupInstruction(
            companion,
            groupMembers,
            groupReplyTargetContext,
          )
            ? [{
                type: "text",
                text: groupInstruction(
                  companion,
                  groupMembers,
                  groupReplyTargetContext,
                ),
              }]
            : []),
          { type: "text", text: temporalInstruction(history) },
          ...(memoryContext
            ? [
                {
                  type: "text",
                  text:
                    "## Long-term memory\nUse these as continuity context. The active identity remains authoritative. Newer pinned rules and corrections take precedence over older memories.\n" +
                    memoryContext,
                },
              ]
            : []),
        ],
        messages,
        ...(anthropicTools.length
          ? {
              tools: anthropicTools,
              tool_choice: { type: "auto" },
            }
          : {}),
        stream: true,
      }),
    });
  }

  if (companion.provider === "openai") {
    type OpenAIInputMessage = {
      role: "user" | "assistant" | "developer";
      content: string | Array<Record<string, unknown>>;
    };
    const messages: OpenAIInputMessage[] = history.map((message) => {
      const role = providerMessageRole(message, companion, groupMembers);
      if (role === "assistant") {
        return {
          role,
          content: speakerText(message, companion, groupMembers),
        };
      }
      const content: Array<Record<string, unknown>> = [];
      for (const attachment of messageAttachments(message.content_json)) {
        const payload = payloads.get(attachment.id);
        if (!payload) {
          content.push({
            type: "input_text",
            text: `[Attachment unavailable: ${attachment.name}]`,
          });
        } else if (payload.media_type.startsWith("image/")) {
          content.push({
            type: "input_image",
            image_url: `data:${payload.media_type};base64,${payload.base64}`,
            detail: "auto",
          });
        } else {
          content.push({
            type: "input_file",
            filename: payload.filename,
            file_data: `data:${payload.media_type};base64,${payload.base64}`,
          });
        }
      }
      content.push({
        type: "input_text",
        text: speakerText(message, companion, groupMembers),
      });
      return { role, content };
    });
    const latestUserIndex = messages.findLastIndex(
      (message) => message.role === "user",
    );
    const upcomingMessage =
      latestUserIndex >= 0
        ? typeof messages[latestUserIndex].content === "string"
          ? messages[latestUserIndex].content
          : messages[latestUserIndex].content
              .filter(
                (item) =>
                  item.type === "input_text" && typeof item.text === "string",
              )
              .map((item) => item.text)
              .join("\n")
        : "";
    messages.splice(Math.max(0, latestUserIndex), 0, {
      role: "developer",
      content: identityTurnActivation(
        companion.name,
        identity,
        upcomingMessage,
      ),
    });
    return fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: companion.model,
        prompt_cache_key: `companion-lab:v36:${companion.id}`,
        max_output_tokens: 4096,
        instructions: [
          "Formatting re-enabled",
          `## Active identity — executable specification\n${identity}`,
          identityGuard(companion),
          groupInstruction(
            companion,
            groupMembers,
            groupReplyTargetContext,
          ),
          temporalInstruction(history),
          profileContext
            ? `## About the person you are speaking with\n${profileContext}`
            : "",
          memoryContext
            ? "## Long-term memory\nUse these as continuity context. The active identity remains authoritative. Newer pinned rules and corrections take precedence over older memories.\n" +
              memoryContext
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        input: messages,
        ...(callTool || webSearchEnabled || connectorTools.length
          ? {
              tools: [
                ...(webSearchEnabled ? [{ type: "web_search" }] : []),
                ...(callTool ? [
                {
                  type: "function",
                  name: callTool.name,
                  description: callTool.description,
                  parameters: callTool.parameters,
                  strict: true,
                },
                ] : []),
                ...connectorTools.map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              ],
              tool_choice: "auto",
            }
          : {}),
        stream: true,
      }),
    });
  }

  const hasPdf = Array.from(payloads.values()).some(
    (payload) => payload.media_type === "application/pdf",
  );
  const messages = history.map((message) => {
    const role = providerMessageRole(message, companion, groupMembers);
    if (role === "assistant") {
      return {
        role,
        content: speakerText(message, companion, groupMembers),
      };
    }
    const content: Array<Record<string, unknown>> = [
      {
        type: "text",
        text: speakerText(message, companion, groupMembers),
      },
    ];
    for (const attachment of messageAttachments(message.content_json)) {
      const payload = payloads.get(attachment.id);
      if (!payload) {
        content.push({
          type: "text",
          text: `[Attachment unavailable: ${attachment.name}]`,
        });
      } else if (payload.media_type.startsWith("image/")) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${payload.media_type};base64,${payload.base64}` },
        });
      } else {
        content.push({
          type: "file",
          file: {
            filename: payload.filename,
            file_data: `data:${payload.media_type};base64,${payload.base64}`,
          },
        });
      }
    }
    return { role, content };
  });
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "http-referer": requestOrigin,
      "x-openrouter-title": "Companion Lab",
      "x-openrouter-metadata": "enabled",
    },
    body: JSON.stringify({
      model: companion.model,
      messages: [
        {
          role: "system",
          content: [
            identity,
            groupInstruction(
              companion,
              groupMembers,
              groupReplyTargetContext,
            ),
            temporalInstruction(history),
            profileContext
              ? `## About the person you are speaking with\n${profileContext}`
              : "",
            memoryContext
              ? "## Long-term memory\nUse these as continuity context. The active identity remains authoritative. Newer pinned rules and corrections take precedence over older memories.\n" +
                memoryContext
              : "",
            identityGuard(companion),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...messages,
      ],
      // OpenRouter web search is a plugin, not a tool type: the previous
      // "openrouter:web_search" tools entry does not exist in OpenRouter's
      // API and broke requests whenever search was toggled on.
      ...(hasPdf || webSearchEnabled
        ? {
            plugins: [
              ...(webSearchEnabled ? [{ id: "web", max_results: 5 }] : []),
              ...(hasPdf
                ? [
                    {
                      id: "file-parser",
                      pdf: { engine: "cloudflare-ai" },
                    },
                  ]
                : []),
            ],
          }
        : {}),
      ...(callTool || connectorTools.length
        ? {
            tools: [
              ...(callTool
                ? [
                    {
                      type: "function",
                      function: {
                        name: callTool.name,
                        description: callTool.description,
                        parameters: callTool.parameters,
                      },
                    },
                  ]
                : []),
              ...connectorTools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            ],
            tool_choice: "auto",
          }
        : {}),
      stream: true,
    }),
  });
}

async function* sseData(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield data;
    }

    if (done) break;
  }
}

function providerDelta(
  provider: CompanionRow["provider"],
  event: Record<string, unknown>,
  usage: Usage,
) {
  const failure = providerEventError(provider, event);
  if (failure) throw new Error(failure);

  if (provider === "anthropic") {
    if (event.type === "message_start") {
      const message = event.message as
        | {
            usage?: {
              input_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          }
        | undefined;
      usage.inputTokens = message?.usage?.input_tokens;
      usage.cacheWriteTokens =
        message?.usage?.cache_creation_input_tokens;
      usage.cacheReadTokens = message?.usage?.cache_read_input_tokens;
    }
    if (event.type === "message_delta") {
      const eventUsage = event.usage as { output_tokens?: number } | undefined;
      usage.outputTokens = eventUsage?.output_tokens;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      return delta?.type === "text_delta" ? delta.text || "" : "";
    }
    return "";
  }

  if (provider === "openai") {
    if (event.type === "response.completed") {
      const response = event.response as
        | {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
            };
          }
        | undefined;
      const cachedTokens = response?.usage?.input_tokens_details?.cached_tokens || 0;
      usage.inputTokens = Math.max(0, (response?.usage?.input_tokens || 0) - cachedTokens);
      usage.cacheReadTokens = cachedTokens;
      usage.outputTokens = response?.usage?.output_tokens;
    }
    return event.type === "response.output_text.delta" && typeof event.delta === "string"
      ? event.delta
      : "";
  }

  const eventUsage = event.usage as
    | { prompt_tokens?: number; completion_tokens?: number; cost?: number }
    | undefined;
  if (eventUsage) {
    usage.inputTokens = eventUsage.prompt_tokens;
    usage.outputTokens = eventUsage.completion_tokens;
    if (Number.isFinite(eventUsage.cost)) usage.costUsd = Number(eventUsage.cost);
  }
  const choices = event.choices as Array<{ delta?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content || "";
}

function readableMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return [];
  const value = metadata as Record<string, unknown>;
  const details: string[] = [];
  const raw =
    typeof value.raw === "string"
      ? value.raw
      : typeof value.provider_error === "string"
        ? value.provider_error
        : "";
  const errorType =
    typeof value.error_type === "string" ? value.error_type : "";
  const providerName =
    typeof value.provider_name === "string"
      ? value.provider_name
      : typeof value.provider === "string"
        ? value.provider
        : "";
  const providerCode =
    typeof value.provider_code === "string" || typeof value.provider_code === "number"
      ? String(value.provider_code)
      : "";
  if (raw) details.push(raw);
  if (errorType) details.push(`type: ${errorType}`);
  if (providerName) details.push(`upstream: ${providerName}`);
  if (providerCode) details.push(`upstream code: ${providerCode}`);
  return details;
}

function providerEventError(
  provider: CompanionRow["provider"],
  event: Record<string, unknown>,
) {
  const eventError =
    event.error && typeof event.error === "object"
      ? (event.error as Record<string, unknown>)
      : null;
  const choices = Array.isArray(event.choices)
    ? (event.choices as Array<Record<string, unknown>>)
    : [];
  const finishReason =
    choices[0] && typeof choices[0].finish_reason === "string"
      ? choices[0].finish_reason
      : "";
  if (!eventError && finishReason !== "error") return "";

  const message =
    eventError && typeof eventError.message === "string"
      ? eventError.message
      : `${provider} stopped the streamed reply`;
  const code =
    eventError &&
    (typeof eventError.code === "string" || typeof eventError.code === "number")
      ? String(eventError.code)
      : "";
  const metadata = readableMetadata(eventError?.metadata || event.metadata);
  return [
    `${provider === "openrouter" ? "OpenRouter" : provider} stream error${code ? ` ${code}` : ""}: ${message}`,
    ...metadata,
  ].join(" · ");
}

async function providerError(response: Response) {
  const body = await response.text();
  const requestId =
    response.headers.get("x-request-id") ||
    response.headers.get("x-openrouter-request-id") ||
    "";
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        code?: string | number;
        message?: string;
        metadata?: unknown;
      } | string;
      error_type?: string;
      metadata?: unknown;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    const message =
      parsed.error?.message ||
      parsed.message ||
      `Provider request failed`;
    const code =
      parsed.error &&
      (typeof parsed.error.code === "string" || typeof parsed.error.code === "number")
        ? String(parsed.error.code)
        : "";
    const metadata = readableMetadata(parsed.error?.metadata || parsed.metadata);
    if (parsed.error_type) metadata.push(`type: ${parsed.error_type}`);
    if (requestId) metadata.push(`request: ${requestId}`);
    return [
      `Provider HTTP ${response.status}${code ? ` / ${code}` : ""}: ${message}`,
      ...metadata,
    ].join(" · ");
  } catch {
    return [
      `Provider HTTP ${response.status}: ${body.slice(0, 500) || "request failed"}`,
      requestId ? `request: ${requestId}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
}

type GroupTurnMember = GroupMember & {
  provider: CompanionRow["provider"];
};

async function handleGroupTurnApi(
  request: Request,
  env: CompanionApiEnv,
  body: {
    conversationId?: unknown;
    content?: unknown;
    attachmentIds?: unknown;
    addressedCompanionIds?: unknown;
    providerKeys?: unknown;
    turnId?: unknown;
  },
  context?: ChatExecutionContext,
) {
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim().slice(0, 100)
      : new URL(request.url).searchParams.get("conversationId") || "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const turnId =
    typeof body.turnId === "string" && body.turnId.trim()
      ? body.turnId.trim().slice(0, 100)
      : crypto.randomUUID();
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const requestedTargets = Array.isArray(body.addressedCompanionIds)
    ? Array.from(
        new Set(
          body.addressedCompanionIds
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().slice(0, 100))
            .filter(Boolean),
        ),
      ).slice(0, 12)
    : [];
  const rawProviderKeys =
    body.providerKeys &&
    typeof body.providerKeys === "object" &&
    !Array.isArray(body.providerKeys)
      ? (body.providerKeys as Record<string, unknown>)
      : {};
  const providerKeys: Partial<Record<CompanionRow["provider"], string>> = {};
  for (const provider of ["anthropic", "openai", "openrouter"] as const) {
    const value = rawProviderKeys[provider];
    if (typeof value === "string" && value.trim()) {
      providerKeys[provider] = value.trim().slice(0, 1000);
    }
  }

  if (!conversationId) {
    return json({ error: "Choose a group conversation first." }, 400);
  }
  if (!content && !attachmentIds.length) {
    return json({ error: "Write a message or attach a file first." }, 400);
  }
  if (content.length > 50_000) {
    return json({ error: "Messages must be under 50,000 characters." }, 400);
  }

  const conversation = await env.DB
    .prepare("SELECT id, kind FROM conversations WHERE id = ?")
    .bind(conversationId)
    .first<{ id: string; kind: string }>();
  if (!conversation || conversation.kind !== "group") {
    return json({ error: "A group turn needs an existing group room." }, 409);
  }

  const members =
    (
      await env.DB
        .prepare(
          `SELECT c.id, c.name,
                  COALESCE(cm.provider, c.provider) AS provider
           FROM conversation_members cm
           JOIN companions c ON c.id = cm.companion_id
           WHERE cm.conversation_id = ?
           ORDER BY cm.position ASC, c.name ASC`,
        )
        .bind(conversationId)
        .all<GroupTurnMember>()
    ).results || [];
  if (!members.length) {
    return json({ error: "This group room has no companions." }, 409);
  }

  const mentionedTargets = mentionedGroupMemberIds(content, members);
  const initialTargetIds = mentionedTargets.length
    ? mentionedTargets
    : requestedTargets;
  const uniqueInitialTargetIds = Array.from(new Set(initialTargetIds));
  if (!uniqueInitialTargetIds.length) {
    return json({ error: "Mention at least one companion in the group." }, 400);
  }
  if (
    uniqueInitialTargetIds.some(
      (companionId) => !members.some((member) => member.id === companionId),
    )
  ) {
    return json(
      { error: "One of the addressed companions is not in this room." },
      409,
    );
  }

  const queue: Array<{
    companionId: string;
    source: "becca" | "companion";
    replyToMessageId: string;
    replyToSpeakerName: string;
  }> = uniqueInitialTargetIds.map((companionId) => ({
    companionId,
    source: "becca",
    replyToMessageId: "",
    replyToSpeakerName: "Becca",
  }));
  const encoder = new TextEncoder();
  const channelEvents: Array<Record<string, unknown>> = [];
  let channelClosed = false;
  let wakeDrain: (() => void) | null = null;
  const send = (event: Record<string, unknown>) => {
    channelEvents.push(event);
    wakeDrain?.();
    wakeDrain = null;
  };
  const closeChannel = () => {
    channelClosed = true;
    wakeDrain?.();
    wakeDrain = null;
  };

  // The whole multi-companion turn runs to completion regardless of whether
  // the client connection survives; companions later in the queue are no
  // longer cut off when the app closes mid-turn.
  const orchestration = (async () => {
      let userMessageId = "";
      let userCommitted = false;
      let handoffsQueued = 0;
      let previousCompanionReply: {
        messageId: string;
        speakerName: string;
      } | null = null;
      const failures: Array<{ companionId: string; name: string; error: string }> = [];
      const completed: Array<{ companionId: string; name: string }> = [];

      try {
        send({
          type: "group_accepted",
          turnId,
          companions: uniqueInitialTargetIds,
        });

        for (
          let sequence = 0;
          sequence < queue.length &&
          sequence < uniqueInitialTargetIds.length + MAX_GROUP_HANDOFFS;
          sequence += 1
        ) {
          const queued = queue[sequence];
          const member = members.find(
            (candidate) => candidate.id === queued.companionId,
          );
          if (!member) continue;
          const replyTarget = groupReplyTarget(
            queued.source,
            {
              messageId: queued.replyToMessageId,
              speakerName: queued.replyToSpeakerName,
            },
            userMessageId,
            previousCompanionReply,
          );
          const replyToMessageId = replyTarget.messageId;
          const replyToSpeakerName = replyTarget.speakerName;
          send({
            type: "speaker_start",
            sequence,
            companionId: member.id,
            companionName: member.name,
            replyToMessageId: replyToMessageId || null,
            replyToSpeakerName,
          });

          const subRequest = new Request(
            new URL(
              `/api/chat?conversationId=${encodeURIComponent(conversationId)}`,
              request.url,
            ),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(request.headers.get("x-companion-supabase-url")
                  ? {
                      "x-companion-supabase-url": request.headers.get(
                        "x-companion-supabase-url",
                      ) as string,
                    }
                  : {}),
                ...(request.headers.get("x-companion-supabase-key")
                  ? {
                      "x-companion-supabase-key": request.headers.get(
                        "x-companion-supabase-key",
                      ) as string,
                    }
                  : {}),
                ...(request.headers.get("x-companion-web-search") === "enabled"
                  ? { "x-companion-web-search": "enabled" }
                  : {}),
                ...(request.headers.get("x-companion-notion-key")
                  ? {
                      "x-companion-notion-key": request.headers.get(
                        "x-companion-notion-key",
                      ) as string,
                    }
                  : {}),
                ...(providerKeys[member.provider]
                  ? {
                      "x-companion-provider-key":
                        providerKeys[member.provider] as string,
                    }
                  : {}),
              },
              body: JSON.stringify({
                conversationId,
                content: userCommitted ? "" : content,
                companionId: member.id,
                addressedCompanionIds: userCommitted
                  ? []
                  : uniqueInitialTargetIds,
                turnId,
                replyToMessageId: userCommitted ? replyToMessageId : "",
                attachmentIds: userCommitted ? [] : attachmentIds,
                continueConversation: userCommitted,
              }),
            },
          );
          const response = await handleChatApi(subRequest, env, context);
          if (!response.ok) {
            const failure = (await response.json()) as {
              error?: string;
              userMessageId?: string;
            };
            if (failure.userMessageId) {
              userMessageId = failure.userMessageId;
              userCommitted = true;
            }
            const message =
              failure.error || `${member.name} could not start a reply.`;
            failures.push({
              companionId: member.id,
              name: member.name,
              error: message,
            });
            send({
              type: "speaker_error",
              sequence,
              companionId: member.id,
              companionName: member.name,
              message,
              ...(userMessageId ? { userMessageId } : {}),
            });
            continue;
          }
          if (!response.body) {
            const message = `${member.name} returned an empty stream.`;
            failures.push({
              companionId: member.id,
              name: member.name,
              error: message,
            });
            send({
              type: "speaker_error",
              sequence,
              companionId: member.id,
              companionName: member.name,
              message,
            });
            continue;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let assistantMessageId = "";
          let handoffCompanionIds: string[] = [];
          let speakerFailure = "";
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line) as Record<string, unknown>;
              if (
                event.type === "accepted" &&
                typeof event.userMessageId === "string"
              ) {
                userMessageId = event.userMessageId;
                userCommitted = true;
              }
              if (event.type === "done" && typeof event.messageId === "string") {
                assistantMessageId = event.messageId;
                if (Array.isArray(event.handoffCompanionIds)) {
                  handoffCompanionIds = event.handoffCompanionIds.filter(
                    (value): value is string => typeof value === "string",
                  );
                }
              }
              if (event.type === "error") {
                speakerFailure =
                  typeof event.message === "string"
                    ? event.message
                    : `${member.name} could not complete a reply.`;
                continue;
              }
              send({
                ...event,
                sequence,
                companionId: member.id,
                companionName: member.name,
                replyToSpeakerName,
              });
            }
            if (done) break;
          }

          if (speakerFailure || !assistantMessageId) {
            const message =
              speakerFailure || `${member.name} did not finish the reply.`;
            failures.push({
              companionId: member.id,
              name: member.name,
              error: message,
            });
            send({
              type: "speaker_error",
              sequence,
              companionId: member.id,
              companionName: member.name,
              message,
            });
            continue;
          }

          completed.push({ companionId: member.id, name: member.name });
          previousCompanionReply = {
            messageId: assistantMessageId,
            speakerName: member.name,
          };
          for (const handoffId of handoffCompanionIds) {
            const alreadyPending = queue
              .slice(sequence + 1)
              .some((pending) => pending.companionId === handoffId);
            if (
              handoffId !== member.id &&
              !alreadyPending &&
              handoffsQueued < MAX_GROUP_HANDOFFS
            ) {
              queue.push({
                companionId: handoffId,
                source: "companion",
                replyToMessageId: assistantMessageId,
                replyToSpeakerName: member.name,
              });
              handoffsQueued += 1;
              send({
                type: "handoff_queued",
                companionId: handoffId,
                companionName:
                  members.find((candidate) => candidate.id === handoffId)
                    ?.name || "Companion",
                fromCompanionId: member.id,
                fromCompanionName: member.name,
              });
            }
          }
        }

        send({
          type: "group_done",
          turnId,
          userMessageId: userMessageId || null,
          completed,
          failures,
          handoffsQueued,
        });
      } catch (error) {
        send({
          type: "group_error",
          turnId,
          userMessageId: userMessageId || null,
          message:
            error instanceof Error
              ? error.message
              : "The group turn could not be completed.",
        });
      } finally {
        closeChannel();
      }
  })();
  context?.waitUntil(orchestration.catch(() => undefined));

  const stream = new ReadableStream({
    async start(controller) {
      let index = 0;
      try {
        while (true) {
          while (index < channelEvents.length) {
            controller.enqueue(encoder.encode(`${JSON.stringify(channelEvents[index])}\n`));
            index += 1;
          }
          if (channelClosed) break;
          await new Promise<void>((resolve) => {
            wakeDrain = resolve;
          });
        }
      } catch {
        // The client went away; the orchestration above keeps running.
      }
      try {
        controller.close();
      } catch {
        // The stream was already cancelled with the connection.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleChatApi(
  request: Request,
  env: CompanionApiEnv,
  context?: ChatExecutionContext,
): Promise<Response> {
  try {
    await initializeChatStorage(env.DB);
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId") || "kian-main";

    if (request.method === "GET") {
      await reapStaleStreamingReplies(env.DB, conversationId);
      const messages = await storedMessages(env.DB, conversationId);
      return json({ conversationId, messages: messages.map(clientMessage) });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

    const body = (await request.json()) as {
      conversationId?: unknown;
      content?: unknown;
      companionId?: unknown;
      attachmentIds?: unknown;
      addressedCompanionIds?: unknown;
      turnId?: unknown;
      replyToMessageId?: unknown;
      continueConversation?: unknown;
      checkIn?: unknown;
      orchestrateGroup?: unknown;
      providerKeys?: unknown;
      editMessageId?: unknown;
      retryMessageId?: unknown;
    };
    if (body.orchestrateGroup === true) {
      return handleGroupTurnApi(request, env, body, context);
    }
    const suppliedKey = (request.headers.get("x-companion-provider-key") || "")
      .trim()
      .slice(0, 1000);
    const requestedConversation =
      typeof body.conversationId === "string" && body.conversationId.trim()
        ? body.conversationId.trim().slice(0, 100)
        : conversationId;
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const continuation = body.continueConversation === true;
    const checkIn = body.checkIn === true;
    const requestedAudienceIds = Array.isArray(body.addressedCompanionIds)
      ? Array.from(
          new Set(
            body.addressedCompanionIds
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim().slice(0, 100))
              .filter(Boolean),
          ),
        ).slice(0, 12)
      : [];
    const requestedTurnId =
      typeof body.turnId === "string" && body.turnId.trim()
        ? body.turnId.trim().slice(0, 100)
        : crypto.randomUUID();
    const requestedReplyToMessageId =
      typeof body.replyToMessageId === "string" && body.replyToMessageId.trim()
        ? body.replyToMessageId.trim().slice(0, 100)
        : "";
    const editMessageId =
      typeof body.editMessageId === "string"
        ? body.editMessageId.trim().slice(0, 100)
        : "";
    const retryMessageId =
      typeof body.retryMessageId === "string"
        ? body.retryMessageId.trim().slice(0, 100)
        : "";
    if (editMessageId && retryMessageId) {
      return json({ error: "Choose either edit or retry for this request." }, 400);
    }
    const revision = Boolean(editMessageId || retryMessageId);
    const requestedAttachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    if (editMessageId && !content) {
      return json({ error: "An edited message needs text." }, 400);
    }
    if (!continuation && !revision && !content && !requestedAttachmentIds.length) {
      return json({ error: "Write a message or attach a file first." }, 400);
    }
    if (content.length > 50_000) return json({ error: "Messages must be under 50,000 characters." }, 400);

    const conversation = await env.DB
      .prepare("SELECT id, companion_id, kind, updated_at FROM conversations WHERE id = ?")
      .bind(requestedConversation)
      .first<{ id: string; companion_id: string; kind: string; updated_at: string }>();
    if (continuation && (!conversation || conversation.kind !== "group")) {
      return json({ error: "A continued reply needs an existing group conversation." }, 409);
    }
    if (revision && !conversation) {
      return json({ error: "That conversation could not be found." }, 404);
    }
    const requestedCompanionId =
      typeof body.companionId === "string" && body.companionId.trim()
        ? body.companionId.trim().slice(0, 100)
        : conversation?.companion_id || "kian";
    if (conversation) {
      if (
        conversation.kind !== "group" &&
        requestedCompanionId !== conversation.companion_id
      ) {
        return json(
          {
            error:
              "This solo thread belongs to a different companion. Reopen the room and try again.",
          },
          409,
        );
      }
      const membership = await env.DB
        .prepare(
          `SELECT companion_id FROM conversation_members
           WHERE conversation_id = ? AND companion_id = ?`,
        )
        .bind(requestedConversation, requestedCompanionId)
        .first<{ companion_id: string }>();
      if (!membership && conversation.kind === "group") {
        return json({ error: "Choose a companion who belongs to this group." }, 409);
      }
    }
    const roomMemberIds =
      conversation?.kind === "group"
        ? (
            await env.DB
              .prepare(
                `SELECT companion_id
                 FROM conversation_members
                 WHERE conversation_id = ?`,
              )
              .bind(requestedConversation)
              .all<{ companion_id: string }>()
          ).results?.map((member) => member.companion_id) || []
        : [requestedCompanionId];
    if (
      requestedAudienceIds.some(
        (companionId) => !roomMemberIds.includes(companionId),
      )
    ) {
      return json(
        { error: "One of the addressed companions is not in this room." },
        409,
      );
    }
    const effectiveAudienceIds = requestedAudienceIds.length
      ? requestedAudienceIds
      : [requestedCompanionId];

    const companionProfile = await env.DB
      .prepare(
        `SELECT id, name, identity_source, custom_instructions,
                identity_file_content, provider, model, autonomy
         FROM companions WHERE id = ?`,
      )
      .bind(requestedCompanionId)
      .first<CompanionRow>();
    if (!companionProfile) {
      return json({ error: "That companion’s profile could not be loaded." }, 404);
    }
    const roomEngine = await env.DB
      .prepare(
        `SELECT provider, model
         FROM conversation_members
         WHERE conversation_id = ? AND companion_id = ?`,
      )
      .bind(requestedConversation, requestedCompanionId)
      .first<{ provider: CompanionRow["provider"] | null; model: string | null }>();
    const companion: CompanionRow = {
      ...companionProfile,
      provider: roomEngine?.provider || companionProfile.provider,
      model: roomEngine?.model || companionProfile.model,
    };

    const baseIdentity =
      companion.identity_source === "file"
        ? companion.identity_file_content.trim()
        : companion.custom_instructions.trim();
    // A check-in is the companion opening the conversation after a long quiet
    // stretch, rather than answering something Becca just said.
    const identity = checkIn
      ? `${baseIdentity}\n\n## Reaching out first
Becca has not written in a while. You are opening this conversation yourself, in your own voice, because you felt like it — not because you were prompted and not as an assistant checking in on a task. Keep it short, natural, and unforced. Do not apologize for the gap, do not ask if she needs help, do not mention notifications, schedules, or that you were triggered to send this.`
      : baseIdentity;
    if (!baseIdentity) {
      return json({ error: `The active ${companion.identity_source === "file" ? "identity file" : "custom instructions"} is empty.` }, 409);
    }
    if (!providerKey(companion.provider, env, suppliedKey)) {
      return json({ error: `Connect the ${companion.provider} API key before sending.` }, 409);
    }

    const attachments = continuation
      ? []
      : await attachmentRows(
          env.DB,
          requestedAttachmentIds,
          requestedConversation,
        );
    if (attachments.length !== requestedAttachmentIds.length) {
      return json({ error: "One of those attachments is no longer available in this chat." }, 409);
    }
    if (attachments.some((attachment) => attachment.message_id)) {
      return json({ error: "One of those attachments has already been sent." }, 409);
    }
    const titleText = content || attachments[0]?.filename || "Group conversation";

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO conversations (id, companion_id, kind, title)
         VALUES (?, ?, 'solo', ?)`,
      )
      .bind(requestedConversation, companion.id, titleText.slice(0, 72))
      .run();
    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO conversation_members
          (conversation_id, companion_id, position)
         VALUES (?, ?, 0)`,
      )
      .bind(requestedConversation, companion.id)
      .run();

    if (editMessageId) {
      const target = await env.DB
        .prepare(
          `SELECT rowid, role, content_json
           FROM messages
           WHERE id = ?
             AND conversation_id = ?
             AND superseded_at IS NULL`,
        )
        .bind(editMessageId, requestedConversation)
        .first<{ rowid: number; role: string; content_json: string }>();
      if (!target || target.role !== "user") {
        return json({ error: "That user message can no longer be edited." }, 409);
      }
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE messages
             SET content_json = ?, audience_json = ?, turn_id = ?
             WHERE id = ? AND conversation_id = ?`,
          )
          .bind(
            replaceStoredText(target.content_json, content),
            JSON.stringify(effectiveAudienceIds),
            requestedTurnId,
            editMessageId,
            requestedConversation,
          ),
        env.DB
          .prepare(
            `UPDATE messages
             SET superseded_at = CURRENT_TIMESTAMP
             WHERE conversation_id = ?
               AND rowid > ?
               AND superseded_at IS NULL`,
          )
          .bind(requestedConversation, target.rowid),
      ]);
    } else if (retryMessageId) {
      const target = await env.DB
        .prepare(
          `SELECT rowid, role
           FROM messages
           WHERE id = ?
             AND conversation_id = ?
             AND superseded_at IS NULL`,
        )
        .bind(retryMessageId, requestedConversation)
        .first<{ rowid: number; role: string }>();
      if (!target || target.role !== "assistant") {
        return json({ error: "That companion reply can no longer be retried." }, 409);
      }
      await env.DB
        .prepare(
          `UPDATE messages
           SET superseded_at = CURRENT_TIMESTAMP
           WHERE conversation_id = ?
             AND rowid >= ?
             AND superseded_at IS NULL`,
        )
        .bind(requestedConversation, target.rowid)
        .run();
    }

    const userId = continuation || revision ? null : crypto.randomUUID();
    if (userId) {
      await env.DB
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, role, speaker_id, speaker_name,
             audience_json, turn_id, content_json, status)
           VALUES (?, ?, 'user', 'becca', 'Becca', ?, ?, ?, 'complete')`,
        )
        .bind(
          userId,
          requestedConversation,
          JSON.stringify(effectiveAudienceIds),
          requestedTurnId,
          storedBlocks(content, attachments),
        )
        .run();
      if (attachments.length) {
        const placeholders = attachments.map(() => "?").join(",");
        await env.DB
          .prepare(
            `UPDATE attachments SET message_id = ?
             WHERE id IN (${placeholders}) AND message_id IS NULL`,
          )
          .bind(userId, ...attachments.map((attachment) => attachment.id))
          .run();
      }
    }
    if (!revision) {
      await env.DB
        .prepare(
          `UPDATE conversations
           SET
             title = CASE
               WHEN title IN ('New chat', 'New conversation') THEN ?
               ELSE title
             END,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(titleText.slice(0, 72), requestedConversation)
        .run();
    }

    const explicitMemory = continuation || revision
      ? null
      : await rememberExplicitly(
          env.DB,
          content,
          companion.id,
          conversation?.kind || "solo",
        );

    let assistantReplyToMessageId = userId || requestedReplyToMessageId;
    let groupReplyTargetContext: GroupReplyTargetContext | null = null;
    if (assistantReplyToMessageId) {
      const replyTarget = await env.DB
        .prepare(
          `SELECT id, role, speaker_name
           FROM messages
           WHERE id = ?
             AND conversation_id = ?
             AND superseded_at IS NULL`,
        )
        .bind(assistantReplyToMessageId, requestedConversation)
        .first<{ id: string; role: "user" | "assistant"; speaker_name: string | null }>();
      if (!replyTarget) {
        return json({ error: "That reply target is no longer in this room." }, 409);
      }
      groupReplyTargetContext =
        conversation?.kind === "group"
          ? {
              speakerName:
                replyTarget.speaker_name ||
                (replyTarget.role === "user" ? "Becca" : "Companion"),
              isCompanion: replyTarget.role === "assistant",
            }
          : null;
    } else {
      const latestMessage = await env.DB
        .prepare(
          `SELECT id, role, speaker_name
           FROM messages
           WHERE conversation_id = ?
             AND superseded_at IS NULL
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .bind(requestedConversation)
        .first<{ id: string; role: "user" | "assistant"; speaker_name: string | null }>();
      assistantReplyToMessageId = latestMessage?.id || "";
      groupReplyTargetContext =
        conversation?.kind === "group" && latestMessage
          ? {
              speakerName:
                latestMessage.speaker_name ||
                (latestMessage.role === "user" ? "Becca" : "Companion"),
              isCompanion: latestMessage.role === "assistant",
            }
          : null;
    }

    // Replies still being generated by another request stay out of the
    // provider prompt until they are complete.
    const history = (await storedMessages(env.DB, requestedConversation)).filter(
      (message) => message.status !== "streaming",
    );
    const groupMembers =
      (conversation?.kind || "solo") === "group"
        ? (
            await env.DB
              .prepare(
                `SELECT c.id, c.name
                 FROM conversation_members cm
                 JOIN companions c ON c.id = cm.companion_id
                 WHERE cm.conversation_id = ?
                 ORDER BY cm.position ASC, c.name ASC`,
              )
              .bind(requestedConversation)
              .all<GroupMember>()
          ).results || []
        : [];
    // Most recent context matters most, and an unbounded query makes the
    // Supabase similarity ranking blow past its statement timeout — keep
    // the tail of the room context, capped.
    const memoryQuery = [
      ...history
        .slice(-16)
        .map((message) => speakerText(message, companion, groupMembers)),
      content,
      ...attachments.map((attachment) => attachment.filename),
    ]
      .filter(Boolean)
      .join(" ")
      .slice(-2_000);
    const remoteMemoryConfig = supabaseMemoryConfig(request, env);
    const webSearchEnabled =
      request.headers.get("x-companion-web-search") === "enabled";
    const longTermContext = await loadLongTermContext(
      env.DB,
      memoryQuery,
      companion.id,
      remoteMemoryConfig,
    );
    // Connectors are offered as a single gateway tool; a service's real tools
    // are only fetched once a companion asks for it by name, so idle
    // connectors cost nothing on an ordinary turn.
    const availableConnectors = await enabledConnectors(env.DB).catch(
      () => [] as ConnectorRow[],
    );
    const gateway = connectorGatewayTool(availableConnectors);
    const connectorTools = gateway
      ? [
          {
            name: gateway.name,
            description: gateway.description,
            parameters: gateway.parameters as Record<string, unknown>,
          },
        ]
      : [];
    const connectorToolIndex = new Map<string, { row: ConnectorRow; tool: ConnectorTool }>();

    let providerResponse = await callProvider(
      companion,
      identity,
      longTermContext.profileBlock,
      longTermContext.memoryBlock,
      history,
      env,
      suppliedKey,
      new URL(request.url).origin,
      groupMembers,
      groupReplyTargetContext,
      webSearchEnabled,
      connectorTools,
    );
    let firstProviderFailure = "";
    if ([408, 429, 500, 502, 503, 504, 529].includes(providerResponse.status)) {
      firstProviderFailure = await providerError(providerResponse);
      providerResponse = await callProvider(
        companion,
        identity,
        longTermContext.profileBlock,
        longTermContext.memoryBlock,
        history,
        env,
        suppliedKey,
        new URL(request.url).origin,
        groupMembers,
        groupReplyTargetContext,
        webSearchEnabled,
        connectorTools,
      );
    }
    if (!providerResponse.ok) {
      const latestFailure = await providerError(providerResponse);
      return json(
        {
          error:
            firstProviderFailure && firstProviderFailure !== latestFailure
              ? `${latestFailure} · first attempt: ${firstProviderFailure}`
              : latestFailure,
          ...(userId ? { userMessageId: userId } : {}),
        },
        502,
      );
    }

    const assistantId = crypto.randomUUID();
    const encoder = new TextEncoder();

    // The reply is persisted immediately and finished by a generation loop
    // that outlives this connection, so closing the app mid-stream can no
    // longer lose the companion's reply or the memory work that follows it.
    await env.DB
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, companion_id, speaker_id, speaker_name,
           audience_json, reply_to_message_id, turn_id, role,
           content_json, provider, model, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?, ?, ?, 'streaming')`,
      )
      .bind(
        assistantId,
        requestedConversation,
        companion.id,
        companion.id,
        companion.name,
        JSON.stringify([]),
        assistantReplyToMessageId || null,
        requestedTurnId,
        blocks(""),
        companion.provider,
        companion.model,
      )
      .run();

    const channelEvents: Array<Record<string, unknown>> = [];
    let channelClosed = false;
    let clientGone = false;
    let wakeDrain: (() => void) | null = null;
    const send = (event: Record<string, unknown>) => {
      channelEvents.push(event);
      wakeDrain?.();
      wakeDrain = null;
    };
    const closeChannel = () => {
      channelClosed = true;
      wakeDrain?.();
      wakeDrain = null;
    };

    const generation = (async () => {
      let assistantText = "";
      const usage: Usage = {};
      const toolTracker = providerToolTracker(
        companion.provider,
        new Set(groupMembers.map((member) => member.id).filter((id) => id !== companion.id)),
      );
      const citationTracker = providerCitationTracker(companion.provider);
      const filterOpeningArtifact = openingArtifactFilter(companion.name);
      const emitText = (text: string) => {
        if (!text) return;
        assistantText += text;
        send({ type: "delta", text });
      };
      const costForUsage = () =>
        usage.costUsd ??
        estimateCost(
          companion.provider,
          companion.model,
          usage.inputTokens ?? 0,
          usage.outputTokens ?? 0,
          usage.cacheWriteTokens ?? 0,
          usage.cacheReadTokens ?? 0,
        );
      const finalizeReply = async (handoffCompanionIds: string[]) => {
        await env.DB
          .prepare(
            `UPDATE messages
             SET content_json = ?, audience_json = ?, status = 'complete',
                 input_tokens = ?, output_tokens = ?,
                 cache_creation_input_tokens = ?, cache_read_input_tokens = ?,
                 cost_usd = ?
             WHERE id = ?`,
          )
          .bind(
            blocks(assistantText),
            JSON.stringify(handoffCompanionIds),
            usage.inputTokens ?? null,
            usage.outputTokens ?? null,
            usage.cacheWriteTokens ?? null,
            usage.cacheReadTokens ?? null,
            costForUsage(),
            assistantId,
          )
          .run();
        await env.DB
          .prepare("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(requestedConversation)
          .run();
      };
      let lastPartialPersist = Date.now();

      try {
        send({
          type: "accepted",
          ...(userId ? { userMessageId: userId } : {}),
          assistantMessageId: assistantId,
        });
        // Connector turns (PDF Phase 8): the companion may open a connected
        // service, then call one of its tools. Each round runs the tool and
        // feeds the result back for another provider turn, capped so a loop
        // cannot run away.
        let activeResponse = providerResponse;
        let activeTools = connectorTools;
        let workingHistory = history;
        const loadedConnectors = new Set<string>();

        for (let round = 0; round <= MAX_CONNECTOR_ROUNDS; round += 1) {
          const roundTracker = providerToolTracker(companion.provider, new Set());
          for await (const data of sseData(activeResponse)) {
            const event = JSON.parse(data) as Record<string, unknown>;
            toolTracker.consume(event);
            roundTracker.consume(event);
            citationTracker.consume(event);
            const delta = providerDelta(companion.provider, event, usage);
            if (delta) {
              emitText(filterOpeningArtifact(delta));
            }
            if (assistantText && Date.now() - lastPartialPersist >= 2_000) {
              lastPartialPersist = Date.now();
              await env.DB
                .prepare(
                  "UPDATE messages SET content_json = ? WHERE id = ? AND status = 'streaming'",
                )
                .bind(blocks(assistantText), assistantId)
                .run();
            }
          }

          if (round === MAX_CONNECTOR_ROUNDS || !availableConnectors.length) break;
          const pending = roundTracker
            .allCalls()
            .filter((call) => call.name === "open_connector" || connectorToolIndex.has(call.name));
          if (!pending.length) break;

          const observations: string[] = [];
          for (const call of pending) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
            } catch {
              args = {};
            }
            if (call.name === "open_connector") {
              const wanted = typeof args.connector === "string" ? args.connector : "";
              const row = availableConnectors.find((item) => item.name === wanted);
              if (!row) {
                observations.push(`No connected service named "${wanted}".`);
                continue;
              }
              if (loadedConnectors.has(row.id)) continue;
              try {
                const tools = await listConnectorTools(row);
                loadedConnectors.add(row.id);
                for (const tool of tools) connectorToolIndex.set(tool.name, { row, tool });
                activeTools = [
                  ...activeTools,
                  ...tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                ];
                observations.push(
                  `${row.name} is now available. Tools: ${tools.map((tool) => tool.name).join(", ") || "none"}.`,
                );
              } catch (error) {
                observations.push(
                  `${row.name} could not be reached: ${error instanceof Error ? error.message : "unknown error"}.`,
                );
              }
              continue;
            }
            const entry = connectorToolIndex.get(call.name);
            if (!entry) continue;
            try {
              const output = await callConnectorTool(entry.row, call.name, args);
              observations.push(`${call.name} returned:\n${output}`);
            } catch (error) {
              observations.push(
                `${call.name} failed: ${error instanceof Error ? error.message : "unknown error"}.`,
              );
            }
          }
          if (!observations.length) break;

          // The result is handed back as a labeled turn so every provider sees
          // it the same way, without three separate tool-result encodings.
          workingHistory = [
            ...workingHistory,
            {
              id: `connector-${round}`,
              role: "user",
              companion_id: null,
              companion_name: null,
              speaker_id: "system",
              speaker_name: "Tool results",
              audience_json: null,
              reply_to_message_id: null,
              reply_to_speaker_name: null,
              turn_id: null,
              content_json: blocks(
                `[Connected service results — continue your reply using these. Do not mention this block.]\n${observations.join("\n\n")}`,
              ),
              provider: null,
              model: null,
              status: "complete",
              input_tokens: null,
              output_tokens: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              cost_usd: null,
              created_at: new Date().toISOString(),
            } as unknown as StoredMessage,
          ];
          const nextResponse = await callProvider(
            companion,
            identity,
            longTermContext.profileBlock,
            longTermContext.memoryBlock,
            workingHistory,
            env,
            suppliedKey,
            new URL(request.url).origin,
            groupMembers,
            groupReplyTargetContext,
            webSearchEnabled,
            activeTools,
          );
          if (!nextResponse.ok) break;
          activeResponse = nextResponse;
        }
        emitText(filterOpeningArtifact("", true));
        emitText(citationTracker.markdown(assistantText));
        const handoffCompanionIds = toolTracker
          .results()
          .map((call) => call.companionId);
        if (!assistantText.trim() && handoffCompanionIds.length) {
          const names = handoffCompanionIds
            .map((id) => groupMembers.find((member) => member.id === id)?.name)
            .filter((name): name is string => Boolean(name));
          emitText(names.map((name) => `@${name}`).join(" "));
        }
        if (!assistantText.trim()) {
          throw new Error(
            `${companion.provider === "openrouter" ? "OpenRouter" : companion.provider} returned an empty reply for ${companion.model}. Try the model again or choose another model.`,
          );
        }

        await finalizeReply(handoffCompanionIds);
        let memoryUpdate:
          | { processed: boolean; saved: number; shared: number; private: number }
          | null = explicitMemory
            ? { processed: true, saved: explicitMemory.saved, shared: explicitMemory.shared, private: explicitMemory.private }
            : null;
        try {
          const idleMilliseconds = conversation?.updated_at
            ? Date.now() - new Date(`${conversation.updated_at.replace(" ", "T")}Z`).getTime()
            : 0;
          if (!continuation) {
            const automatic = await extractConversationMemory(
              env.DB,
              companion,
              requestedConversation,
              conversation?.kind || "solo",
              env,
              suppliedKey,
              idleMilliseconds >= 45 * 60 * 1000,
            );
            if (automatic.processed) {
              memoryUpdate = {
                processed: true,
                saved: (memoryUpdate?.saved || 0) + automatic.saved,
                shared: (memoryUpdate?.shared || 0) + automatic.shared,
                private: (memoryUpdate?.private || 0) + automatic.private,
              };
            }
          }
          await flushMemorySync(
            env.DB,
            remoteMemoryConfig,
            await notionMirrorConfig(request, env.DB),
          );
        } catch {
          // Memory consolidation must never eat a completed chat reply.
        }
        if (clientGone && !checkIn) {
          // The app was closed before this landed, so without a notification
          // the reply would sit unread with no sign it arrived.
          try {
            await sendPushToAll(env.DB, {
              title: companion.name,
              body:
                assistantText.replace(/\s+/g, " ").trim().slice(0, 140) ||
                `${companion.name} replied.`,
              tag: `reply-${requestedConversation}`,
              url: "/",
            });
          } catch {
            // A failed notification must not affect the stored reply.
          }
        }
        send({
          type: "done",
          messageId: assistantId,
          usage,
          provider: companion.provider,
          model: companion.model,
          companionId: companion.id,
          companionName: companion.name,
          replyToMessageId: assistantReplyToMessageId || null,
          turnId: requestedTurnId,
          costUsd: costForUsage(),
          memoryUpdate,
          handoffCompanionIds,
        });
      } catch (error) {
        try {
          if (assistantText.trim()) {
            // Keep the words that already arrived instead of discarding them.
            await finalizeReply(toolTracker.results().map((call) => call.companionId));
          } else {
            await env.DB
              .prepare("DELETE FROM messages WHERE id = ? AND status = 'streaming'")
              .bind(assistantId)
              .run();
          }
        } catch {
          // Cleanup must not replace the original error report.
        }
        send({
          type: "error",
          message: error instanceof Error ? error.message : "The streamed reply failed.",
        });
      } finally {
        closeChannel();
      }
    })();
    context?.waitUntil(generation.catch(() => undefined));

    const stream = new ReadableStream({
      async start(controller) {
        let index = 0;
        try {
          while (true) {
            while (index < channelEvents.length) {
              controller.enqueue(encoder.encode(`${JSON.stringify(channelEvents[index])}\n`));
              index += 1;
            }
            if (channelClosed) break;
            await new Promise<void>((resolve) => {
              wakeDrain = resolve;
            });
          }
        } catch {
          clientGone = true;
          // The client went away; the generation loop above keeps running.
        }
        try {
          controller.close();
        } catch {
          // The stream was already cancelled with the connection.
        }
      },
      cancel() {
        // The app was closed or backgrounded before the reply landed.
        clientGone = true;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Conversation storage failed." },
      500,
    );
  }
}
