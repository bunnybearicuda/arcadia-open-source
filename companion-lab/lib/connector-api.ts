import type { CompanionApiEnv } from "./companion-api";

// Connectors (PDF Phase 8): MCP servers and plain HTTP APIs that companions can
// use to take actions. Definitions live in D1; secrets stay in the auth column
// and are never returned to the client.
const CREATE_CONNECTORS = `
  CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'mcp',
    url TEXT NOT NULL,
    auth_header TEXT NOT NULL DEFAULT '',
    auth_value TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    allowed_tools TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

export type ConnectorRow = {
  id: string;
  name: string;
  kind: "mcp" | "http";
  url: string;
  auth_header: string;
  auth_value: string;
  description: string;
  enabled: number;
  allowed_tools: string;
};

export type ConnectorTool = {
  connectorId: string;
  connectorName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export async function initializeConnectorStorage(database: D1Database) {
  await database.prepare(CREATE_CONNECTORS).run();
}

function connectorHeaders(row: ConnectorRow) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (row.auth_header && row.auth_value) {
    headers[row.auth_header] = row.auth_value;
  }
  return headers;
}

// Minimal MCP client over Streamable HTTP. Enough to list a server's tools and
// call one; anything richer belongs in a dedicated client.
async function mcpRequest(row: ConnectorRow, method: string, params: unknown) {
  const response = await fetch(row.url, {
    method: "POST",
    headers: { ...connectorHeaders(row), accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: params ?? {},
    }),
  });
  if (!response.ok) {
    throw new Error(`${row.name} returned ${response.status}.`);
  }
  const body = await response.text();
  // Streamable HTTP servers may answer as SSE; take the last data frame.
  const payload = body.includes("data:")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1) || "{}"
    : body;
  const parsed = JSON.parse(payload) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (parsed.error) throw new Error(parsed.error.message || `${row.name} rejected the request.`);
  return parsed.result;
}

export async function listConnectorTools(row: ConnectorRow): Promise<ConnectorTool[]> {
  if (row.kind !== "mcp") {
    // A plain HTTP connector exposes exactly one call.
    return [
      {
        connectorId: row.id,
        connectorName: row.name,
        name: `call_${row.id.replace(/[^a-z0-9_]/gi, "_").slice(0, 40)}`,
        description: row.description || `Send a request to ${row.name}.`,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path appended to the connector URL." },
            method: { type: "string", enum: ["GET", "POST"], description: "HTTP method." },
            body: { type: "string", description: "Optional JSON body for POST." },
          },
          required: ["path", "method"],
        },
      },
    ];
  }
  const result = (await mcpRequest(row, "tools/list", {})) as {
    tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
  };
  const allowed = row.allowed_tools
    ? new Set(row.allowed_tools.split(",").map((entry) => entry.trim()).filter(Boolean))
    : null;
  return (result?.tools || [])
    .filter((tool) => typeof tool.name === "string")
    .filter((tool) => !allowed || allowed.has(tool.name as string))
    .map((tool) => ({
      connectorId: row.id,
      connectorName: row.name,
      name: tool.name as string,
      description: tool.description || `${row.name} tool.`,
      parameters:
        (tool.inputSchema as Record<string, unknown>) || {
          type: "object",
          properties: {},
        },
    }));
}

export async function callConnectorTool(
  row: ConnectorRow,
  toolName: string,
  args: Record<string, unknown>,
) {
  if (row.kind !== "mcp") {
    const path = text(args.path, "");
    const method = args.method === "POST" ? "POST" : "GET";
    const target = new URL(path.replace(/^\/+/, ""), row.url.endsWith("/") ? row.url : `${row.url}/`);
    const response = await fetch(target, {
      method,
      headers: connectorHeaders(row),
      ...(method === "POST" && typeof args.body === "string" ? { body: args.body } : {}),
    });
    const body = await response.text();
    return body.slice(0, 20_000);
  }
  const result = (await mcpRequest(row, "tools/call", {
    name: toolName,
    arguments: args,
  })) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const rendered = (result?.content || [])
    .map((part) => (part.type === "text" ? part.text || "" : ""))
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
  return rendered || JSON.stringify(result).slice(0, 20_000);
}

export async function enabledConnectors(database: D1Database) {
  await initializeConnectorStorage(database);
  const rows = await database
    .prepare(
      `SELECT id, name, kind, url, auth_header, auth_value, description, enabled, allowed_tools
       FROM connectors WHERE enabled = 1 ORDER BY name COLLATE NOCASE`,
    )
    .all<ConnectorRow>();
  return rows.results || [];
}

// On-demand loading (PDF Phase 8): companions see one lightweight gateway tool
// listing what is available, and the connector's real tools are only fetched
// and offered once they ask for that connector by name.
export function connectorGatewayTool(rows: ConnectorRow[]) {
  if (!rows.length) return null;
  return {
    name: "open_connector",
    description: `Load the tools for one connected service, then use them. Available: ${rows
      .map((row) => `${row.name}${row.description ? ` (${row.description})` : ""}`)
      .join("; ")}. Only call this when the request genuinely needs that service.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        connector: {
          type: "string",
          enum: rows.map((row) => row.name),
          description: "The service whose tools should be loaded.",
        },
      },
      required: ["connector"],
    },
  };
}

