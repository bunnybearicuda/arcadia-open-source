import { strFromU8, unzipSync } from "fflate";
import type { CompanionApiEnv } from "./companion-api";
import { initializeMemoryStorage, notionMirrorConfig } from "./memory-api";
import { flushMemorySync, saveMemoriesDeduped } from "./memory-store";
import { supabaseMemoryConfig } from "./supabase-memory";
import { estimateCost } from "./pricing";

type Provider = "anthropic" | "openai" | "openrouter";

export type MemoryCompanion = {
  id: string;
  name: string;
  provider: Provider;
  model: string;
};

type Candidate = {
  content: string;
  category: string;
  scope: "shared" | "private";
  priority: number;
  pinned: boolean;
};

type ExtractionUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

const CREATE_MEMORY_CHECKPOINTS = `
  CREATE TABLE IF NOT EXISTS memory_checkpoints (
    conversation_id TEXT PRIMARY KEY,
    last_message_rowid INTEGER NOT NULL DEFAULT 0,
    last_processed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_MEMORY_RUNS = `
  CREATE TABLE IF NOT EXISTS memory_runs (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    conversation_id TEXT,
    source TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    item_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_MEMORY_IMPORTS = `
  CREATE TABLE IF NOT EXISTS memory_imports (
    id TEXT PRIMARY KEY,
    companion_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    storage_key TEXT NOT NULL,
    total_parts INTEGER NOT NULL DEFAULT 1,
    completed_parts INTEGER NOT NULL DEFAULT 0,
    character_count INTEGER NOT NULL DEFAULT 0,
    imported_count INTEGER NOT NULL DEFAULT 0,
    shared_count INTEGER NOT NULL DEFAULT 0,
    private_count INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const ALLOWED_CATEGORIES = new Set([
  "memory",
  "rule",
  "preference",
  "event",
  "relationship",
  "correction",
]);

function keyFor(companion: MemoryCompanion, env: CompanionApiEnv, suppliedKey: string) {
  if (companion.provider === "anthropic") return env.ANTHROPIC_API_KEY || suppliedKey;
  if (companion.provider === "openai") return env.OPENAI_API_KEY || suppliedKey;
  return env.OPENROUTER_API_KEY || suppliedKey;
}

function extractionPrompt(companion: MemoryCompanion, sourceLabel: string) {
  const liveConversation =
    sourceLabel === "solo conversation" || sourceLabel === "group conversation";
  return `You maintain long-term memory for a multi-companion chat app.

Read the supplied ${sourceLabel}. Extract durable continuity only: stable facts about Becca and her family, preferences, relationship facts, named people, rules, corrections, meaningful events, ongoing projects, and companion-specific lore.

Skip greetings, filler, model speculation, assistant boilerplate, duplicated statements, momentary moods, one-off jokes, rhetorical flourishes, ordinary reactions, questions, guesses, and anything uncertain.

${liveConversation
    ? `This is automatic live-chat memory. Be extremely selective. Saving nothing is a correct result when no durable continuity was clearly established.
- Only save information Becca explicitly stated, directly corrected, or deliberately established as ongoing continuity.
- Do not turn the assistant's claims, improvisation, affectionate language, roleplay narration, or personality performance into facts.
- Do not save ordinary conversation topics, app testing, temporary plans, current food, current mood, passing opinions, or details that will probably be irrelevant in a month.
- Prefer updating continuity through a small number of complete memories. Return at most 3 items.`
    : "For an archive import, capture the durable history comprehensively while still excluding conversational debris."}

File each item:
- "shared": facts or rules every companion should know about Becca, her family, her general preferences, or app-wide expectations.
- "private": history, lore, dynamics, or preferences specific to ${companion.name}.

Use one clear self-contained sentence per item. Preserve names and concrete details. A correction or rule should be pinned. Priority is 1 through 5.

Return JSON only in this exact shape:
{"memories":[{"content":"...","category":"memory|rule|preference|event|relationship|correction","scope":"shared|private","priority":1,"pinned":false}]}`;
}

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The memory model did not return valid JSON.");
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as { memories?: unknown };
  } catch {
    const arrayKey = candidate.indexOf('"memories"');
    const arrayStart = arrayKey >= 0 ? candidate.indexOf("[", arrayKey) : -1;
    if (arrayStart < 0) {
      throw new Error("The memory model returned malformed JSON with no recoverable memory array.");
    }

    const recovered: unknown[] = [];
    let objectStart = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = arrayStart + 1; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        if (depth === 0) objectStart = index;
        depth += 1;
        continue;
      }
      if (character === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && objectStart >= 0) {
          try {
            recovered.push(JSON.parse(candidate.slice(objectStart, index + 1)));
          } catch {
            // Preserve every complete valid item around a malformed object.
          }
          objectStart = -1;
        }
      }
    }
    if (!recovered.length) {
      throw new Error("The memory model returned malformed JSON and no complete memory items could be recovered.");
    }
    return { memories: recovered };
  }
}

function candidates(value: unknown): Candidate[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as { memories?: unknown }).memories;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const item = row as Record<string, unknown>;
      const content = typeof item.content === "string" ? item.content.trim().slice(0, 20_000) : "";
      if (!content) return null;
      const category =
        typeof item.category === "string" && ALLOWED_CATEGORIES.has(item.category)
          ? item.category
          : "memory";
      const scope = item.scope === "private" ? "private" : "shared";
      const priority = Math.max(1, Math.min(5, Math.round(Number(item.priority) || 2)));
      return {
        content,
        category,
        scope,
        priority,
        pinned: Boolean(item.pinned) || category === "rule" || category === "correction",
      } satisfies Candidate;
    })
    .filter((item): item is Candidate => Boolean(item));
}

async function providerError(response: Response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    return typeof body.error === "string"
      ? body.error
      : body.error?.message || body.message || `Memory extraction failed (${response.status}).`;
  } catch {
    return text.slice(0, 500) || `Memory extraction failed (${response.status}).`;
  }
}

async function extractWithProvider(
  companion: MemoryCompanion,
  env: CompanionApiEnv,
  suppliedKey: string,
  sourceLabel: string,
  text: string,
  file?: { name: string; mediaType: string; base64: string },
) {
  const key = keyFor(companion, env, suppliedKey);
  if (!key) throw new Error(`Connect the ${companion.provider} API key before importing memory.`);
  const prompt = extractionPrompt(companion, sourceLabel);

  if (companion.provider === "anthropic") {
    const content: Array<Record<string, unknown>> = [];
    if (file?.mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: file.base64 },
        title: file.name,
      });
    }
    content.push({ type: "text", text: `${prompt}\n\nSOURCE:\n${text}` });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: companion.model,
        max_tokens: 8192,
        messages: [{ role: "user", content }],
        tools: [
          {
            name: "file_long_term_memories",
            description: "File durable continuity into shared and companion-private memory shelves.",
            input_schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                memories: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      content: { type: "string" },
                      category: {
                        type: "string",
                        enum: ["memory", "rule", "preference", "event", "relationship", "correction"],
                      },
                      scope: { type: "string", enum: ["shared", "private"] },
                      priority: { type: "integer", minimum: 1, maximum: 5 },
                      pinned: { type: "boolean" },
                    },
                    required: ["content", "category", "scope", "priority", "pinned"],
                  },
                },
              },
              required: ["memories"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "file_long_term_memories" },
      }),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const body = (await response.json()) as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const toolOutput = (body.content || []).find(
      (part) => part.type === "tool_use" && part.name === "file_long_term_memories",
    )?.input;
    const textOutput = (body.content || []).map((part) => part.text || "").join("");
    const extractedMemories = toolOutput
      ? candidates(toolOutput)
      : candidates(parseJson(textOutput));
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    const outputTokens = Number(body.usage?.output_tokens) || 0;
    return {
      memories: extractedMemories,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
      } satisfies ExtractionUsage,
    };
  }

  if (companion.provider === "openai") {
    const content: Array<Record<string, unknown>> = [];
    if (file?.mediaType === "application/pdf") {
      content.push({
        type: "input_file",
        filename: file.name,
        file_data: `data:application/pdf;base64,${file.base64}`,
      });
    }
    content.push({ type: "input_text", text: `${prompt}\n\nSOURCE:\n${text}` });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: companion.model, input: [{ role: "user", content }] }),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const body = (await response.json()) as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const output = (body.output || [])
      .flatMap((item) => item.content || [])
      .map((part) => part.text || "")
      .join("");
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    const outputTokens = Number(body.usage?.output_tokens) || 0;
    return {
      memories: candidates(parseJson(output)),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
      } satisfies ExtractionUsage,
    };
  }

  const userContent: Array<Record<string, unknown>> = [
    { type: "text", text: `${prompt}\n\nSOURCE:\n${text}` },
  ];
  if (file?.mediaType === "application/pdf") {
    userContent.unshift({
      type: "file",
      file: {
        filename: file.name,
        file_data: `data:application/pdf;base64,${file.base64}`,
      },
    });
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: companion.model,
      messages: [{ role: "user", content: userContent }],
      response_format: { type: "json_object" },
      ...(file?.mediaType === "application/pdf"
        ? { plugins: [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }] }
        : {}),
    }),
  });
  if (!response.ok) throw new Error(await providerError(response));
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const inputTokens = Number(body.usage?.prompt_tokens) || 0;
  const outputTokens = Number(body.usage?.completion_tokens) || 0;
  return {
    memories: candidates(parseJson(body.choices?.[0]?.message?.content || "")),
    usage: {
      inputTokens,
      outputTokens,
      costUsd:
        Number.isFinite(body.usage?.cost)
          ? Number(body.usage?.cost)
          : estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
    } satisfies ExtractionUsage,
  };
}

async function saveCandidates(
  database: D1Database,
  companionId: string,
  rows: Candidate[],
  source: string,
) {
  const saved = await saveMemoriesDeduped(database, companionId, rows, source);
  return { saved: saved.saved, shared: saved.shared, private: saved.private };
}

async function recordRun(
  database: D1Database,
  companion: MemoryCompanion,
  source: string,
  usage: ExtractionUsage,
  itemCount: number,
  conversationId?: string,
) {
  await database
    .prepare(
      `INSERT INTO memory_runs (
         id, companion_id, conversation_id, source, provider, model,
         input_tokens, output_tokens, cost_usd, item_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      companion.id,
      conversationId || null,
      source,
      companion.provider,
      companion.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.costUsd,
      itemCount,
    )
    .run();
}

