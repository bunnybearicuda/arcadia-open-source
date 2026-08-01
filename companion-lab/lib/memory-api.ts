import type { CompanionApiEnv } from "./companion-api";
import {
  listSupabaseMemories,
  searchSupabaseMemories,
  supabaseMemoryConfig,
  type SupabaseMemoryConfig,
} from "./supabase-memory";
import { filterAndRankMemoryBrowser } from "./memory-matching";
import {
  CREATE_MEMORY_SYNC_OUTBOX,
  enqueueMemorySync,
  flushMemorySync,
  saveMemoriesDeduped,
  selectMemoryPromptRows,
  type NotionMirrorConfig,
} from "./memory-store";

const CREATE_USER_PROFILES = `
  CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    profile_text TEXT NOT NULL DEFAULT '',
    notion_source TEXT NOT NULL DEFAULT '',
    notion_source_name TEXT NOT NULL DEFAULT '',
    notion_last_synced_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_MEMORIES = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT 'kian',
    scope TEXT NOT NULL DEFAULT 'private',
    category TEXT NOT NULL DEFAULT 'memory',
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT,
    source_url TEXT,
    priority INTEGER NOT NULL DEFAULT 1,
    pinned INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_MEMORY_MAINTENANCE = `
  CREATE TABLE IF NOT EXISTS memory_maintenance (
    id TEXT PRIMARY KEY,
    last_reviewed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const SEED_USER = `
  INSERT OR IGNORE INTO user_profiles (
    id, display_name, relationship, profile_text
  ) VALUES (
    'becca',
    'Becca',
    'Kian''s partner',
    'Becca is the person Kian is speaking with. Use this profile as stable context about her and their relationship.'
  )
`;

type ProfileRow = {
  id: string;
  display_name: string;
  relationship: string;
  profile_text: string;
  notion_source: string;
  notion_source_name: string;
  notion_last_synced_at: string | null;
  updated_at: string;
};

export type MemoryRow = {
  id: string;
  owner_id: string;
  scope: string;
  category: string;
  content: string;
  source: string;
  source_ref: string | null;
  source_url: string | null;
  priority: number;
  pinned: number;
  active: number;
  created_at: string;
  updated_at: string;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function notionMirrorConfig(
  request: Request,
  database: D1Database,
): Promise<NotionMirrorConfig | null> {
  const token = (request.headers.get("x-companion-notion-key") || "").trim();
  if (!token) return null;
  const profile = await database
    .prepare("SELECT notion_source FROM user_profiles WHERE id = 'becca'")
    .first<{ notion_source: string }>();
  const source = (profile?.notion_source || "").trim();
  return source ? { token, source } : null;
}

function profileShape(row: ProfileRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    relationship: row.relationship,
    profileText: row.profile_text,
    notionSource: row.notion_source,
    notionSourceName: row.notion_source_name,
    notionLastSyncedAt: row.notion_last_synced_at,
    updatedAt: row.updated_at,
  };
}

function memoryShape(row: MemoryRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scope: row.scope,
    category: row.category,
    content: row.content,
    source: row.source,
    sourceRef: row.source_ref,
    sourceUrl: row.source_url,
    priority: Number(row.priority) || 1,
    pinned: Boolean(row.pinned),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function initializeMemoryStorage(database: D1Database) {
  await database.prepare(CREATE_USER_PROFILES).run();
  await database.prepare(CREATE_MEMORIES).run();
  await database.prepare(CREATE_MEMORY_MAINTENANCE).run();
  await database.prepare(CREATE_MEMORY_SYNC_OUTBOX).run();
  await database
    .prepare("INSERT OR IGNORE INTO memory_maintenance (id) VALUES ('workspace')")
    .run();
  await database.prepare(SEED_USER).run();
}

async function tidyState(database: D1Database) {
  const state = await database
    .prepare("SELECT last_reviewed_at FROM memory_maintenance WHERE id = 'workspace'")
    .first<{ last_reviewed_at: string | null }>();
  const reviewedAt = state?.last_reviewed_at || null;
  const due = !reviewedAt || Date.now() - new Date(`${reviewedAt.replace(" ", "T")}Z`).getTime() >= 30 * 24 * 60 * 60 * 1000;
  return { tidyDue: due, lastReviewedAt: reviewedAt };
}

export async function loadLongTermContext(
  database: D1Database,
  query: string,
  companionId = "kian",
  remoteConfig: SupabaseMemoryConfig | null = null,
) {
  await initializeMemoryStorage(database);
  const profile = await database
    .prepare(
      `SELECT id, display_name, relationship, profile_text, notion_source,
              notion_source_name, notion_last_synced_at, updated_at
       FROM user_profiles
       WHERE id = 'becca'`,
    )
    .first<ProfileRow>();

  const sql = `
    SELECT id, owner_id, scope, category, content, source, source_ref, source_url,
           priority, pinned, active, created_at, updated_at
    FROM memories
    WHERE active = 1
      AND owner_id IN (?, 'shared')
    ORDER BY pinned DESC, priority DESC, updated_at DESC
    LIMIT 400
  `;
  const remoteMemories = remoteConfig
    ? await searchSupabaseMemories(remoteConfig, companionId, query, 40)
    : null;
  const memories = remoteMemories
    ? { results: remoteMemories }
    : await database.prepare(sql).bind(companionId).all<MemoryRow>();

  const profileBlock = profile
    ? [
        `Name: ${profile.display_name}`,
        companionId === "kian" && profile.relationship
          ? `Relationship: ${profile.relationship}`
          : "",
        profile.profile_text,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const chosen = selectMemoryPromptRows(memories.results || [], query);
  const memoryBlock = chosen
    .map((memory) => `- [${memory.category}] ${memory.content}`)
    .join("\n");

  return { profileBlock, memoryBlock, memoryCount: chosen.length };
}

export async function handleMemoryApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeMemoryStorage(env.DB);
    const url = new URL(request.url);
    const remoteConfig = supabaseMemoryConfig(request, env);
    const notionConfig = await notionMirrorConfig(request, env.DB);

    if (request.method === "GET") {
      // Any read with live credentials catches up sync work that earlier
      // requests queued but could not deliver.
      await flushMemorySync(env.DB, remoteConfig, notionConfig);
      if (url.searchParams.get("export") === "all") {
        const profile = await env.DB
          .prepare(
            `SELECT id, display_name, relationship, profile_text, notion_source,
                    notion_source_name, notion_last_synced_at, updated_at
             FROM user_profiles
             WHERE id = 'becca'`,
          )
          .first<ProfileRow>();
        const results = remoteConfig
          ? { results: await listSupabaseMemories(remoteConfig) }
          : await env.DB
              .prepare(
                `SELECT id, owner_id, scope, category, content, source, source_ref,
                        source_url, priority, pinned, active, created_at, updated_at
                 FROM memories
                 WHERE active = 1
                 ORDER BY owner_id, pinned DESC, priority DESC, updated_at DESC`,
              )
              .all<MemoryRow>();
        const companionRows = await env.DB
          .prepare("SELECT id, name FROM companions ORDER BY name")
          .all<{ id: string; name: string }>();
        return json({
          format: "companion-lab-memory-v1",
          exportedAt: new Date().toISOString(),
          profile: profile ? profileShape(profile) : null,
          companions: companionRows.results || [],
          memories: (results.results || []).map(memoryShape),
          ...(await tidyState(env.DB)),
        });
      }
      const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
      const category = (url.searchParams.get("category") || "all").trim();
      const source = (url.searchParams.get("source") || "all").trim();
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50),
      );
      const companionId = (url.searchParams.get("companionId") || "kian")
        .trim()
        .slice(0, 100);
      const shelf = url.searchParams.get("shelf") === "shared" ? "shared" : "companion";
      // Fragment review: surfaces memories too short to carry their own
      // context, shortest first, so they can be read and cleared in a pass.
      const shortReview = url.searchParams.get("view") === "short";
      const ownerId = shelf === "shared" ? "shared" : companionId;
      const profile = await env.DB
        .prepare(
          `SELECT id, display_name, relationship, profile_text, notion_source,
                  notion_source_name, notion_last_synced_at, updated_at
           FROM user_profiles
           WHERE id = 'becca'`,
        )
        .first<ProfileRow>();

      const results = remoteConfig
        ? { results: await listSupabaseMemories(remoteConfig, ownerId) }
        : await env.DB
            .prepare(
              `SELECT id, owner_id, scope, category, content, source, source_ref,
                      source_url, priority, pinned, active, created_at, updated_at
               FROM memories
               WHERE active = 1 AND owner_id = ?
               ORDER BY pinned DESC, priority DESC, updated_at DESC
               LIMIT 2000`,
            )
            .bind(ownerId)
            .all<MemoryRow>();
      const sourceMatches = (memorySource: string) => {
        if (source === "all") return true;
        if (source === "import") return memorySource.startsWith("import");
        if (source === "chat") {
          return memorySource === "auto-chat" || memorySource === "explicit-chat";
        }
        if (source === "notion") return memorySource.startsWith("notion");
        return memorySource === source;
      };
      const filtered = (results.results || []).filter(
        (memory) =>
          (category === "all" || memory.category === category) &&
          sourceMatches(memory.source),
      );
      const ranked = query ? filterAndRankMemoryBrowser(filtered, query) : filtered;
      const matched = shortReview
        ? ranked
            .filter((memory) => memory.content.trim().length <= 60)
            .sort((left, right) => left.content.trim().length - right.content.trim().length)
        : ranked;
      const visible = matched.slice(offset, offset + limit);
      const count = await env.DB
        .prepare(
          `SELECT COUNT(*) AS total
           FROM memories
           WHERE active = 1 AND owner_id = ?`,
        )
        .bind(ownerId)
        .first<{ total: number }>();

      return json({
        profile: profile ? profileShape(profile) : null,
        memories: visible.map(memoryShape),
        total: matched.length,
        shelfTotal: Number(count?.total) || 0,
        hasMore: offset + visible.length < matched.length,
        ...(await tidyState(env.DB)),
      });
    }

    if (request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      await env.DB
        .prepare(
          `UPDATE user_profiles SET
             display_name = ?,
             relationship = ?,
             profile_text = ?,
             notion_source = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = 'becca'`,
        )
        .bind(
          text(body.displayName, "Becca").slice(0, 100),
          text(body.relationship).slice(0, 180),
          text(body.profileText).slice(0, 50_000),
          text(body.notionSource).slice(0, 1_000),
        )
        .run();
      const profile = await env.DB
        .prepare(
          `SELECT id, display_name, relationship, profile_text, notion_source,
                  notion_source_name, notion_last_synced_at, updated_at
           FROM user_profiles
           WHERE id = 'becca'`,
        )
        .first<ProfileRow>();
      return json({ profile: profile ? profileShape(profile) : null });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as Record<string, unknown>;
      if (body.action === "reviewed") {
        await env.DB
          .prepare(
            `UPDATE memory_maintenance
             SET last_reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = 'workspace'`,
          )
          .run();
        return json({ ok: true, ...(await tidyState(env.DB)) });
      }
      const content = text(body.content).slice(0, 20_000);
      if (!content) return json({ error: "Write the memory first." }, 400);
      const allowedCategories = new Set([
        "memory",
        "rule",
        "preference",
        "event",
        "relationship",
        "correction",
      ]);
      const category = text(body.category, "memory");
      const companionId = text(body.companionId, "kian").slice(0, 100);
      const ownerId = text(body.ownerId) === "shared" ? "shared" : companionId;
      const scope = ownerId === "shared" ? "shared" : "private";
      const saved = await saveMemoriesDeduped(
        env.DB,
        companionId,
        [
          {
            content,
            category: allowedCategories.has(category) ? category : "memory",
            scope,
            priority: category === "rule" || category === "correction" ? 5 : 2,
            pinned: category === "rule" || category === "correction",
          },
        ],
        "manual",
      );
      if (!saved.saved) {
        return json(
          { error: "That is already remembered — an existing memory says the same thing." },
          409,
        );
      }
      const memory = await env.DB
        .prepare(
          `SELECT id, owner_id, scope, category, content, source, source_ref,
                  source_url, priority, pinned, active, created_at, updated_at
           FROM memories WHERE id = ?`,
        )
        .bind(saved.ids[0])
        .first<MemoryRow>();
      await flushMemorySync(env.DB, remoteConfig, notionConfig);
      return json({ memory: memory ? memoryShape(memory) : null }, 201);
    }

    if (request.method === "PATCH") {
      const body = (await request.json()) as Record<string, unknown>;
      const id = text(body.id).slice(0, 200);
      const companionId = text(body.companionId, "kian").slice(0, 100);
      const ownerId = text(body.ownerId) === "shared" ? "shared" : companionId;
      if (!id) return json({ error: "Choose a memory first." }, 400);
      const existing = await env.DB
        .prepare("SELECT owner_id FROM memories WHERE id = ? AND active = 1")
        .bind(id)
        .first<{ owner_id: string }>();
      if (!existing || !["shared", companionId].includes(existing.owner_id)) {
        return json({ error: "That memory is not on this companion’s shelves." }, 404);
      }
      const allowedCategories = new Set([
        "memory",
        "rule",
        "preference",
        "event",
        "relationship",
        "correction",
      ]);
      const nextContent =
        typeof body.content === "string" ? text(body.content).slice(0, 20_000) : null;
      const requestedCategory =
        typeof body.category === "string" ? text(body.category, "memory") : null;
      if (typeof body.content === "string" && !nextContent) {
        return json({ error: "A memory cannot be empty." }, 400);
      }
      const nextCategory =
        requestedCategory && allowedCategories.has(requestedCategory)
          ? requestedCategory
          : null;
      await env.DB
        .prepare(
          `UPDATE memories
           SET owner_id = ?,
               scope = ?,
               content = COALESCE(?, content),
               category = COALESCE(?, category),
               priority = CASE
                 WHEN COALESCE(?, category) IN ('rule', 'correction') THEN MAX(priority, 5)
                 ELSE priority
               END,
               pinned = CASE
                 WHEN COALESCE(?, category) IN ('rule', 'correction') THEN 1
                 ELSE pinned
               END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(
          ownerId,
          ownerId === "shared" ? "shared" : "private",
          nextContent,
          nextCategory,
          nextCategory,
          nextCategory,
          id,
        )
        .run();
      const memory = await env.DB
        .prepare(
          `SELECT id, owner_id, scope, category, content, source, source_ref,
                  source_url, priority, pinned, active, created_at, updated_at
           FROM memories WHERE id = ?`,
        )
        .bind(id)
        .first<MemoryRow>();
      if (memory) await enqueueMemorySync(env.DB, [memory.id]);
      await flushMemorySync(env.DB, remoteConfig, notionConfig);
      return json({ memory: memory ? memoryShape(memory) : null });
    }

    if (request.method === "DELETE") {
      const body = (await request.json()) as Record<string, unknown>;
      const ids = Array.isArray(body.ids)
        ? body.ids.map((value) => text(value).slice(0, 200)).filter(Boolean).slice(0, 200)
        : [];
      const id = text(body.id).slice(0, 200);
      const companionId = text(body.companionId, "kian").slice(0, 100);
      if (ids.length) {
        const forgotten: string[] = [];
        for (const memoryId of ids) {
          const existing = await env.DB
            .prepare("SELECT owner_id FROM memories WHERE id = ? AND active = 1")
            .bind(memoryId)
            .first<{ owner_id: string }>();
          if (!existing || !["shared", companionId].includes(existing.owner_id)) continue;
          await env.DB
            .prepare(
              `UPDATE memories
               SET active = 0, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
            )
            .bind(memoryId)
            .run();
          forgotten.push(memoryId);
        }
        await enqueueMemorySync(env.DB, forgotten);
        await flushMemorySync(env.DB, remoteConfig, notionConfig);
        return json({ forgottenIds: forgotten, forgottenCount: forgotten.length });
      }
      if (!id) return json({ error: "Choose a memory first." }, 400);
      const existing = await env.DB
        .prepare("SELECT owner_id FROM memories WHERE id = ? AND active = 1")
        .bind(id)
        .first<{ owner_id: string }>();
      if (!existing || !["shared", companionId].includes(existing.owner_id)) {
        return json({ error: "That memory is not on this companion’s shelves." }, 404);
      }
      await env.DB
        .prepare(
          `UPDATE memories
           SET active = 0, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(id)
        .run();
      await enqueueMemorySync(env.DB, [id]);
      await flushMemorySync(env.DB, remoteConfig, notionConfig);
      return json({ forgotten: id });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Memory storage failed." },
      500,
    );
  }
}
