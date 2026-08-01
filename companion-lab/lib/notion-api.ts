import type { CompanionApiEnv } from "./companion-api";
import { initializeMemoryStorage } from "./memory-api";
import type { MemoryRow } from "./memory-api";
import { mirrorMemoriesToNotion } from "./notion-mirror";
import { supabaseMemoryConfig, upsertSupabaseMemories } from "./supabase-memory";

const NOTION_VERSION = "2026-03-11";

type NotionPage = {
  object?: string;
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, Record<string, unknown>>;
};

type NotionBlock = {
  id: string;
  type?: string;
  has_children?: boolean;
  child_page?: { title?: string };
  [key: string]: unknown;
};

type NotionSource =
  | {
      kind: "page";
      id: string;
      name: string;
      rootPage: NotionPage;
    }
  | {
      kind: "data_source";
      id: string;
      name: string;
    };

type PageDocument = {
  page: NotionPage;
  title: string;
  markdown: string;
};

type NotionMemory = {
  id: string;
  content: string;
  sourceRef: string;
  sourceUrl: string;
  updatedAt: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function sourceId(value: string) {
  let candidate = value;
  try {
    candidate = new URL(value).pathname;
  } catch {
    // Raw database and data-source IDs are accepted too.
  }
  const matches = candidate.match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return matches?.at(-1)?.replaceAll("-", "") || "";
}

function richText(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const entry = item as { plain_text?: unknown; text?: { content?: unknown } };
      if (typeof entry.plain_text === "string") return entry.plain_text;
      return typeof entry.text?.content === "string" ? entry.text.content : "";
    })
    .join("");
}

function propertyText(property: Record<string, unknown>) {
  const type = typeof property.type === "string" ? property.type : "";
  const value = property[type];
  if (type === "title" || type === "rich_text") return richText(value);
  if (type === "select" || type === "status") {
    return value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string"
      ? String((value as { name: string }).name)
      : "";
  }
  if (type === "multi_select" && Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? String((item as { name: string }).name)
          : "",
      )
      .filter(Boolean)
      .join(", ");
  }
  if (type === "date" && value && typeof value === "object") {
    const date = value as { start?: unknown; end?: unknown };
    return [date.start, date.end].filter((item) => typeof item === "string").join(" to ");
  }
  if (type === "people" && Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? String((item as { name: string }).name)
          : "",
      )
      .filter(Boolean)
      .join(", ");
  }
  if (type === "files" && Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? String((item as { name: string }).name)
          : "",
      )
      .filter(Boolean)
      .join(", ");
  }
  if (type === "formula" && value && typeof value === "object") {
    const formula = value as Record<string, unknown>;
    return String(formula.string ?? formula.number ?? formula.boolean ?? "");
  }
  if (["number", "checkbox", "url", "email", "phone_number"].includes(type)) {
    return value === null || value === undefined ? "" : String(value);
  }
  return "";
}

function pageTitle(page: NotionPage) {
  const entries = Object.entries(page.properties || {})
    .map(([name, property]) => [name, propertyText(property)] as const)
    .filter(([, value]) => value);
  const explicitTitle = Object.values(page.properties || {}).find(
    (property) => property.type === "title",
  );
  return (
    (explicitTitle ? propertyText(explicitTitle) : "") ||
    entries.find(([, value]) => value && value.length <= 180)?.[1] ||
    "Notion page"
  );
}

async function notionFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "notion-version": NOTION_VERSION,
      ...(init?.headers || {}),
    },
  });
}

async function notionError(response: Response) {
  const body = await response.text();
  let message = "";
  try {
    const parsed = JSON.parse(body) as { message?: string };
    message = parsed.message || "";
  } catch {
    message = body.slice(0, 400);
  }
  if (response.status === 401) {
    return "Notion rejected this token. Copy the Internal Integration Secret from the same connection that has access to Kian’s Corner, then save it again.";
  }
  if (response.status === 403) {
    return "This Notion connection needs Read content enabled in its Capabilities before it can sync pages.";
  }
  if (response.status === 404 || message.includes("object_not_found")) {
    return "Kian’s Corner is not visible to this Notion connection. Confirm that Kian’s Corner is listed under the connection’s Content access.";
  }
  return message || `Notion request failed (${response.status}).`;
}

async function retrievePage(id: string, token: string) {
  const response = await notionFetch(`/pages/${id}`, token);
  if (!response.ok) throw new Error(await notionError(response));
  return (await response.json()) as NotionPage;
}

