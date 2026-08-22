import { env, notionEnabled } from "./env";
import type { Memory } from "./memory/types";

const NOTION_VERSION = "2022-06-28";

async function notion(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.notionKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Notion's rich_text blocks cap at 2000 chars each. */
function richText(text: string) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
  return (chunks.length ? chunks : [""]).map((c) => ({
    type: "text" as const,
    text: { content: c },
  }));
}

/**
 * Mirror one memory into the Notion database.
 *
 * The Notion copy is readable and editable by her — the point is that memory is
 * never trapped inside an app she might lose access to. It is a mirror only:
 * Supabase stays the source of truth.
 *
 * Expected database properties (create these columns in Notion):
 *   Memory (title) · Companion (text) · Scope (select) · Kind (select)
 *   Importance (number) · Remembered (date)
 */
export async function mirrorMemory(memory: Memory): Promise<void> {
  if (!notionEnabled()) return;

  const properties = {
    Memory: { title: richText(memory.body.slice(0, 1900)) },
    Scope: { select: { name: memory.scope } },
    Kind: { select: { name: memory.kind } },
    Importance: { number: memory.importance },
    Remembered: { date: { start: memory.created_at } },
  };

  if (memory.notion_page_id) {
    const res = await notion(`/pages/${memory.notion_page_id}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) throw new Error(`Notion update failed: ${await res.text()}`);
    return;
  }

  const res = await notion("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: env.notionMemoryDb },
      properties,
    }),
  });
  if (!res.ok) throw new Error(`Notion create failed: ${await res.text()}`);

  const page = (await res.json()) as { id: string };
  const { db } = await import("./supabase");
  await db().from("memories").update({ notion_page_id: page.id }).eq("id", memory.id);
}

/** Forgetting has to reach the backup too, or it isn't forgetting. */
export async function unmirrorMemory(memory: Memory): Promise<void> {
  if (!notionEnabled() || !memory.notion_page_id) return;
  const res = await notion(`/pages/${memory.notion_page_id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  if (!res.ok) throw new Error(`Notion archive failed: ${await res.text()}`);
}

/**
 * A journal entry, written into the companion's own Notion space as a real page
 * with real paragraphs — something you can actually sit and read.
 *
 * Returns the page id, or null when Notion isn't configured (the caller has
 * already stored the entry in Supabase either way).
 */
export async function writeJournalPage(
  companionName: string,
  title: string,
  body: string,
): Promise<string | null> {
  if (!env.notionKey || !env.notionJournalParent) return null;

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 90)
    .map((p) => ({
      object: "block" as const,
      type: "paragraph" as const,
      paragraph: { rich_text: richText(p) },
    }));

  const res = await notion("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: env.notionJournalParent },
      properties: { title: { title: richText(`${companionName} — ${title}`) } },
      children: paragraphs,
    }),
  });
  if (!res.ok) throw new Error(`Notion journal failed: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}
