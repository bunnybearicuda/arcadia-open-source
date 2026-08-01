import type { CompanionApiEnv } from "./companion-api";
import { initializeChatStorage } from "./chat-api";
import {
  DEFAULT_WINDOWS,
  insideWindow,
  type CheckInWindow,
} from "./check-in-schedule";

// Companion-initiated check-ins (PDF Phase 10: "so an AI can reach me even
// when the app is closed"). An external scheduler pokes this hourly; the app
// itself decides whether anyone is actually due.
const CREATE_CHECK_IN_SETTINGS = `
  CREATE TABLE IF NOT EXISTS check_in_settings (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    quiet_hours INTEGER NOT NULL DEFAULT 15,
    windows_json TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'America/Chicago',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

type CheckInSettings = {
  enabled: boolean;
  quietHours: number;
  windows: CheckInWindow[];
  timezone: string;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function initializeCheckInStorage(database: D1Database) {
  await database.prepare(CREATE_CHECK_IN_SETTINGS).run();
  await database
    .prepare("INSERT OR IGNORE INTO check_in_settings (id) VALUES ('default')")
    .run();
  const companionColumns = await database
    .prepare("PRAGMA table_info(companions)")
    .all<{ name: string }>();
  if (!(companionColumns.results || []).some((column) => column.name === "check_in_enabled")) {
    await database
      .prepare("ALTER TABLE companions ADD COLUMN check_in_enabled INTEGER NOT NULL DEFAULT 0")
      .run();
  }
  const messageColumns = await database
    .prepare("PRAGMA table_info(messages)")
    .all<{ name: string }>();
  if (!(messageColumns.results || []).some((column) => column.name === "is_check_in")) {
    await database
      .prepare("ALTER TABLE messages ADD COLUMN is_check_in INTEGER NOT NULL DEFAULT 0")
      .run();
  }
}

export async function loadCheckInSettings(
  database: D1Database,
): Promise<CheckInSettings> {
  await initializeCheckInStorage(database);
  const row = await database
    .prepare(
      "SELECT enabled, quiet_hours, windows_json, timezone FROM check_in_settings WHERE id = 'default'",
    )
    .first<{
      enabled: number;
      quiet_hours: number;
      windows_json: string;
      timezone: string;
    }>();
  let windows = DEFAULT_WINDOWS;
  if (row?.windows_json) {
    try {
      const parsed = JSON.parse(row.windows_json) as CheckInSettings["windows"];
      if (Array.isArray(parsed) && parsed.length === 7) windows = parsed;
    } catch {
      // Fall back to the defaults on malformed stored settings.
    }
  }
  return {
    enabled: row ? Boolean(row.enabled) : true,
    quietHours: Math.max(1, Number(row?.quiet_hours) || 15),
    windows,
    timezone: row?.timezone || "America/Chicago",
  };
}

type DueConversation = {
  conversation_id: string;
  title: string;
  companion_id: string;
  name: string;
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  last_at: string;
  last_was_check_in: number;
};

export async function findDueConversation(
  database: D1Database,
  settings: CheckInSettings,
  now: Date,
) {
  const cutoff = new Date(now.getTime() - settings.quietHours * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const row = await database
    .prepare(
      `SELECT
         c.id AS conversation_id,
         c.title,
         co.id AS companion_id,
         co.name,
         co.provider,
         co.model,
         last.created_at AS last_at,
         last.is_check_in AS last_was_check_in
       FROM conversations c
       JOIN companions co ON co.id = c.companion_id
       JOIN (
         SELECT m.conversation_id,
                MAX(m.created_at) AS created_at,
                MAX(CASE WHEN m.is_check_in = 1 THEN 1 ELSE 0 END) AS is_check_in
         FROM messages m
         WHERE m.superseded_at IS NULL
         GROUP BY m.conversation_id
       ) last ON last.conversation_id = c.id
       WHERE c.archived_at IS NULL
         AND c.kind = 'solo'
         AND co.check_in_enabled = 1
         AND last.created_at <= ?
       ORDER BY last.created_at ASC
       LIMIT 1`,
    )
    .bind(cutoff)
    .first<DueConversation>();
  if (!row) return null;
  // One unanswered check-in at a time: if the newest message in the thread is
  // already a check-in, wait for a reply before sending another.
  const newest = await database
    .prepare(
      `SELECT is_check_in FROM messages
       WHERE conversation_id = ? AND superseded_at IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .bind(row.conversation_id)
    .first<{ is_check_in: number }>();
  if (Number(newest?.is_check_in) === 1) return null;
  return row;
}

