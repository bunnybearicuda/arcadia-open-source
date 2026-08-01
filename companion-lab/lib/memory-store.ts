import type { MemoryRow } from "./memory-api";
import type { SupabaseMemoryConfig } from "./supabase-memory";
import { upsertSupabaseMemories } from "./supabase-memory";
import { mirrorMemoriesToNotion } from "./notion-mirror";
import {
  dedupeIncomingMemories,
  type ExistingMemoryShape,
  type IncomingMemory,
} from "./memory-matching";
export { selectMemoryPromptRows } from "./memory-matching";
export type { IncomingMemory } from "./memory-matching";

export const CREATE_MEMORY_SYNC_OUTBOX = `
  CREATE TABLE IF NOT EXISTS memory_sync_outbox (
    memory_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK (target IN ('supabase', 'notion')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (memory_id, target)
  )
`;

export type NotionMirrorConfig = {
  token: string;
  source: string;
};

const MAX_SYNC_ATTEMPTS = 25;
const SUPABASE_FLUSH_BATCH = 50;
const NOTION_FLUSH_BATCH = 10;

export async function enqueueMemorySync(database: D1Database, memoryIds: string[]) {
  if (!memoryIds.length) return;
  await database.prepare(CREATE_MEMORY_SYNC_OUTBOX).run();
  for (const memoryId of memoryIds) {
    await database
      .prepare(
        `INSERT INTO memory_sync_outbox (memory_id, target)
         SELECT ?, target FROM (SELECT 'supabase' AS target UNION ALL SELECT 'notion')
         WHERE true
         ON CONFLICT(memory_id, target) DO UPDATE SET
           attempts = 0,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .bind(memoryId)
      .run();
  }
}

export async function saveMemoriesDeduped(
  database: D1Database,
  companionId: string,
  rows: IncomingMemory[],
  source: string,
) {
  if (!rows.length) return { saved: 0, shared: 0, private: 0, skipped: 0, ids: [] as string[] };
  const existing = await database
    .prepare(
      `SELECT id, owner_id, category, content
       FROM memories
       WHERE active = 1 AND owner_id IN (?, 'shared')
       ORDER BY updated_at DESC
       LIMIT 4000`,
    )
    .bind(companionId)
    .all<ExistingMemoryShape>();
  const { toInsert, skipped } = dedupeIncomingMemories(
    existing.results || [],
    rows,
    companionId,
  );
  let shared = 0;
  let privateCount = 0;
  const ids: string[] = [];
  for (const row of toInsert) {
    const ownerId = row.scope === "shared" ? "shared" : companionId;
    const id = crypto.randomUUID();
    await database
      .prepare(
        `INSERT INTO memories (
           id, owner_id, scope, category, content, source, priority, pinned
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ownerId,
        row.scope,
        row.category,
        row.content,
        source.slice(0, 120),
        row.priority,
        row.pinned ? 1 : 0,
      )
      .run();
    ids.push(id);
    if (row.scope === "shared") shared += 1;
    else privateCount += 1;
  }
  await enqueueMemorySync(database, ids);
  return { saved: shared + privateCount, shared, private: privateCount, skipped, ids };
}

async function pendingSync(database: D1Database, target: "supabase" | "notion", limit: number) {
  const rows = await database
    .prepare(
      `SELECT memory_id FROM memory_sync_outbox
       WHERE target = ? AND attempts < ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(target, MAX_SYNC_ATTEMPTS, limit)
    .all<{ memory_id: string }>();
  return (rows.results || []).map((row) => row.memory_id);
}

async function memoriesByIds(database: D1Database, ids: string[]) {
  if (!ids.length) return [] as MemoryRow[];
  const rows = await database
    .prepare(
      `SELECT id, owner_id, scope, category, content, source, source_ref,
              source_url, priority, pinned, active, created_at, updated_at
       FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(...ids)
    .all<MemoryRow>();
  return rows.results || [];
}

async function clearSync(
  database: D1Database,
  target: "supabase" | "notion",
  ids: string[],
) {
  if (!ids.length) return;
  await database
    .prepare(
      `DELETE FROM memory_sync_outbox
       WHERE target = ? AND memory_id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(target, ...ids)
    .run();
}

async function recordSyncFailure(
  database: D1Database,
  target: "supabase" | "notion",
  ids: string[],
) {
  if (!ids.length) return;
  await database
    .prepare(
      `UPDATE memory_sync_outbox
       SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
       WHERE target = ? AND memory_id IN (${ids.map(() => "?").join(",")})`,
    )
    .bind(target, ...ids)
    .run();
}

// Best-effort catch-up of every memory change that has not yet reached
// Supabase or Notion, including changes queued by earlier requests that
// died before their sync ran. Never throws into the calling path.
export async function flushMemorySync(
  database: D1Database,
  remoteConfig: SupabaseMemoryConfig | null,
  notionConfig: NotionMirrorConfig | null,
) {
  if (!remoteConfig && !notionConfig) return { supabase: 0, notion: 0 };
  await database.prepare(CREATE_MEMORY_SYNC_OUTBOX).run();
  let supabaseFlushed = 0;
  let notionFlushed = 0;

  if (remoteConfig) {
    const ids = await pendingSync(database, "supabase", SUPABASE_FLUSH_BATCH);
    if (ids.length) {
      try {
        const rows = await memoriesByIds(database, ids);
        await upsertSupabaseMemories(remoteConfig, rows);
        await clearSync(database, "supabase", ids);
        supabaseFlushed = ids.length;
      } catch {
        await recordSyncFailure(database, "supabase", ids);
      }
    }
  }

  if (notionConfig) {
    const ids = await pendingSync(database, "notion", NOTION_FLUSH_BATCH);
    if (ids.length) {
      try {
        const rows = await memoriesByIds(database, ids);
        await mirrorMemoriesToNotion(
          database,
          notionConfig.token,
          notionConfig.source,
          rows,
        );
        await clearSync(database, "notion", ids);
        notionFlushed = ids.length;
      } catch {
        await recordSyncFailure(database, "notion", ids);
      }
    }
  }

  return { supabase: supabaseFlushed, notion: notionFlushed };
}
