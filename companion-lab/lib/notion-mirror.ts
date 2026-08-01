import type { MemoryRow } from "./memory-api";

const NOTION_VERSION = "2026-03-11";
const CREATE_NOTION_LINKS = `
  CREATE TABLE IF NOT EXISTS memory_notion_links (
    memory_id TEXT PRIMARY KEY,
    notion_page_id TEXT NOT NULL,
    notion_block_id TEXT,
    source_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function sourceId(value: string) {
  let candidate = value;
  try {
    candidate = new URL(value).pathname;
  } catch {
    // Raw IDs are accepted.
  }
  return (
    candidate
      .match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
      ?.at(-1)
      ?.replaceAll("-", "") || ""
  );
}

async function notionFetch(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      message = parsed.message || raw;
    } catch {
      // Keep raw body.
    }
    throw new Error(`Notion memory mirror failed (${response.status}): ${message.slice(0, 400)}`);
  }
  return response;
}

type MirrorParent =
  | { kind: "page"; id: string; titleProperty: "title" }
  | { kind: "data_source"; id: string; titleProperty: string };

async function resolveParent(source: string, token: string): Promise<MirrorParent> {
  const id = sourceId(source);
  if (!id) throw new Error("The Notion memory source is missing a valid page or database ID.");
  const database = await fetch(`https://api.notion.com/v1/databases/${id}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
  });
  if (database.ok) {
    const value = (await database.json()) as { data_sources?: Array<{ id?: string }> };
    const dataSourceId = value.data_sources?.find((item) => item.id)?.id;
    if (!dataSourceId) throw new Error("That Notion database has no data source.");
    return resolveParent(dataSourceId, token);
  }
  const dataSource = await fetch(`https://api.notion.com/v1/data_sources/${id}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION },
  });
  if (dataSource.ok) {
    const value = (await dataSource.json()) as {
      id?: string;
      properties?: Record<string, { type?: string }>;
    };
    const titleProperty =
      Object.entries(value.properties || {}).find(([, property]) => property.type === "title")?.[0] ||
      "Name";
    return { kind: "data_source", id: value.id || id, titleProperty };
  }
  await notionFetch(`/pages/${id}`, token);
  return { kind: "page", id, titleProperty: "title" };
}

function titleFor(memory: MemoryRow) {
  const shelf = memory.owner_id === "shared" ? "Shared" : memory.owner_id;
  const content = memory.content.replace(/\s+/g, " ").trim();
  return `${shelf} · ${memory.category} · ${content.slice(0, 80)}`;
}

function richText(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 1_900) } }];
}

export async function mirrorMemoryToNotion(
  database: D1Database,
  token: string,
  source: string,
  memory: MemoryRow,
) {
  if (!token || !source || memory.source.startsWith("notion")) return;
  await database.prepare(CREATE_NOTION_LINKS).run();
  const sourceKey = sourceId(source);
  const existing = await database
    .prepare(
      `SELECT notion_page_id, notion_block_id, source_id
       FROM memory_notion_links WHERE memory_id = ?`,
    )
    .bind(memory.id)
    .first<{ notion_page_id: string; notion_block_id: string | null; source_id: string }>();
  if (existing && existing.source_id === sourceKey) {
    await notionFetch(`/pages/${existing.notion_page_id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ archived: !Boolean(memory.active) }),
    });
    if (memory.active && existing.notion_block_id) {
      await notionFetch(`/blocks/${existing.notion_block_id}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          paragraph: {
            rich_text: richText(memory.content),
            color: "default",
          },
        }),
      });
    }
    return;
  }
  if (!memory.active) return;
  const parent = await resolveParent(source, token);
  const metadata = `Companion Lab memory ${memory.id} · owner=${memory.owner_id} · category=${memory.category}`;
  const response = await notionFetch("/pages", token, {
    method: "POST",
    body: JSON.stringify({
      parent:
        parent.kind === "data_source"
          ? { type: "data_source_id", data_source_id: parent.id }
          : { type: "page_id", page_id: parent.id },
      properties: {
        [parent.titleProperty]: {
          type: "title",
          title: richText(titleFor(memory)),
        },
      },
      children: [
        { object: "block", type: "paragraph", paragraph: { rich_text: richText(memory.content) } },
        { object: "block", type: "paragraph", paragraph: { rich_text: richText(metadata), color: "gray" } },
      ],
    }),
  });
  const page = (await response.json()) as { id?: string };
  if (!page.id) throw new Error("Notion created the memory page without returning its ID.");
  const blocksResponse = await notionFetch(`/blocks/${page.id}/children?page_size=10`, token);
  const blocks = (await blocksResponse.json()) as { results?: Array<{ id?: string; type?: string }> };
  const contentBlockId = blocks.results?.find((block) => block.type === "paragraph")?.id || null;
  await database
    .prepare(
      `INSERT INTO memory_notion_links
         (memory_id, notion_page_id, notion_block_id, source_id, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(memory_id) DO UPDATE SET
         notion_page_id = excluded.notion_page_id,
         notion_block_id = excluded.notion_block_id,
         source_id = excluded.source_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(memory.id, page.id, contentBlockId, sourceKey)
    .run();
}

export async function mirrorMemoriesToNotion(
  database: D1Database,
  token: string,
  source: string,
  memories: MemoryRow[],
) {
  for (const memory of memories) {
    await mirrorMemoryToNotion(database, token, source, memory);
  }
}