export async function handleConnectorApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeConnectorStorage(env.DB);

    if (request.method === "GET") {
      const url = new URL(request.url);
      const probeId = url.searchParams.get("probe");
      if (probeId) {
        const row = await env.DB
          .prepare(
            `SELECT id, name, kind, url, auth_header, auth_value, description, enabled, allowed_tools
             FROM connectors WHERE id = ?`,
          )
          .bind(probeId.slice(0, 100))
          .first<ConnectorRow>();
        if (!row) return json({ error: "That connector could not be found." }, 404);
        try {
          const tools = await listConnectorTools(row);
          return json({
            ok: true,
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: error instanceof Error ? error.message : "The connector did not respond.",
            },
            502,
          );
        }
      }
      const rows = await env.DB
        .prepare(
          `SELECT id, name, kind, url, description, enabled, allowed_tools, auth_header,
                  CASE WHEN auth_value = '' THEN 0 ELSE 1 END AS has_auth
           FROM connectors ORDER BY name COLLATE NOCASE`,
        )
        .all<ConnectorRow & { has_auth: number }>();
      return json({
        connectors: (rows.results || []).map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          url: row.url,
          description: row.description,
          enabled: Boolean(row.enabled),
          allowedTools: row.allowed_tools,
          authHeader: row.auth_header,
          hasAuth: Boolean(row.has_auth),
        })),
      });
    }

    if (request.method === "POST" || request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      const name = text(body.name).slice(0, 80);
      const url = text(body.url).slice(0, 500);
      if (!name) return json({ error: "Give the connector a name." }, 400);
      if (!/^https:\/\//i.test(url)) {
        return json({ error: "The connector URL must start with https://" }, 400);
      }
      const kind = body.kind === "http" ? "http" : "mcp";
      const id = text(body.id) || crypto.randomUUID();
      const authValue = text(body.authValue);
      await env.DB
        .prepare(
          `INSERT INTO connectors
             (id, name, kind, url, auth_header, auth_value, description, enabled, allowed_tools)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             url = excluded.url,
             auth_header = excluded.auth_header,
             -- Keep the stored secret when the form leaves it blank.
             auth_value = CASE WHEN excluded.auth_value = '' THEN connectors.auth_value
                               ELSE excluded.auth_value END,
             description = excluded.description,
             enabled = excluded.enabled,
             allowed_tools = excluded.allowed_tools,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(
          id,
          name,
          kind,
          url,
          text(body.authHeader).slice(0, 80),
          authValue.slice(0, 1000),
          text(body.description).slice(0, 300),
          body.enabled === false ? 0 : 1,
          text(body.allowedTools).slice(0, 1000),
        )
        .run();
      return json({ ok: true, id }, request.method === "POST" ? 201 : 200);
    }

    if (request.method === "DELETE") {
      const id = (new URL(request.url).searchParams.get("id") || "").trim().slice(0, 100);
      if (!id) return json({ error: "Choose a connector to remove." }, 400);
      await env.DB.prepare("DELETE FROM connectors WHERE id = ?").bind(id).run();
      return json({ ok: true, deletedId: id });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Connector management failed." },
      500,
    );
  }
}
