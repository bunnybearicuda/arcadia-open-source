import type { CompanionApiEnv } from "./companion-api";
import {
  deactivateSupabaseMemories,
  listSupabaseMemories,
  searchSupabaseMemories,
  supabaseMemoryConfig,
  upsertSupabaseMemories,
  type SupabaseMemoryConfig,
} from "./supabase-memory";
import { mirrorMemoriesToNotion } from "./notion-mirror";
import { filterAndRankMemoryBrowser } from "./memory-matching";

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

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before",
  "being", "but", "can", "could", "did", "does", "for", "from", "had", "has",
  "have", "her", "here", "him", "his", "how", "into", "its", "just", "like",
  "more", "most", "not", "now", "our", "out", "she", "should", "some", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "through", "too", "very", "was", "what", "when", "where", "which",
  "who", "why", "will", "with", "would", "you", "your",
]);

const CONCEPTS: Record<string, string[]> = {
  child: ["child", "children", "kid", "kids", "kiddo", "kiddos", "son", "sons", "daughter", "daughters"],
  name: ["name", "names", "named", "called"],
  birthday: ["birthday", "birthdate", "born"],
  partner: ["partner", "spouse", "husband", "wife", "married", "marriage"],
  preference: ["prefer", "prefers", "preference", "favorite", "favourite", "like", "likes", "love", "loves"],
  rule: ["rule", "rules", "boundary", "boundaries", "instruction", "instructions"],
  work: ["work", "works", "job", "career", "profession"],
  home: ["home", "house", "live", "lives", "location"],
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

async function notionMirrorConfig(request: Request, database: D1Database) {
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

function normalizedWords(value: string) {
  const raw = value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  const concepts = new Map<string, string>();
  for (const [concept, variants] of Object.entries(CONCEPTS)) {
    for (const variant of variants) concepts.set(variant, concept);
  }
  return new Set(
    raw.map((word) => {
      const concept = concepts.get(word);
      if (concept) return concept;
      if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
      if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
      if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
      return word;
    }),
  );
}

function memoryScore(memory: MemoryRow, queryWords: Set<string>) {
  const words = normalizedWords(`${memory.category} ${memory.content}`);
  let overlap = 0;
  for (const word of queryWords) if (words.has(word)) overlap += 1;
  return (
    (memory.pinned ? 10_000 : 0) +
    Math.max(0, Number(memory.priority) || 0) * 100 +
    overlap * 1_000
  );
}

function selectedMemories(rows: MemoryRow[], query: string, limit = 40) {
  const queryWords = normalizedWords(query);
  const scored = rows
    .map((memory, index) => ({ memory, index, score: memoryScore(memory, queryWords) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // A small memory base should be fully present. Once it grows, pinned/high-priority
  // continuity and the most relevant items share a bounded prompt budget.
  const selected = rows.length <= limit ? rows : scored.slice(0, limit).map((item) => item.memory);
  const result: MemoryRow[] = [];
  let characters = 0;
  for (const memory of selected) {
    const size = memory.content.length + memory.category.length + 8;
    if (characters + size > 18_000 && result.length >= 8) continue;
    result.push(memory);
    characters += size;
  }
  return result;
}

export async function initializeMemoryStorage(database: D1Database) {
  await database.prepare(CREATE_USER_PROFILES).run();
  await database.prepare(CREATE_MEMORIES).run();
  await database.prepare(CREATE_MEMORY_MAINTENANCE).run();
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
  const chosen = selectedMemories(memories.results || [], query);
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
      const matched = query ? filterAndRankMemoryBrowser(filtered, query) : filtered;
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
      const id = crypto.randomUUID();
      await env.DB
        .prepare(
          `INSERT INTO memories (
           id, owner_id, scope, category, content, source, priority, pinned
           ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`,
        )
        .bind(
          id,
          ownerId,
          scope,
          allowedCategories.has(category) ? category : "memory",
          content,
          category === "rule" || category === "correction" ? 5 : 2,
          category === "rule" || category === "correction" ? 1 : 0,
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
      if (remoteConfig && memory) await upsertSupabaseMemories(remoteConfig, [memory]);
      if (notionConfig && memory) {
        await mirrorMemoriesToNotion(env.DB, notionConfig.token, notionConfig.source, [memory]);
      }
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
      if (remoteConfig && memory) await upsertSupabaseMemories(remoteConfig, [memory]);
      if (notionConfig && memory) {
        await mirrorMemoriesToNotion(env.DB, notionConfig.token, notionConfig.source, [memory]);
      }
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
        if (remoteConfig && forgotten.length) {
          await deactivateSupabaseMemories(remoteConfig, forgotten);
        }
        if (notionConfig && forgotten.length) {
          const forgottenRows = await env.DB
            .prepare(
              `SELECT id, owner_id, scope, category, content, source, source_ref,
                      source_url, priority, pinned, active, created_at, updated_at
               FROM memories WHERE id IN (${forgotten.map(() => "?").join(",")})`,
            )
            .bind(...forgotten)
            .all<MemoryRow>();
          await mirrorMemoriesToNotion(
            env.DB,
            notionConfig.token,
            notionConfig.source,
            forgottenRows.results || [],
          );
        }
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
      if (remoteConfig) await deactivateSupabaseMemories(remoteConfig, [id]);
      if (notionConfig) {
        const forgotten = await env.DB
          .prepare(
            `SELECT id, owner_id, scope, category, content, source, source_ref,
                    source_url, priority, pinned, active, created_at, updated_at
             FROM memories WHERE id = ?`,
          )
          .bind(id)
          .first<MemoryRow>();
        if (forgotten) {
          await mirrorMemoriesToNotion(
            env.DB,
            notionConfig.token,
            notionConfig.source,
            [forgotten],
          );
        }
      }
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
