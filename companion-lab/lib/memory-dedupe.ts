import type { CompanionApiEnv } from "./companion-api";
import type { MemoryRow } from "./memory-api";
import { initializeMemoryStorage } from "./memory-api";
import { mirrorMemoriesToNotion } from "./notion-mirror";
import { estimateCost } from "./pricing";
import {
  exactDuplicateGroups,
  isSafeDuplicateCandidate,
  semanticDuplicateCandidates,
  type DuplicateCandidate,
} from "./memory-matching";
import {
  listSupabaseMemories,
  supabaseMemoryConfig,
  upsertSupabaseMemories,
} from "./supabase-memory";

type MemoryCompanion = {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
};

type DuplicateProposal = {
  id: string;
  ownerId: string;
  memoryIds: string[];
  mergedContent: string;
  reason: string;
  originals: Array<{ id: string; category: string; content: string }>;
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

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

function providerKey(companion: MemoryCompanion, env: CompanionApiEnv, supplied: string) {
  if (companion.provider === "anthropic") return env.ANTHROPIC_API_KEY || supplied;
  if (companion.provider === "openai") return env.OPENAI_API_KEY || supplied;
  return env.OPENROUTER_API_KEY || supplied;
}

async function providerError(response: Response) {
  const raw = await response.text();
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    return typeof body.error === "string"
      ? body.error
      : body.error?.message || body.message || `Duplicate scan failed (${response.status}).`;
  } catch {
    return raw.slice(0, 500) || `Duplicate scan failed (${response.status}).`;
  }
}

function parseObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The duplicate scan returned invalid JSON.");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

function scanPrompt(companion: MemoryCompanion, candidates: DuplicateCandidate[]) {
  const catalog = candidates
    .map((candidate) =>
      JSON.stringify({
        pairId: candidate.id,
        ownerId: candidate.left.owner_id,
        category: candidate.left.category,
        left: { id: candidate.left.id, content: candidate.left.content.slice(0, 1_200) },
        right: { id: candidate.right.id, content: candidate.right.content.slice(0, 1_200) },
      }),
    )
    .join("\n")
    .slice(0, 260_000);
  return `You are validating preselected candidate pairs for ${companion.name}'s long-term memory. Decide whether each pair is truly redundant.

Equivalent means either memory could replace the other without losing or changing any independent fact, instruction, exception, target, relationship, event, measurement, timeframe, emotional context, or scope.

Strict rules:
- Shared subject matter, the same person, the same broad category, or emotional proximity never makes a pair equivalent.
- A consent rule and a naming boundary are different. A pregnancy fear and a body measurement are different.
- Similar preferences with different targets remain separate.
- Contradictions and changed facts remain separate.
- If either memory contains one meaningful detail absent from the other, equivalent must be false.
- When uncertain, equivalent must be false.
- Use only the supplied pairId. Never create pairs or combine separate candidates.

Return JSON only:
{"decisions":[{"pairId":"pair id","equivalent":true,"reason":"brief exact reason"}]}

PRESELECTED PAIRS (JSONL):
${catalog}`;
}

function semanticProposalRows(
  value: unknown,
  candidates: DuplicateCandidate[],
): DuplicateProposal[] {
  if (!value || typeof value !== "object") return [];
  const decisions = (value as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) return [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const result: DuplicateProposal[] = [];
  for (const raw of decisions.slice(0, candidates.length)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.equivalent !== true || typeof item.pairId !== "string") continue;
    const candidate = byId.get(item.pairId);
    if (!candidate || !isSafeDuplicateCandidate(candidate.left, candidate.right)) continue;
    const rows = [candidate.left as MemoryRow, candidate.right as MemoryRow];
    const retained = [...rows].sort(
      (a, b) =>
        b.content.length - a.content.length ||
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.priority) - Number(a.priority),
    )[0];
    result.push({
      id: crypto.randomUUID(),
      ownerId: candidate.left.owner_id,
      memoryIds: rows.map((row) => row.id),
      mergedContent: retained.content,
      reason:
        typeof item.reason === "string"
          ? item.reason.trim().slice(0, 500)
          : "The pair is interchangeable without losing a detail.",
      originals: rows.map((row) => ({
        id: row.id,
        category: row.category,
        content: row.content,
      })),
    });
  }
  return result;
}

function exactProposals(memories: MemoryRow[]) {
  return exactDuplicateGroups(memories).map((rows) => {
    const ordered = [...rows].sort(
      (a, b) =>
        b.content.length - a.content.length ||
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.priority) - Number(a.priority),
    );
    return {
      id: crypto.randomUUID(),
      ownerId: ordered[0].owner_id,
      memoryIds: ordered.map((row) => row.id),
      mergedContent: ordered[0].content,
      reason: "Identical wording after case, spacing, and punctuation normalization.",
      originals: ordered.map((row) => ({
        id: row.id,
        category: row.category,
        content: row.content,
      })),
    } satisfies DuplicateProposal;
  });
}