export async function handleCheckInApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeChatStorage(env.DB);
    await initializeCheckInStorage(env.DB);

    if (request.method === "GET") {
      const settings = await loadCheckInSettings(env.DB);
      const companions = await env.DB
        .prepare("SELECT id, name, check_in_enabled FROM companions ORDER BY name")
        .all<{ id: string; name: string; check_in_enabled: number }>();
      return json({
        ...settings,
        companions: (companions.results || []).map((row) => ({
          id: row.id,
          name: row.name,
          checkInEnabled: Boolean(row.check_in_enabled),
        })),
      });
    }

    if (request.method === "PUT") {
      const body = (await request.json()) as {
        enabled?: unknown;
        quietHours?: unknown;
        windows?: unknown;
        timezone?: unknown;
        companionId?: unknown;
        checkInEnabled?: unknown;
      };
      if (typeof body.companionId === "string") {
        await env.DB
          .prepare("UPDATE companions SET check_in_enabled = ? WHERE id = ?")
          .bind(body.checkInEnabled === true ? 1 : 0, body.companionId.slice(0, 100))
          .run();
        return json({ ok: true });
      }
      const windows =
        Array.isArray(body.windows) && body.windows.length === 7
          ? JSON.stringify(
              body.windows.map((entry) => {
                const value = entry as { open?: unknown; close?: unknown };
                return {
                  open: Math.min(23, Math.max(0, Number(value.open) || 0)),
                  close: Math.min(24, Math.max(1, Number(value.close) || 21)),
                };
              }),
            )
          : "";
      await env.DB
        .prepare(
          `UPDATE check_in_settings SET
             enabled = ?,
             quiet_hours = ?,
             windows_json = CASE WHEN ? = '' THEN windows_json ELSE ? END,
             timezone = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = 'default'`,
        )
        .bind(
          body.enabled === false ? 0 : 1,
          Math.min(72, Math.max(1, Number(body.quietHours) || 15)),
          windows,
          windows,
          typeof body.timezone === "string" ? body.timezone.slice(0, 60) : "America/Chicago",
        )
        .run();
      return json(await loadCheckInSettings(env.DB));
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }

    // Scheduler entry point. The secret keeps the endpoint from being a public
    // way to make companions message on demand.
    const secret = (env.CHECK_IN_SECRET || "").trim();
    const supplied = (request.headers.get("x-companion-check-in-secret") || "").trim();
    if (!secret || supplied !== secret) {
      return json({ error: "This endpoint requires the scheduler secret." }, 401);
    }

    const settings = await loadCheckInSettings(env.DB);
    const now = new Date();
    if (!settings.enabled) return json({ skipped: "check-ins are turned off" });
    if (!insideWindow(now, settings)) {
      return json({ skipped: "outside the waking window" });
    }
    const due = await findDueConversation(env.DB, settings, now);
    if (!due) return json({ skipped: "nobody is due" });
    // Message generation and delivery land in the next pass; the scheduler can
    // already be pointed here to confirm the timing rules behave.

    return json({
      due: {
        conversationId: due.conversation_id,
        companion: due.name,
        lastAt: due.last_at,
      },
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Check-in run failed." },
      500,
    );
  }
}