async function resolveSource(id: string, token: string): Promise<NotionSource> {
  const databaseResponse = await notionFetch(`/databases/${id}`, token);
  if (databaseResponse.ok) {
    const database = (await databaseResponse.json()) as {
      title?: Array<{ plain_text?: string }>;
      data_sources?: Array<{ id?: string; name?: string }>;
    };
    const source = database.data_sources?.find((item) => item.id);
    if (!source?.id) throw new Error("That Notion database does not expose a data source.");
    return {
      kind: "data_source",
      id: source.id,
      name:
        source.name ||
        database.title?.map((item) => item.plain_text || "").join("") ||
        "Notion memory base",
    };
  }

  const dataSourceResponse = await notionFetch(`/data_sources/${id}`, token);
  if (dataSourceResponse.ok) {
    const dataSource = (await dataSourceResponse.json()) as { id?: string; name?: string };
    return {
      kind: "data_source",
      id: dataSource.id || id,
      name: dataSource.name || "Notion memory base",
    };
  }

  const pageResponse = await notionFetch(`/pages/${id}`, token);
  if (pageResponse.ok) {
    const page = (await pageResponse.json()) as NotionPage;
    return {
      kind: "page",
      id: page.id || id,
      name: pageTitle(page),
      rootPage: page,
    };
  }

  const pageMessage = await notionError(pageResponse);
  throw new Error(pageMessage);
}

