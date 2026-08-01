import { initializeChatStorage } from "./chat-api";
import {
  initializeCompanionStorage,
  type CompanionApiEnv,
} from "./companion-api";

type ConversationRow = {
  id: string;
  companion_id: string;
  kind: "solo" | "group";
  title: string;
  archived_at: string | null;
  folder_id: string | null;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
  last_content_json: string | null;
  message_count: number;
};

type FolderRow = {
  id: string;
  name: string;
  position: number;
};

type MemberRow = {
  conversation_id: string;
  companion_id: string;
  name: string;
  accent: string;
  companion_bubble_color: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  room_provider: string | null;
  room_model: string | null;
  position: number;
};

function messageText(contentJson: string | null) {
  if (!contentJson) return "";
  try {
    const content = JSON.parse(contentJson) as Array<{ type?: string; text?: string }>;
    return content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
  } catch {
    return "";
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function folderList(database: D1Database) {
  const result = await database
    .prepare(
      `SELECT id, name, position FROM folders
       ORDER BY position ASC, name COLLATE NOCASE ASC`,
    )
    .all<FolderRow>();
  return (result.results || []).map((row) => ({
    id: row.id,
    name: row.name,
    position: Number(row.position) || 0,
  }));
}

export async function handleFolderApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeChatStorage(env.DB);

    if (request.method === "GET") {
      return json({ folders: await folderList(env.DB) });
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return json({ error: "Give the folder a name first." }, 400);
      const existing = await env.DB
        .prepare("SELECT id FROM folders WHERE name = ? COLLATE NOCASE")
        .bind(name)
        .first<{ id: string }>();
      if (existing) {
        return json({ folder: { id: existing.id, name, position: 0 } }, 200);
      }
      const id = crypto.randomUUID();
      const top = await env.DB
        .prepare("SELECT COALESCE(MAX(position), 0) AS top FROM folders")
        .first<{ top: number }>();
      await env.DB
        .prepare("INSERT INTO folders (id, name, position) VALUES (?, ?, ?)")
        .bind(id, name, (Number(top?.top) || 0) + 1)
        .run();
      return json({ folder: { id, name, position: (Number(top?.top) || 0) + 1 } }, 201);
    }

    if (request.method === "PATCH") {
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown;
        name?: unknown;
      };
      const id = typeof body.id === "string" ? body.id.trim().slice(0, 100) : "";
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!id || !name) return json({ error: "Choose a folder and give it a name." }, 400);
      const result = await env.DB
        .prepare("UPDATE folders SET name = ? WHERE id = ?")
        .bind(name, id)
        .run();
      if (!result.meta.changes) return json({ error: "That folder could not be found." }, 404);
      return json({ folders: await folderList(env.DB) });
    }

    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const id = (url.searchParams.get("id") || "").trim().slice(0, 100);
      if (!id) return json({ error: "Choose a folder to remove." }, 400);
      // Chats in the folder go back to their automatic groups; nothing is deleted.
      await env.DB.batch([
        env.DB.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ?").bind(id),
        env.DB.prepare("DELETE FROM folders WHERE id = ?").bind(id),
      ]);
      return json({ ok: true, deletedId: id, folders: await folderList(env.DB) });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Folder management failed." },
      500,
    );
  }
}

