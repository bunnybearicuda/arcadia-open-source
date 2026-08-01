import { initializeChatStorage } from "./chat-api";
import {
  initializeCompanionStorage,
  type CompanionApiEnv,
} from "./companion-api";
import { estimateCost, type Provider } from "./pricing";
import { initializeMemoryIntelligence } from "./memory-intelligence";

const CREATE_APP_SETTINGS = `
  CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY,
    monthly_budget REAL NOT NULL DEFAULT 5,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const SEED_APP_SETTINGS = `
  INSERT OR IGNORE INTO app_settings (id, monthly_budget)
  VALUES ('workspace', 5)
`;

type UsageRow = {
  id: string;
  companion_id: string | null;
  companion_name: string | null;
  provider: Provider | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
  activity_type: "chat" | "memory";
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function initializeUsageStorage(database: D1Database) {
  await database.prepare(CREATE_APP_SETTINGS).run();
  await database.prepare(SEED_APP_SETTINGS).run();
}

function shapedCost(row: UsageRow) {
  if (typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd)) {
    return {
      cost: Math.max(0, row.cost_usd),
      source:
        row.provider === "openrouter"
          ? ("reported" as const)
          : ("estimated" as const),
    };
  }
  if (!row.provider || !row.model) return { cost: 0, source: "unpriced" as const };
  const estimated = estimateCost(
    row.provider,
    row.model,
    Number(row.input_tokens) || 0,
    Number(row.output_tokens) || 0,
    Number(row.cache_creation_input_tokens) || 0,
    Number(row.cache_read_input_tokens) || 0,
  );
  return estimated === null
    ? { cost: 0, source: "unpriced" as const }
    : { cost: estimated, source: "estimated" as const };
}

export async function handleUsageApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeUsageStorage(env.DB);
    await initializeCompanionStorage(env.DB);
    await initializeChatStorage(env.DB);
    await initializeMemoryIntelligence(env.DB);

    if (request.method === "PUT") {
      const body = (await request.json()) as { monthlyBudget?: unknown };
      const parsed = Number(body.monthlyBudget);
      if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 10_000) {
        return json({ error: "Choose a monthly budget between $0.01 and $10,000." }, 400);
      }
      await env.DB
        .prepare(
          `UPDATE app_settings
           SET monthly_budget = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = 'workspace'`,
        )
        .bind(parsed)
        .run();
    } else if (request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405);
    }

    const settings = await env.DB
      .prepare("SELECT monthly_budget FROM app_settings WHERE id = 'workspace'")
      .first<{ monthly_budget: number }>();
    const result = await env.DB
      .prepare(
        `SELECT * FROM (
           SELECT
             m.id,
             m.companion_id,
             c.name AS companion_name,
             m.provider,
             m.model,
             m.input_tokens,
             m.output_tokens,
             m.cache_creation_input_tokens,
             m.cache_read_input_tokens,
             m.cost_usd,
             m.created_at,
             'chat' AS activity_type
           FROM messages m
           LEFT JOIN companions c ON c.id = m.companion_id
           WHERE m.role = 'assistant'
             AND strftime('%Y-%m', m.created_at) = strftime('%Y-%m', 'now')
           UNION ALL
           SELECT
             r.id,
             r.companion_id,
             c.name AS companion_name,
             r.provider,
             r.model,
             r.input_tokens,
             r.output_tokens,
             0 AS cache_creation_input_tokens,
             0 AS cache_read_input_tokens,
             r.cost_usd,
             r.created_at,
             'memory' AS activity_type
           FROM memory_runs r
           LEFT JOIN companions c ON c.id = r.companion_id
           WHERE strftime('%Y-%m', r.created_at) = strftime('%Y-%m', 'now')
         )
         ORDER BY created_at DESC`,
      )
      .all<UsageRow>();

    const rows = result.results || [];
    const byProvider = new Map<string, { cost: number; messages: number }>();
    const byCompanion = new Map<string, { id: string; name: string; cost: number; messages: number }>();
    const byModel = new Map<
      string,
      {
        provider: string;
        model: string;
        cost: number;
        messages: number;
        inputTokens: number;
        outputTokens: number;
        cacheWriteTokens: number;
        cacheReadTokens: number;
      }
    >();
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let totalCost = 0;
    let estimatedCount = 0;
    let unpricedCount = 0;

    const recent = rows.map((row) => {
      const priced = shapedCost(row);
      const provider = row.provider || "unknown";
      const companionId = row.companion_id || "unknown";
      const companionName = row.companion_name || "Unknown companion";
      const input = Number(row.input_tokens) || 0;
      const output = Number(row.output_tokens) || 0;
      const cacheWrite = Number(row.cache_creation_input_tokens) || 0;
      const cacheRead = Number(row.cache_read_input_tokens) || 0;
      inputTokens += input;
      outputTokens += output;
      cacheWriteTokens += cacheWrite;
      cacheReadTokens += cacheRead;
      totalCost += priced.cost;
      if (priced.source === "estimated") estimatedCount += 1;
      if (priced.source === "unpriced") unpricedCount += 1;

      const providerTotal = byProvider.get(provider) || { cost: 0, messages: 0 };
      providerTotal.cost += priced.cost;
      providerTotal.messages += 1;
      byProvider.set(provider, providerTotal);

      const companionTotal = byCompanion.get(companionId) || {
        id: companionId,
        name: companionName,
        cost: 0,
        messages: 0,
      };
      companionTotal.cost += priced.cost;
      companionTotal.messages += 1;
      byCompanion.set(companionId, companionTotal);

      const model = row.model || "Unknown model";
      const modelKey = `${provider}:${model}`;
      const modelTotal = byModel.get(modelKey) || {
        provider,
        model,
        cost: 0,
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      };
      modelTotal.cost += priced.cost;
      modelTotal.messages += 1;
      modelTotal.inputTokens += input;
      modelTotal.outputTokens += output;
      modelTotal.cacheWriteTokens += cacheWrite;
      modelTotal.cacheReadTokens += cacheRead;
      byModel.set(modelKey, modelTotal);

      return {
        id: row.id,
        companionId,
        companionName,
        provider,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheWriteTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        cost: priced.cost,
        source: priced.source,
        activityType: row.activity_type,
        createdAt: row.created_at,
      };
    });

    const lifetimeResult = await env.DB
      .prepare(
        `SELECT * FROM (
           SELECT
             m.id,
             m.companion_id,
             c.name AS companion_name,
             m.provider,
             m.model,
             m.input_tokens,
             m.output_tokens,
             m.cache_creation_input_tokens,
             m.cache_read_input_tokens,
             m.cost_usd,
             m.created_at,
             'chat' AS activity_type
           FROM messages m
           LEFT JOIN companions c ON c.id = m.companion_id
           WHERE m.role = 'assistant'
           UNION ALL
           SELECT
             r.id,
             r.companion_id,
             c.name AS companion_name,
             r.provider,
             r.model,
             r.input_tokens,
             r.output_tokens,
             0 AS cache_creation_input_tokens,
             0 AS cache_read_input_tokens,
             r.cost_usd,
             r.created_at,
             'memory' AS activity_type
           FROM memory_runs r
           LEFT JOIN companions c ON c.id = r.companion_id
         )`,
      )
      .all<UsageRow>();
    const lifetimeByProvider = new Map<string, { cost: number; messages: number }>();
    for (const row of lifetimeResult.results || []) {
      const provider = row.provider || "unknown";
      const total = lifetimeByProvider.get(provider) || { cost: 0, messages: 0 };
      total.cost += shapedCost(row).cost;
      total.messages += 1;
      lifetimeByProvider.set(provider, total);
    }

    const monthlyBudget = Number(settings?.monthly_budget) || 5;
    return json({
      usage: {
        month: new Date().toISOString().slice(0, 7),
        monthlyBudget,
        totalCost,
        remaining: Math.max(0, monthlyBudget - totalCost),
        percent: Math.min(100, (totalCost / monthlyBudget) * 100),
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        messages: rows.length,
        estimatedCount,
        unpricedCount,
        byProvider: Array.from(byProvider, ([provider, value]) => ({ provider, ...value }))
          .sort((a, b) => b.cost - a.cost),
        lifetimeByProvider: Array.from(
          lifetimeByProvider,
          ([provider, value]) => ({ provider, ...value }),
        ).sort((a, b) => b.cost - a.cost),
        byCompanion: Array.from(byCompanion.values()).sort((a, b) => b.cost - a.cost),
        byModel: Array.from(byModel.values()).sort((a, b) => b.cost - a.cost),
        recent: recent.slice(0, 20),
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Usage tracking failed." },
      500,
    );
  }
}
