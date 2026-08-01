import type { MemoryRow } from "./memory-api";
import type { CompanionApiEnv } from "./companion-api";
import {
  assertPrivateSupabaseKey,
  supabaseApiHeaders,
  supabaseKeyKind,
} from "./supabase-auth";

export type SupabaseMemoryConfig = {
  url: string;
  key: string;
};

type SupabaseEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

function cleanUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function supabaseMemoryConfig(request: Request, env: SupabaseEnv) {
  const url = cleanUrl(
    env.SUPABASE_URL || request.headers.get("x-companion-supabase-url") || "",
  );
  const key = (
    env.SUPABASE_SERVICE_ROLE_KEY ||
    request.headers.get("x-companion-supabase-key") ||
    ""
  ).trim();
  if (!url || !key) return null;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    throw new Error("The Supabase project URL is not valid.");
  }
  if (key.length < 40) throw new Error("The Supabase secret or service-role key is incomplete.");
  assertPrivateSupabaseKey(key);
  return { url, key } satisfies SupabaseMemoryConfig;
}

async function supabaseFetch(
  config: SupabaseMemoryConfig,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${config.url}/rest/v1${path}`, {
    ...init,
    headers: {
      ...supabaseApiHeaders(config.key),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { message?: string; hint?: string };
      message = [parsed.message, parsed.hint].filter(Boolean).join(" · ") || raw;
    } catch {
      // Keep the provider body when it is not JSON.
    }
    const lower = message.toLowerCase();
    if (
      response.status === 401 ||
      response.status === 403 ||
      lower.includes("permission denied")
    ) {
      const kind = supabaseKeyKind(config.key);
      const keyLabel = kind === "secret" || kind === "service_role" ? "private" : "unknown";
      throw new Error(
        `Supabase rejected the ${keyLabel} key. In Project Settings → API Keys, copy a Secret key (sb_secret_…) or the Legacy service_role key. Never grant anon access to the memories table.`,
      );
    }
    if (response.status === 404 || lower.includes("could not find the table")) {
      throw new Error(
        "Supabase cannot find public.memories. Copy the setup SQL from Companion Lab, run it in the Supabase SQL Editor, then reconnect.",
      );
    }
    throw new Error(`Supabase memory request failed (${response.status}): ${message.slice(0, 500)}`);
  }
  return response;
}

function row(value: Record<string, unknown>): MemoryRow {
  return {
    id: String(value.id || ""),
    owner_id: String(value.owner_id || "shared"),
    scope: String(value.scope || "shared"),
    category: String(value.category || "memory"),
    content: String(value.content || ""),
    source: String(value.source || "manual"),
    source_ref: typeof value.source_ref === "string" ? value.source_ref : null,
    source_url: typeof value.source_url === "string" ? value.source_url : null,
    priority: Number(value.priority) || 1,
    pinned: value.pinned === true || Number(value.pinned) === 1 ? 1 : 0,
    active: value.active === false || Number(value.active) === 0 ? 0 : 1,
    created_at: String(value.created_at || new Date().toISOString()),
    updated_at: String(value.updated_at || new Date().toISOString()),
  };
}

export async function checkSupabaseMemory(config: SupabaseMemoryConfig) {
  const response = await supabaseFetch(
    config,
    "/memories?select=id&limit=1",
    { headers: { prefer: "count=exact" } },
  );
  return {
    count: Number(response.headers.get("content-range")?.split("/").at(-1)) || 0,
  };
}

export async function searchSupabaseMemories(
  config: SupabaseMemoryConfig,
  companionId: string,
  query: string,
  limit = 40,
) {
  const response = await supabaseFetch(config, "/rpc/search_companion_memories", {
    method: "POST",
    body: JSON.stringify({
      p_companion_id: companionId,
      // Keep the tail: the newest turns are the retrieval signal, and
      // truncating from the front used to drop the user's latest message
      // from the search entirely in long threads.
      p_query: query.slice(-20_000),
      p_limit: Math.min(100, Math.max(1, limit)),
    }),
  });
  const values = (await response.json()) as Array<Record<string, unknown>>;
  return values.map(row);
}

export async function listSupabaseMemories(
  config: SupabaseMemoryConfig,
  ownerId?: string,
) {
  const filter = ownerId ? `&owner_id=eq.${encodeURIComponent(ownerId)}` : "";
  const response = await supabaseFetch(
    config,
    `/memories?select=*&active=eq.true${filter}&order=pinned.desc,priority.desc,updated_at.desc&limit=2000`,
  );
  const values = (await response.json()) as Array<Record<string, unknown>>;
  return values.map(row);
}

export async function upsertSupabaseMemories(
  config: SupabaseMemoryConfig,
  memories: MemoryRow[],
) {
  if (!memories.length) return;
  await supabaseFetch(config, "/memories?on_conflict=id", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(
      memories.map((memory) => ({
        id: memory.id,
        owner_id: memory.owner_id,
        scope: memory.scope,
        category: memory.category,
        content: memory.content,
        source: memory.source,
        source_ref: memory.source_ref,
        source_url: memory.source_url,
        priority: Number(memory.priority) || 1,
        pinned: Boolean(memory.pinned),
        active: Boolean(memory.active),
        created_at: memory.created_at,
        updated_at: memory.updated_at,
      })),
    ),
  });
}

export async function deactivateSupabaseMemories(
  config: SupabaseMemoryConfig,
  ids: string[],
) {
  if (!ids.length) return;
  const encoded = ids.map((id) => `"${id.replaceAll('"', "")}"`).join(",");
  await supabaseFetch(config, `/memories?id=in.(${encodeURIComponent(encoded)})`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
}

export async function handleSupabaseMemoryApi(
  request: Request,
  env: CompanionApiEnv,
) {
  try {
    const config = supabaseMemoryConfig(request, env);
    if (!config) {
      return Response.json(
        { error: "Connect the Supabase project URL and secret or service-role key first." },
        { status: 409 },
      );
    }
    if (request.method === "GET") {
      return Response.json({ ok: true, ...(await checkSupabaseMemory(config)) });
    }
    if (request.method === "POST") {
      const rows = await env.DB
        .prepare(
          `SELECT id, owner_id, scope, category, content, source, source_ref,
                  source_url, priority, pinned, active, created_at, updated_at
           FROM memories
           ORDER BY updated_at ASC`,
        )
        .all<MemoryRow>();
      await upsertSupabaseMemories(config, rows.results || []);
      return Response.json({ ok: true, migrated: (rows.results || []).length });
    }
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Supabase memory setup failed." },
      { status: 500 },
    );
  }
}