async function scanWithProvider(
  companion: MemoryCompanion,
  env: CompanionApiEnv,
  suppliedKey: string,
  candidates: DuplicateCandidate[],
) {
  const key = providerKey(companion, env, suppliedKey);
  if (!key) throw new Error(`Connect the ${companion.provider} API key before scanning duplicates.`);
  const prompt = scanPrompt(companion, candidates);

  if (companion.provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: companion.model,
        max_tokens: 16_000,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: "validate_duplicate_pairs",
            description: "Judge whether each preselected pair is fully interchangeable.",
            input_schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                decisions: {
                  type: "array",
                  maxItems: candidates.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      pairId: { type: "string" },
                      equivalent: { type: "boolean" },
                      reason: { type: "string" },
                    },
                    required: ["pairId", "equivalent", "reason"],
                  },
                },
              },
              required: ["decisions"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "validate_duplicate_pairs" },
      }),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const body = (await response.json()) as {
      content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const tool = (body.content || []).find(
      (part) => part.type === "tool_use" && part.name === "validate_duplicate_pairs",
    )?.input;
    const text = (body.content || []).map((part) => part.text || "").join("");
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    const outputTokens = Number(body.usage?.output_tokens) || 0;
    return {
      proposals: semanticProposalRows(tool || parseObject(text), candidates),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
      } satisfies Usage,
    };
  }

  if (companion.provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: companion.model, input: prompt }),
    });
    if (!response.ok) throw new Error(await providerError(response));
    const body = (await response.json()) as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.output || [])
      .flatMap((item) => item.content || [])
      .map((part) => part.text || "")
      .join("");
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    const outputTokens = Number(body.usage?.output_tokens) || 0;
    return {
      proposals: semanticProposalRows(parseObject(text), candidates),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
      } satisfies Usage,
    };
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: companion.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
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
    proposals: semanticProposalRows(
      parseObject(body.choices?.[0]?.message?.content || ""),
      candidates,
    ),
    usage: {
      inputTokens,
      outputTokens,
      costUsd: Number.isFinite(body.usage?.cost)
        ? Number(body.usage?.cost)
        : estimateCost(companion.provider, companion.model, inputTokens, outputTokens),
    } satisfies Usage,
  };
}

async function notionConfig(request: Request, database: D1Database) {
  const token = (request.headers.get("x-companion-notion-key") || "").trim();
  if (!token) return null;
  const profile = await database
    .prepare("SELECT notion_source FROM user_profiles WHERE id = 'becca'")
    .first<{ notion_source: string }>();
  const source = (profile?.notion_source || "").trim();
  return source ? { token, source } : null;
}

