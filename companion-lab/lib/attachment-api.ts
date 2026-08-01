import type { CompanionApiEnv } from "./companion-api";

const CREATE_ATTACHMENTS = `
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    conversation_id TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
  "application/xml",
  "text/xml",
]);

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type AttachmentRow = {
  id: string;
  message_id: string | null;
  conversation_id: string;
  storage_key: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function safeName(name: string) {
  return name.replace(/[^\p{L}\p{N}._()\- ]/gu, "_").slice(0, 180) || "attachment";
}

function mediaType(file: File) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const extension = file.name.split(".").at(-1)?.toLocaleLowerCase();
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    xml: "application/xml",
  };
  return types[extension || ""] || file.type;
}

export function attachmentShape(row: AttachmentRow) {
  return {
    id: row.id,
    name: row.filename,
    mediaType: row.media_type,
    size: Number(row.size_bytes) || 0,
    url: `/api/attachments/${encodeURIComponent(row.id)}`,
  };
}

export async function initializeAttachmentStorage(database: D1Database) {
  await database.prepare(CREATE_ATTACHMENTS).run();
  await database
    .prepare(
      `CREATE INDEX IF NOT EXISTS attachments_conversation_idx
       ON attachments (conversation_id, created_at)`,
    )
    .run();
  await database
    .prepare(
      `CREATE INDEX IF NOT EXISTS attachments_message_idx
       ON attachments (message_id)`,
    )
    .run();
}

export async function attachmentRows(
  database: D1Database,
  ids: string[],
  conversationId?: string,
) {
  const unique = Array.from(new Set(ids.filter(Boolean))).slice(0, 12);
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const result = await database
    .prepare(
      `SELECT id, message_id, conversation_id, storage_key, filename,
              media_type, size_bytes, created_at
       FROM attachments
       WHERE id IN (${placeholders})
         ${conversationId ? "AND conversation_id = ?" : ""}
       ORDER BY created_at ASC`,
    )
    .bind(...unique, ...(conversationId ? [conversationId] : []))
    .all<AttachmentRow>();
  return result.results || [];
}

export async function handleAttachmentApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeAttachmentStorage(env.DB);
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");

    if (request.method === "GET" && url.pathname !== "/api/attachments") {
      const row = await env.DB
        .prepare(
          `SELECT id, message_id, conversation_id, storage_key, filename,
                  media_type, size_bytes, created_at
           FROM attachments WHERE id = ?`,
        )
        .bind(id)
        .first<AttachmentRow>();
      if (!row) return json({ error: "Attachment not found." }, 404);
      const object = await env.BUCKET.get(row.storage_key);
      if (!object) return json({ error: "Attachment data is unavailable." }, 404);
      return new Response(object.body, {
        headers: {
          "content-type": row.media_type,
          "content-length": String(row.size_bytes),
          "content-disposition": `inline; filename="${row.filename.replaceAll('"', "")}"`,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (request.method === "DELETE" && url.pathname !== "/api/attachments") {
      const row = await env.DB
        .prepare(
          `SELECT id, message_id, conversation_id, storage_key, filename,
                  media_type, size_bytes, created_at
           FROM attachments WHERE id = ?`,
        )
        .bind(id)
        .first<AttachmentRow>();
      if (!row) return json({ ok: true });
      if (row.message_id) {
        return json({ error: "Sent attachments stay with their chat message." }, 409);
      }
      await env.BUCKET.delete(row.storage_key);
      await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== "/api/attachments") {
      return json({ error: "Method not allowed." }, 405);
    }

    const form = await request.formData();
    const file = form.get("file");
    const conversationId =
      typeof form.get("conversationId") === "string"
        ? String(form.get("conversationId")).trim().slice(0, 100)
        : "";
    if (!(file instanceof File) || !conversationId) {
      return json({ error: "Choose a file and an active chat first." }, 400);
    }
    const resolvedMediaType = mediaType(file);
    if (!ALLOWED_TYPES.has(resolvedMediaType)) {
      return json(
        { error: "Use an image, PDF, or common text file such as TXT, MD, CSV, JSON, HTML, or XML." },
        415,
      );
    }
    const limit = resolvedMediaType.startsWith("text/") || resolvedMediaType === "application/json"
      ? MAX_TEXT_BYTES
      : MAX_FILE_BYTES;
    if (file.size > limit) {
      return json(
        { error: `That file is too large. ${limit === MAX_TEXT_BYTES ? "Text files" : "Images and PDFs"} can be up to ${limit / 1024 / 1024} MB.` },
        413,
      );
    }

    const conversation = await env.DB
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .bind(conversationId)
      .first<{ id: string }>();
    if (!conversation) return json({ error: "Open a saved chat before attaching a file." }, 409);

    const existing = await env.DB
      .prepare(
        `SELECT COUNT(*) AS total FROM attachments
         WHERE conversation_id = ? AND message_id IS NULL`,
      )
      .bind(conversationId)
      .first<{ total: number }>();
    if ((Number(existing?.total) || 0) >= 4) {
      return json({ error: "Send or remove one of the four pending attachments first." }, 409);
    }

    const idValue = crypto.randomUUID();
    const filename = safeName(file.name);
    const storageKey = `conversations/${conversationId}/${idValue}/${filename}`;
    await env.BUCKET.put(storageKey, file.stream(), {
      httpMetadata: { contentType: resolvedMediaType },
      customMetadata: { filename, conversationId },
    });
    await env.DB
      .prepare(
        `INSERT INTO attachments (
           id, message_id, conversation_id, storage_key, filename, media_type, size_bytes
         ) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(idValue, conversationId, storageKey, filename, resolvedMediaType, file.size)
      .run();
    const row = await env.DB
      .prepare(
        `SELECT id, message_id, conversation_id, storage_key, filename,
                media_type, size_bytes, created_at
         FROM attachments WHERE id = ?`,
      )
      .bind(idValue)
      .first<AttachmentRow>();
    return json({ attachment: row ? attachmentShape(row) : null }, 201);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Attachment storage failed." },
      500,
    );
  }
}