async function queryPages(dataSourceId: string, token: string) {
  const pages: NotionPage[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page += 1) {
    const response = await notionFetch(`/data_sources/${dataSourceId}/query`, token, {
      method: "POST",
      body: JSON.stringify({
        page_size: 100,
        result_type: "page",
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    if (!response.ok) throw new Error(await notionError(response));
    const body = (await response.json()) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    pages.push(...(body.results || []));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return pages;
}

async function pageMarkdown(pageId: string, token: string) {
  const response = await notionFetch(
    `/pages/${pageId}/markdown?include_transcript=false`,
    token,
  );
  if (response.ok) {
    const body = (await response.json()) as {
      markdown?: string;
      truncated?: boolean;
      unknown_block_ids?: string[];
    };
    let markdown = body.markdown || "";
    if (body.truncated) {
      for (const blockId of (body.unknown_block_ids || []).slice(0, 30)) {
        const blockResponse = await notionFetch(
          `/pages/${blockId}/markdown?include_transcript=false`,
          token,
        );
        if (!blockResponse.ok) continue;
        const block = (await blockResponse.json()) as { markdown?: string };
        if (block.markdown) markdown += `\n\n${block.markdown}`;
      }
    }
    return markdown.trim();
  }

  const markdownError = await notionError(response);
  try {
    return await blockMarkdown(pageId, token, { remaining: 1_200 });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : markdownError);
  }
}

function blockText(block: NotionBlock) {
  const type = block.type || "";
  const payload =
    type && block[type] && typeof block[type] === "object"
      ? (block[type] as Record<string, unknown>)
      : {};
  if (type === "child_page" || type === "child_database") {
    return typeof payload.title === "string" ? payload.title : "";
  }
  if (type === "table_row" && Array.isArray(payload.cells)) {
    return payload.cells.map((cell) => richText(cell)).filter(Boolean).join(" | ");
  }
  const text = richText(payload.rich_text);
  const caption = richText(payload.caption);
  const url = typeof payload.url === "string" ? payload.url : "";
  const content = text || caption || url;
  if (!content) return "";
  if (type.startsWith("heading_")) {
    const level = Math.min(4, Number(type.at(-1)) || 2);
    return `${"#".repeat(level)} ${content}`;
  }
  if (type === "bulleted_list_item") return `- ${content}`;
  if (type === "numbered_list_item") return `1. ${content}`;
  if (type === "to_do") return `- [${payload.checked ? "x" : " "}] ${content}`;
  if (type === "quote") return `> ${content}`;
  if (type === "code") return `\`\`\`\n${content}\n\`\`\``;
  return content;
}

async function blockMarkdown(
  blockId: string,
  token: string,
  blockBudget: { remaining: number },
): Promise<string> {
  const lines: string[] = [];
  const nestedBlocks: string[] = [];
  let cursor = "";
  for (let page = 0; page < 5 && blockBudget.remaining > 0; page += 1) {
    const response = await notionFetch(
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    );
    if (!response.ok) throw new Error(await notionError(response));
    const body = (await response.json()) as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const block of body.results || []) {
      blockBudget.remaining -= 1;
      const text = blockText(block);
      if (text) lines.push(text);
      if (
        block.has_children &&
        block.type !== "child_page" &&
        block.type !== "child_database" &&
        blockBudget.remaining > 0
      ) {
        nestedBlocks.push(block.id);
      }
      if (blockBudget.remaining <= 0) break;
    }
    if (!body.has_more || !body.next_cursor || blockBudget.remaining <= 0) break;
    cursor = body.next_cursor;
  }
  for (const nestedBlock of nestedBlocks) {
    const nested = await blockMarkdown(nestedBlock, token, blockBudget);
    if (nested) lines.push(nested);
    if (blockBudget.remaining <= 0) break;
  }
  return lines.join("\n\n").trim();
}

async function childPages(blockId: string, token: string, blockBudget: { remaining: number }) {
  const children: Array<{ id: string; title: string }> = [];
  const nestedBlocks: string[] = [];
  let cursor = "";
  for (let page = 0; page < 5 && blockBudget.remaining > 0; page += 1) {
    const response = await notionFetch(
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    );
    if (!response.ok) throw new Error(await notionError(response));
    const body = (await response.json()) as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    };
    for (const block of body.results || []) {
      blockBudget.remaining -= 1;
      if (block.type === "child_page") {
        children.push({
          id: block.id,
          title: block.child_page?.title || "Notion page",
        });
      } else if (block.has_children && blockBudget.remaining > 0) {
        nestedBlocks.push(block.id);
      }
      if (blockBudget.remaining <= 0) break;
    }
    if (!body.has_more || !body.next_cursor || blockBudget.remaining <= 0) break;
    cursor = body.next_cursor;
  }
  for (const nestedBlock of nestedBlocks) {
    children.push(...(await childPages(nestedBlock, token, blockBudget)));
    if (blockBudget.remaining <= 0) break;
  }
  return children;
}

async function pageTree(rootPage: NotionPage, token: string) {
  const documents: PageDocument[] = [];
  const queue: Array<{ page: NotionPage; titleHint?: string }> = [{ page: rootPage }];
  const seen = new Set<string>();
  const blockBudget = { remaining: 1_200 };

  while (queue.length && documents.length < 80) {
    const current = queue.shift();
    if (!current || seen.has(current.page.id)) continue;
    seen.add(current.page.id);
    const title = pageTitle(current.page) || current.titleHint || "Notion page";
    const markdown = await pageMarkdown(current.page.id, token);
    documents.push({ page: current.page, title, markdown });

    const children = await childPages(current.page.id, token, blockBudget);
    for (const child of children) {
      if (seen.has(child.id) || queue.some((item) => item.page.id === child.id)) continue;
      try {
        queue.push({ page: await retrievePage(child.id, token), titleHint: child.title });
      } catch {
        // A child can be visible as a link while remaining unshared with the integration.
      }
      if (queue.length + documents.length >= 80) break;
    }
  }
  return documents;
}

function chunkMarkdown(value: string, maximum = 6_000) {
  const paragraphs = value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const parts =
      paragraph.length > maximum
        ? paragraph.match(new RegExp(`[\\s\\S]{1,${maximum}}`, "g")) || []
        : [paragraph];
    for (const part of parts) {
      if (current && current.length + part.length + 2 > maximum) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function pageMemories(document: PageDocument, companionId: string): NotionMemory[] {
  const properties = Object.entries(document.page.properties || {})
    .map(([name, property]) => [name, propertyText(property)] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const combined = [
    `# ${document.title}`,
    properties,
    document.markdown,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return chunkMarkdown(combined).map((content, index) => ({
    id: `notion:${companionId}:${document.page.id}:${index + 1}`,
    content,
    sourceRef: document.page.id,
    sourceUrl: document.page.url || "",
    updatedAt: document.page.last_edited_time || new Date().toISOString(),
  }));
}

export async function handleNotionApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    await initializeMemoryStorage(env.DB);
    const token = (request.headers.get("x-companion-notion-key") || "").trim();
    if (token.length < 20) return json({ error: "Connect the full Notion integration token first." }, 409);
    const body = (await request.json()) as {
      action?: unknown;
      source?: unknown;
      companionId?: unknown;
      counterpartId?: unknown;
      relocate?: unknown;
    };
    const source = typeof body.source === "string" ? body.source.trim() : "";
    const companionId =
      typeof body.companionId === "string" && body.companionId.trim()
        ? body.companionId.trim().slice(0, 100)
        : "kian";
    const counterpartId =
      typeof body.counterpartId === "string" && body.counterpartId.trim()
        ? body.counterpartId.trim().slice(0, 100)
        : "";
    const scope = companionId === "shared" ? "shared" : "private";
    const id = sourceId(source);
    if (!id) return json({ error: "Paste a Notion database URL or data source ID." }, 400);

    const notionSource = await resolveSource(id, token);
    const rootPages =
      notionSource.kind === "page"
        ? [notionSource.rootPage]
        : await queryPages(notionSource.id, token);
    const action = body.action === "test" ? "test" : "sync";
    if (action === "test") {
      return json({
        name: notionSource.name,
        sourceType: notionSource.kind,
        available: rootPages.length,
      });
    }

    const documents: PageDocument[] = [];
    for (const rootPage of rootPages.slice(0, 100)) {
      if (notionSource.kind === "page") {
        documents.push(...(await pageTree(rootPage, token)));
      } else {
        documents.push({
          page: rootPage,
          title: pageTitle(rootPage),
          markdown: await pageMarkdown(rootPage.id, token),
        });
      }
    }
    let editedMirrorCount = 0;
    for (const document of documents) {
      const marker = document.markdown.match(/Companion Lab memory ([0-9a-f-]{20,})/i);
      if (!marker?.[1]) continue;
      const editedContent = document.markdown.slice(0, marker.index).trim();
      if (!editedContent) continue;
      const updated = await env.DB
        .prepare(
          `UPDATE memories
           SET content = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND active = 1 AND content <> ?`,
        )
        .bind(editedContent.slice(0, 20_000), marker[1], editedContent.slice(0, 20_000))
        .run();
      editedMirrorCount += Number(updated.meta.changes) || 0;
    }
    const memories = documents
      .filter((document) => !/Companion Lab memory [0-9a-f-]{20,}/i.test(document.markdown))
      .flatMap((document) => pageMemories(document, companionId));
    await env.DB
      .prepare(
        `UPDATE memories
         SET active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE owner_id = ? AND source = 'notion'`,
      )
      .bind(companionId)
      .run();
    for (const memory of memories) {
      await env.DB
        .prepare(
          `INSERT INTO memories (
             id, owner_id, scope, category, content, source, source_ref, source_url,
             priority, pinned, active, created_at, updated_at
           ) VALUES (?, ?, ?, 'notion', ?, 'notion', ?, ?, 2, 0, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             source_ref = excluded.source_ref,
             source_url = excluded.source_url,
             priority = excluded.priority,
             active = 1,
             updated_at = excluded.updated_at`,
        )
        .bind(
          memory.id,
          companionId,
          scope,
          memory.content,
          memory.sourceRef,
          memory.sourceUrl,
          memory.updatedAt,
          memory.updatedAt,
        )
        .run();
    }
    if (body.relocate === true) {
      const otherOwnerId = companionId === "shared" ? counterpartId : "shared";
      if (otherOwnerId && otherOwnerId !== companionId) {
        await env.DB
          .prepare(
            `UPDATE memories
             SET active = 0, updated_at = CURRENT_TIMESTAMP
             WHERE owner_id = ? AND source = 'notion'`,
          )
          .bind(otherOwnerId)
          .run();
      }
    }
    await env.DB
      .prepare(
        `UPDATE user_profiles SET
           notion_source = ?,
           notion_source_name = ?,
           notion_last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = 'becca'`,
      )
      .bind(source.slice(0, 1_000), notionSource.name.slice(0, 200))
      .run();

    const mirrorRows = await env.DB
      .prepare(
        `SELECT id, owner_id, scope, category, content, source, source_ref,
                source_url, priority, pinned, active, created_at, updated_at
         FROM memories
         WHERE active = 1 AND source <> 'notion'
         ORDER BY pinned DESC, priority DESC, updated_at DESC
         LIMIT 200`,
      )
      .all<MemoryRow>();
    const remoteMemory = supabaseMemoryConfig(request, env);
    if (remoteMemory) {
      await upsertSupabaseMemories(remoteMemory, mirrorRows.results || []);
    }
    await mirrorMemoriesToNotion(
      env.DB,
      token,
      source,
      mirrorRows.results || [],
    );

    return json({
      name: notionSource.name,
      sourceType: notionSource.kind,
      pages: documents.length,
      imported: memories.length,
      mirrored: (mirrorRows.results || []).length,
      editedMirrorCount,
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Notion connection failed." },
      500,
    );
  }
}