async function recordScan(
  database: D1Database,
  companion: MemoryCompanion,
  usage: Usage,
  itemCount: number,
) {
  await database.prepare(CREATE_MEMORY_RUNS).run();
  await database
    .prepare(
      `INSERT INTO memory_runs (
         id, companion_id, source, provider, model,
         input_tokens, output_tokens, cost_usd, item_count
       ) VALUES (?, ?, 'semantic-dedupe', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      companion.id,
      companion.provider,
      companion.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.costUsd,
      itemCount,
    )
    .run();
}

function safeProposals(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((raw) => {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      memoryIds: Array.isArray(item.memoryIds)
        ? [...new Set(item.memoryIds.filter((id): id is string => typeof id === "string"))]
        : [],
      mergedContent:
        typeof item.mergedContent === "string" ? item.mergedContent.trim().slice(0, 20_000) : "",
    };
  });
}

export async function handleMemoryDedupeApi(request: Request, env: CompanionApiEnv) {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    await initializeMemoryStorage(env.DB);
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action === "apply" ? "apply" : "scan";
    const companionId =
      typeof body.companionId === "string" ? body.companionId.trim().slice(0, 100) : "kian";
    const companion = await env.DB
      .prepare("SELECT id, name, provider, model FROM companions WHERE id = ?")
      .bind(companionId)
      .first<MemoryCompanion>();
    if (!companion) {
      return Response.json({ error: "That companion could not be loaded." }, { status: 404 });
    }

    if (action === "scan") {
      const remote = supabaseMemoryConfig(request, env);
      const memories = remote
        ? [
            ...(await listSupabaseMemories(remote, "shared")),
            ...(await listSupabaseMemories(remote, companion.id)),
          ].slice(0, 1200)
        : (
            await env.DB
              .prepare(
                `SELECT id, owner_id, scope, category, content, source, source_ref,
                        source_url, priority, pinned, active, created_at, updated_at
                 FROM memories
                 WHERE active = 1 AND owner_id IN ('shared', ?)
                 ORDER BY owner_id, category, content
                 LIMIT 1200`,
              )
              .bind(companion.id)
              .all<MemoryRow>()
          ).results || [];
      if (memories.length < 2) {
        return Response.json({ proposals: [], scanned: memories.length, usage: null });
      }
      const exact = exactProposals(memories).slice(0, 200);
      const exactIds = new Set(exact.flatMap((proposal) => proposal.memoryIds));
      const candidates = semanticDuplicateCandidates(
        memories,
        exactIds,
        Math.max(0, 200 - exact.length),
      );
      const suppliedKey = (request.headers.get("x-companion-provider-key") || "").trim();
      let semantic: DuplicateProposal[] = [];
      let usage: Usage | null = null;
      let semanticWarning = "";
      if (candidates.length) {
        try {
          const scan = await scanWithProvider(companion, env, suppliedKey, candidates);
          semantic = scan.proposals;
          usage = scan.usage;
          await recordScan(env.DB, companion, scan.usage, exact.length + semantic.length);
        } catch (error) {
          if (!exact.length) throw error;
          semanticWarning =
            error instanceof Error ? error.message : "Semantic pair validation could not run.";
        }
      }
      return Response.json({
        proposals: [...exact, ...semantic].slice(0, 200),
        scanned: memories.length,
        exactGroups: exact.length,
        candidatePairs: candidates.length,
        usage,
        semanticWarning,
      });
    }

    const requested = safeProposals(body.proposals);
    if (!requested.length) {
      return Response.json({ error: "Choose at least one duplicate group to merge." }, { status: 400 });
    }
    const allIds = [...new Set(requested.flatMap((proposal) => proposal.memoryIds))];
    if (allIds.length < 2 || allIds.length > 1000) {
      return Response.json({ error: "The duplicate selection is invalid." }, { status: 400 });
    }
    const placeholders = allIds.map(() => "?").join(",");
    const remote = supabaseMemoryConfig(request, env);
    const sourceRows = remote
      ? [
          ...(await listSupabaseMemories(remote, "shared")),
          ...(await listSupabaseMemories(remote, companion.id)),
        ].filter((row) => allIds.includes(row.id))
      : (
          await env.DB
            .prepare(
              `SELECT id, owner_id, scope, category, content, source, source_ref,
                      source_url, priority, pinned, active, created_at, updated_at
               FROM memories
               WHERE active = 1 AND id IN (${placeholders})`,
            )
            .bind(...allIds)
            .all<MemoryRow>()
        ).results || [];
    const byId = new Map(sourceRows.map((row) => [row.id, row]));
    const updatedRows: MemoryRow[] = [];
    const statements: D1PreparedStatement[] = [];
    let mergedGroups = 0;
    let removedCopies = 0;
    const touched = new Set<string>();

    for (const proposal of requested) {
      const rows = proposal.memoryIds
        .map((id) => byId.get(id))
        .filter((row): row is MemoryRow => Boolean(row));
      if (rows.length < 2 || !proposal.mergedContent || rows.some((row) => touched.has(row.id))) continue;
      const ownerId = rows[0].owner_id;
      if (
        rows.some((row) => row.owner_id !== ownerId) ||
        (ownerId !== "shared" && ownerId !== companion.id) ||
        rows.some((row) => row.category !== rows[0].category)
      ) continue;
      const exactGroup = exactDuplicateGroups(rows);
      const remainsEquivalent =
        (exactGroup.length === 1 && exactGroup[0].length === rows.length) ||
        (rows.length === 2 && isSafeDuplicateCandidate(rows[0], rows[1]));
      if (!remainsEquivalent) continue;
      rows.forEach((row) => touched.add(row.id));
      const ordered = [...rows].sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          Number(b.priority) - Number(a.priority) ||
          b.updated_at.localeCompare(a.updated_at),
      );
      const keep = ordered[0];
      const duplicates = ordered.slice(1);
      const now = new Date().toISOString();
      const merged: MemoryRow = {
        ...keep,
        content: proposal.mergedContent,
        priority: Math.max(...ordered.map((row) => Number(row.priority) || 1)),
        pinned: ordered.some((row) => Boolean(row.pinned)) ? 1 : 0,
        updated_at: now,
      };
      updatedRows.push(merged);
      statements.push(
        env.DB
          .prepare(
            `UPDATE memories
             SET content = ?, priority = ?, pinned = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND active = 1`,
          )
          .bind(merged.content, merged.priority, merged.pinned, merged.id),
      );
      for (const duplicate of duplicates) {
        const inactive = { ...duplicate, active: 0, updated_at: now };
        updatedRows.push(inactive);
        statements.push(
          env.DB
            .prepare(
              `UPDATE memories SET active = 0, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND active = 1`,
            )
            .bind(duplicate.id),
        );
      }
      mergedGroups += 1;
      removedCopies += duplicates.length;
    }
    if (!mergedGroups) {
      return Response.json({ error: "Those duplicate groups are no longer available." }, { status: 409 });
    }

    if (remote) await upsertSupabaseMemories(remote, updatedRows);
    await env.DB.batch(statements);

    let notionWarning = "";
    const notion = await notionConfig(request, env.DB);
    if (notion) {
      try {
        await mirrorMemoriesToNotion(env.DB, notion.token, notion.source, updatedRows);
      } catch (error) {
        notionWarning = error instanceof Error ? error.message : "Notion could not mirror the merge.";
      }
    }
    return Response.json({ mergedGroups, removedCopies, notionWarning });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Duplicate cleanup failed." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