export async function initializeMemoryIntelligence(database: D1Database) {
  await initializeMemoryStorage(database);
  await database.prepare(CREATE_MEMORY_CHECKPOINTS).run();
  await database.prepare(CREATE_MEMORY_RUNS).run();
  await database.prepare(CREATE_MEMORY_IMPORTS).run();
}

export async function rememberExplicitly(
  database: D1Database,
  content: string,
  companionId: string,
  conversationKind: string,
) {
  const match = content.match(/\bremember\s+(?:this|that)\b[\s:,-]*(.*)$/i);
  const remembered = match?.[1]?.trim();
  if (!remembered) return null;
  const scope = conversationKind === "group" ? "shared" : "private";
  const result = await saveCandidates(
    database,
    companionId,
    [{ content: remembered, category: "memory", scope, priority: 4, pinned: false }],
    "explicit-chat",
  );
  return result.saved ? { ...result, content: remembered } : null;
}

export async function extractConversationMemory(
  database: D1Database,
  companion: MemoryCompanion,
  conversationId: string,
  conversationKind: string,
  env: CompanionApiEnv,
  suppliedKey: string,
  force = false,
) {
  await initializeMemoryIntelligence(database);
  const checkpoint = await database
    .prepare("SELECT last_message_rowid FROM memory_checkpoints WHERE conversation_id = ?")
    .bind(conversationId)
    .first<{ last_message_rowid: number }>();
  const lastRow = Number(checkpoint?.last_message_rowid) || 0;
  const result = await database
    .prepare(
      `SELECT m.rowid AS row_id, m.role, m.content_json, c.name AS companion_name
       FROM messages m
       LEFT JOIN companions c ON c.id = m.companion_id
       WHERE m.conversation_id = ?
         AND m.rowid > ?
         AND m.superseded_at IS NULL
         AND m.status != 'streaming'
       ORDER BY m.rowid ASC
       LIMIT 80`,
    )
    .bind(conversationId, lastRow)
    .all<{ row_id: number; role: string; content_json: string; companion_name: string | null }>();
  const rows = result.results || [];
  if (!force && rows.length < 16) {
    return { processed: false, saved: 0, shared: 0, private: 0 };
  }
  if (!rows.length) return { processed: false, saved: 0, shared: 0, private: 0 };

  const transcript = rows
    .map((row) => {
      let body = "";
      try {
        const blocks = JSON.parse(row.content_json) as Array<{ type?: string; text?: string }>;
        body = blocks.filter((block) => block.type === "text").map((block) => block.text || "").join("");
      } catch {
        body = "";
      }
      const speaker = row.role === "user" ? "Becca" : row.companion_name || companion.name;
      return `${speaker}: ${body}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n\n")
    .slice(-120_000);
  const extracted = await extractWithProvider(
    companion,
    env,
    suppliedKey,
    conversationKind === "group" ? "group conversation" : "solo conversation",
    transcript,
  );
  const selective = extracted.memories
    .filter(
      (memory) =>
        memory.pinned ||
        memory.priority >= 3 ||
        memory.category === "rule" ||
        memory.category === "correction",
    )
    .slice(0, 3);
  const routed =
    conversationKind === "group"
      ? selective.map((memory) => ({ ...memory, scope: "shared" as const }))
      : selective;
  const saved = await saveCandidates(database, companion.id, routed, "auto-chat");
  await recordRun(database, companion, "auto-chat", extracted.usage, saved.saved, conversationId);
  await database
    .prepare(
      `INSERT INTO memory_checkpoints (
         conversation_id, last_message_rowid, last_processed_at
       ) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_message_rowid = excluded.last_message_rowid,
         last_processed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(conversationId, rows.at(-1)?.row_id || lastRow)
    .run();
  return { processed: true, ...saved };
}

function bytesToBase64(bytes: Uint8Array) {
  let result = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    result += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(result);
}

function textFromUpload(file: File, bytes: Uint8Array) {
  const lower = file.name.toLocaleLowerCase();
  if (lower.endsWith(".zip")) {
    const archive = unzipSync(bytes);
    const parts: string[] = [];
    let total = 0;
    for (const [name, value] of Object.entries(archive)) {
      if (!/\.(txt|md|json|jsonl|csv|tsv|html|xml)$/i.test(name)) continue;
      const decoded = strFromU8(value);
      if (!decoded.trim()) continue;
      const remaining = 600_000 - total;
      if (remaining <= 0) break;
      const section = `\n\n--- ${name} ---\n${decoded.slice(0, remaining)}`;
      parts.push(section);
      total += section.length;
    }
    if (!parts.length) throw new Error("That ZIP has no readable text, Markdown, JSON, CSV, or HTML files.");
    return parts.join("");
  }
  return new TextDecoder().decode(bytes);
}

export async function handleMemoryImportApi(request: Request, env: CompanionApiEnv) {
  try {
    await initializeMemoryIntelligence(env.DB);
    if (request.method === "GET") {
      const url = new URL(request.url);
      const companionId = (url.searchParams.get("companionId") || "kian")
        .trim()
        .slice(0, 100);
      const rows = await env.DB
        .prepare(
          `SELECT id, companion_id, filename, size_bytes, total_parts,
                  completed_parts, character_count, imported_count,
                  shared_count, private_count, truncated, status,
                  created_at, updated_at
           FROM memory_imports
           WHERE companion_id = ?
           ORDER BY created_at DESC
           LIMIT 50`,
        )
        .bind(companionId)
        .all<{
          id: string;
          companion_id: string;
          filename: string;
          size_bytes: number;
          total_parts: number;
          completed_parts: number;
          character_count: number;
          imported_count: number;
          shared_count: number;
          private_count: number;
          truncated: number;
          status: string;
          created_at: string;
          updated_at: string;
        }>();
      return Response.json(
        {
          imports: (rows.results || []).map((row) => ({
            id: row.id,
            companionId: row.companion_id,
            filename: row.filename,
            sizeBytes: Number(row.size_bytes) || 0,
            totalParts: Number(row.total_parts) || 1,
            completedParts: Number(row.completed_parts) || 0,
            characterCount: Number(row.character_count) || 0,
            importedCount: Number(row.imported_count) || 0,
            sharedCount: Number(row.shared_count) || 0,
            privateCount: Number(row.private_count) || 0,
            truncated: Boolean(row.truncated),
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    const suppliedKey = (request.headers.get("x-companion-provider-key") || "").trim().slice(0, 1000);
    const form = await request.formData();
    const file = form.get("file");
    const originalName =
      typeof form.get("originalName") === "string"
        ? String(form.get("originalName")).trim().slice(0, 240)
        : "";
    const requestedPart = Math.max(1, Number(form.get("part")) || 1);
    const requestedParts = Math.max(requestedPart, Number(form.get("parts")) || 1);
    const importId =
      typeof form.get("importId") === "string"
        ? String(form.get("importId")).trim().slice(0, 100)
        : "";
    const sourceOnly = form.get("sourceOnly") === "true";
    const companionId =
      typeof form.get("companionId") === "string"
        ? String(form.get("companionId")).trim().slice(0, 100)
        : "kian";
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose a memory archive or document first." }, { status: 400 });
    }
    if (file.size > 12 * 1024 * 1024) {
      return Response.json({ error: "Memory imports must be 12 MB or smaller per file." }, { status: 413 });
    }
    const companion = await env.DB
      .prepare("SELECT id, name, provider, model FROM companions WHERE id = ?")
      .bind(companionId)
      .first<MemoryCompanion>();
    if (!companion) {
      return Response.json({ error: "That companion could not be loaded." }, { status: 404 });
    }
    if (sourceOnly) {
      const id = crypto.randomUUID();
      const storageKey = `memory-imports/${companion.id}/${id}`;
      await env.BUCKET.put(storageKey, file.stream(), {
        httpMetadata: {
          contentType: file.type || "application/octet-stream",
        },
        customMetadata: {
          filename: originalName || file.name,
          companionId: companion.id,
        },
      });
      await env.DB
        .prepare(
          `INSERT INTO memory_imports (
             id, companion_id, filename, media_type, size_bytes, storage_key,
             total_parts, character_count, truncated, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
        )
        .bind(
          id,
          companion.id,
          (originalName || file.name).slice(0, 240),
          (file.type || "application/octet-stream").slice(0, 120),
          file.size,
          storageKey,
          requestedParts,
          Math.max(0, Number(form.get("characterCount")) || 0),
          form.get("truncated") === "true" ? 1 : 0,
        )
        .run();
      return Response.json(
        { importId: id, filename: originalName || file.name },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    }
    if (importId) {
      const audit = await env.DB
        .prepare(
          "SELECT id FROM memory_imports WHERE id = ? AND companion_id = ?",
        )
        .bind(importId, companion.id)
        .first<{ id: string }>();
      if (!audit) {
        return Response.json({ error: "That preserved import could not be found." }, { status: 404 });
      }
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isPdf = file.type === "application/pdf" || file.name.toLocaleLowerCase().endsWith(".pdf");
    const sourceName = originalName || file.name;
    const sourceText = isPdf
      ? `Extract memory from the attached file named ${sourceName}.`
      : textFromUpload(file, bytes);
    const chunks = isPdf
      ? [sourceText]
      : Array.from({ length: Math.ceil(sourceText.length / 24_000) }, (_, index) =>
          sourceText.slice(index * 24_000, (index + 1) * 24_000),
        ).slice(0, 25);
    let saved = 0;
    let shared = 0;
    let privateCount = 0;
    for (const [index, chunk] of chunks.entries()) {
      const extracted = await extractWithProvider(
        companion,
        env,
        suppliedKey,
        `import file ${sourceName}, part ${
          requestedParts > 1 ? requestedPart : index + 1
        } of ${requestedParts > 1 ? requestedParts : chunks.length}`,
        chunk,
        isPdf
          ? { name: file.name, mediaType: "application/pdf", base64: bytesToBase64(bytes) }
          : undefined,
      );
      const stored = await saveCandidates(
        env.DB,
        companion.id,
        extracted.memories,
        `import:${sourceName}`,
      );
      saved += stored.saved;
      shared += stored.shared;
      privateCount += stored.private;
      await recordRun(env.DB, companion, "memory-import", extracted.usage, stored.saved);
    }
    if (importId) {
      await env.DB
        .prepare(
          `UPDATE memory_imports
           SET completed_parts = MIN(total_parts, completed_parts + 1),
               imported_count = imported_count + ?,
               shared_count = shared_count + ?,
               private_count = private_count + ?,
               status = CASE
                 WHEN completed_parts + 1 >= total_parts THEN 'complete'
                 ELSE 'processing'
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND companion_id = ?`,
        )
        .bind(saved, shared, privateCount, importId, companion.id)
        .run();
    }
    await flushMemorySync(
      env.DB,
      supabaseMemoryConfig(request, env),
      await notionMirrorConfig(request, env.DB),
    );
    return Response.json(
      {
        imported: saved,
        shared,
        private: privateCount,
        parts: chunks.length,
        filename: sourceName,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Memory import failed." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