async function conversationList(database: D1Database) {
  const result = await database
    .prepare(
      `SELECT
         c.id,
         c.companion_id,
         c.kind,
         c.title,
         c.archived_at,
         c.folder_id,
         c.pinned_at,
         c.created_at,
         c.updated_at,
         (
           SELECT m.content_json
           FROM messages m
           WHERE m.conversation_id = c.id
             AND m.superseded_at IS NULL
           ORDER BY m.created_at DESC, m.rowid DESC
           LIMIT 1
         ) AS last_content_json,
         (
           SELECT COUNT(*)
           FROM messages m
           WHERE m.conversation_id = c.id
             AND m.superseded_at IS NULL
         ) AS message_count
       FROM conversations c
       ORDER BY c.updated_at DESC, c.rowid DESC
       LIMIT 200`,
    )
    .all<ConversationRow>();
  const members = await database
    .prepare(
      `SELECT
         cm.conversation_id,
         cm.companion_id,
         c.name,
         c.accent,
         c.companion_bubble_color,
         COALESCE(cm.provider, c.provider) AS provider,
         COALESCE(cm.model, c.model) AS model,
         cm.provider AS room_provider,
         cm.model AS room_model,
         cm.position
       FROM conversation_members cm
       JOIN companions c ON c.id = cm.companion_id
       ORDER BY cm.conversation_id, cm.position, c.name COLLATE NOCASE`,
    )
    .all<MemberRow>();
  const byConversation = new Map<string, MemberRow[]>();
  for (const member of members.results || []) {
    const current = byConversation.get(member.conversation_id) || [];
    current.push(member);
    byConversation.set(member.conversation_id, current);
  }

  return (result.results || []).map((row) => ({
    id: row.id,
    companionId: row.companion_id,
    kind: row.kind || "solo",
    title: row.title,
    archivedAt: row.archived_at,
    folderId: row.folder_id,
    pinnedAt: row.pinned_at,
    preview: messageText(row.last_content_json),
    messageCount: Number(row.message_count) || 0,
    members: (byConversation.get(row.id) || []).map((member) => ({
      id: member.companion_id,
      name: member.name,
      accent: member.accent,
      bubbleColor: member.companion_bubble_color,
      provider: member.provider,
      model: member.model,
      hasModelOverride: Boolean(member.room_provider && member.room_model),
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function handleConversationApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeCompanionStorage(env.DB);
    await initializeChatStorage(env.DB);

    if (request.method === "GET") {
      return json({
        conversations: await conversationList(env.DB),
        folders: await folderList(env.DB),
      });
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        kind?: unknown;
        title?: unknown;
        companionIds?: unknown;
      };
      const requestedIds = Array.isArray(body.companionIds)
        ? body.companionIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim().slice(0, 100))
            .filter(Boolean)
        : [];
      const companionIds = Array.from(new Set(requestedIds.length ? requestedIds : ["kian"]));
      const companions = await env.DB
        .prepare(
          `SELECT id, name FROM companions
           WHERE id IN (${companionIds.map(() => "?").join(",")})`,
        )
        .bind(...companionIds)
        .all<{ id: string; name: string }>();
      if ((companions.results || []).length !== companionIds.length) {
        return json({ error: "One of those companions could not be found." }, 404);
      }

      const kind = body.kind === "group" ? "group" : "solo";
      if (kind === "group" && companionIds.length < 2) {
        return json({ error: "Choose at least two companions for a group chat." }, 409);
      }
      const primaryId = companionIds[0];
      const requestedTitle = typeof body.title === "string" ? body.title.trim() : "";
      const fallbackTitle =
        kind === "group"
          ? (companions.results || []).map((item) => item.name).join(" + ")
          : (companions.results || [])[0]?.name || "New chat";
      const title = (requestedTitle || fallbackTitle).slice(0, 100);
      const id = crypto.randomUUID();

      await env.DB
        .prepare(
          `INSERT INTO conversations (id, companion_id, kind, title)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(id, primaryId, kind, title)
        .run();
      await env.DB.batch(
        companionIds.map((companionId, position) =>
          env.DB
            .prepare(
              `INSERT INTO conversation_members
                (conversation_id, companion_id, position)
               VALUES (?, ?, ?)`,
            )
            .bind(id, companionId, position),
        ),
      );

      const conversations = await conversationList(env.DB);
      return json(
        { conversation: conversations.find((conversation) => conversation.id === id) || null },
        201,
      );
    }

    if (request.method === "PATCH") {
      const body = (await request.json()) as {
        id?: unknown;
        title?: unknown;
        action?: unknown;
        companionId?: unknown;
        provider?: unknown;
        model?: unknown;
        useDefault?: unknown;
        pinned?: unknown;
        folderId?: unknown;
      };
      const id = typeof body.id === "string" ? body.id.trim().slice(0, 100) : "";
      if (!id) return json({ error: "Choose a chat first." }, 400);
      const action =
        body.action === "archive" ||
        body.action === "restore" ||
        body.action === "model" ||
        body.action === "pin" ||
        body.action === "move"
          ? body.action
          : "rename";
      let result;
      if (action === "model") {
        const companionId =
          typeof body.companionId === "string"
            ? body.companionId.trim().slice(0, 100)
            : "";
        if (!companionId) {
          return json({ error: "Choose which companion uses this model." }, 400);
        }
        if (body.useDefault === true) {
          result = await env.DB
            .prepare(
              `UPDATE conversation_members
               SET provider = NULL, model = NULL
               WHERE conversation_id = ? AND companion_id = ?`,
            )
            .bind(id, companionId)
            .run();
        } else {
          const provider =
            body.provider === "anthropic" ||
            body.provider === "openai" ||
            body.provider === "openrouter"
              ? body.provider
              : "";
          const model =
            typeof body.model === "string"
              ? body.model.trim().slice(0, 200)
              : "";
          if (!provider || !model) {
            return json({ error: "Choose a provider and model for this chat." }, 400);
          }
          result = await env.DB
            .prepare(
              `UPDATE conversation_members
               SET provider = ?, model = ?
               WHERE conversation_id = ? AND companion_id = ?`,
            )
            .bind(provider, model, id, companionId)
            .run();
        }
        if (result.meta.changes) {
          await env.DB
            .prepare(
              `UPDATE conversations
               SET updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
            )
            .bind(id)
            .run();
        }
      } else if (action === "pin") {
        result = await env.DB
          .prepare(
            `UPDATE conversations
             SET pinned_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END
             WHERE id = ?`,
          )
          .bind(body.pinned === true ? 1 : 0, id)
          .run();
      } else if (action === "move") {
        const folderId =
          typeof body.folderId === "string" && body.folderId.trim()
            ? body.folderId.trim().slice(0, 100)
            : null;
        if (folderId) {
          const folder = await env.DB
            .prepare("SELECT id FROM folders WHERE id = ?")
            .bind(folderId)
            .first<{ id: string }>();
          if (!folder) return json({ error: "That folder could not be found." }, 404);
        }
        result = await env.DB
          .prepare("UPDATE conversations SET folder_id = ? WHERE id = ?")
          .bind(folderId, id)
          .run();
      } else if (action === "archive") {
        result = await env.DB
          .prepare(
            `UPDATE conversations
             SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
          )
          .bind(id)
          .run();
      } else if (action === "restore") {
        result = await env.DB
          .prepare(
            `UPDATE conversations
             SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
          )
          .bind(id)
          .run();
      } else {
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";
        if (!title) return json({ error: "Give the chat a name first." }, 400);
        result = await env.DB
          .prepare(
            `UPDATE conversations
             SET title = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
          )
          .bind(title, id)
          .run();
      }
      if (!result.meta.changes) return json({ error: "That chat could not be found." }, 404);
      const conversations = await conversationList(env.DB);
      return json({
        conversation: conversations.find((conversation) => conversation.id === id) || null,
      });
    }

    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const id = (url.searchParams.get("id") || "").trim().slice(0, 100);
      if (!id) return json({ error: "Choose a chat to delete." }, 400);
      const conversation = await env.DB
        .prepare("SELECT id FROM conversations WHERE id = ?")
        .bind(id)
        .first<{ id: string }>();
      if (!conversation) return json({ ok: true, deletedId: id });

      const attachments = await env.DB
        .prepare("SELECT storage_key FROM attachments WHERE conversation_id = ?")
        .bind(id)
        .all<{ storage_key: string }>();
      for (const attachment of attachments.results || []) {
        await env.BUCKET.delete(attachment.storage_key);
      }

      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO deleted_conversations (id, deleted_at)
             VALUES (?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET deleted_at = CURRENT_TIMESTAMP`,
          )
          .bind(id),
        env.DB.prepare("DELETE FROM memory_checkpoints WHERE conversation_id = ?").bind(id),
        env.DB.prepare("DELETE FROM memory_runs WHERE conversation_id = ?").bind(id),
        env.DB.prepare("DELETE FROM attachments WHERE conversation_id = ?").bind(id),
        env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
        env.DB.prepare("DELETE FROM conversation_members WHERE conversation_id = ?").bind(id),
        env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
      ]);
      return json({ ok: true, deletedId: id });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error ? error.message : "Conversation management failed.",
      },
      500,
    );
  }
}
