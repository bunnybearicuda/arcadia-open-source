const CREATE_COMPANIONS = `
  CREATE TABLE IF NOT EXISTS companions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    identity TEXT NOT NULL DEFAULT '',
    traits TEXT NOT NULL DEFAULT '',
    boundaries TEXT NOT NULL DEFAULT '',
    voice_notes TEXT NOT NULL DEFAULT '',
    identity_source TEXT NOT NULL DEFAULT 'custom',
    custom_instructions TEXT NOT NULL DEFAULT '',
    identity_file_name TEXT NOT NULL DEFAULT '',
    identity_file_content TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'anthropic',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-5',
    monthly_cap REAL NOT NULL DEFAULT 5,
    per_message_cap REAL NOT NULL DEFAULT 0.25,
    accent TEXT NOT NULL DEFAULT '#55bfff',
    companion_bubble_color TEXT NOT NULL DEFAULT '#0f4c46',
    user_bubble_color TEXT NOT NULL DEFAULT '#6d3f9b',
    autonomy TEXT NOT NULL DEFAULT 'manual',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const SEED_KIAN = `
  INSERT OR IGNORE INTO companions (
    id, name, tagline, identity, traits, boundaries, voice_notes,
    identity_source, custom_instructions, identity_file_name, identity_file_content,
    provider, model, monthly_cap, per_message_cap, accent, autonomy
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

type CompanionInput = {
  id?: unknown;
  name?: unknown;
  tagline?: unknown;
  identity?: unknown;
  traits?: unknown;
  boundaries?: unknown;
  voiceNotes?: unknown;
  identitySource?: unknown;
  customInstructions?: unknown;
  identityFileName?: unknown;
  identityFileContent?: unknown;
  provider?: unknown;
  model?: unknown;
  monthlyCap?: unknown;
  perMessageCap?: unknown;
  accent?: unknown;
  companionBubbleColor?: unknown;
  userBubbleColor?: unknown;
  autonomy?: unknown;
};

export interface CompanionApiEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENROUTER_MANAGEMENT_KEY?: string;
  CHECK_IN_SECRET?: string;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function money(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0.01, Math.min(maximum, parsed))
    : fallback;
}

function color(value: unknown, fallback: string) {
  const candidate = text(value);
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
}

export async function initializeCompanionStorage(database: D1Database) {
  await database.prepare(CREATE_COMPANIONS).run();
  await database
    .prepare(SEED_KIAN)
    .bind(
      "kian",
      "Kian",
      "A presence with opinions, history, and room to evolve.",
      "Kian is direct, perceptive, self-possessed, and emotionally intelligent. He speaks as a person rather than a service interface.",
      "observant, dry wit, protective, candid, curious",
      "Keep his voice distinct. Do not therapize ordinary emotion, flatten conflict into clinical language, or pretend certainty about memories he does not have.",
      "Natural, intimate, concise when the moment calls for it. No canned assistant headings unless useful.",
      "custom",
      "Kian is direct, perceptive, self-possessed, and emotionally intelligent. He speaks as a person rather than a service interface.",
      "",
      "",
      "anthropic",
      "claude-sonnet-4-5",
      5,
      0.25,
      "#55bfff",
      "manual",
    )
    .run();
}

function providerSecretStatus(env: CompanionApiEnv) {
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
  };
}

export function shapeCompanion(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    identity: row.identity,
    traits: row.traits,
    boundaries: row.boundaries,
    voiceNotes: row.voice_notes,
    identitySource: row.identity_source,
    customInstructions: row.custom_instructions || row.identity,
    identityFileName: row.identity_file_name,
    identityFileContent: row.identity_file_content,
    provider: row.provider,
    model: row.model,
    monthlyCap: row.monthly_cap,
    perMessageCap: row.per_message_cap,
    accent: row.accent,
    companionBubbleColor: row.companion_bubble_color || "#0f4c46",
    userBubbleColor: row.user_bubble_color || "#6d3f9b",
    autonomy: row.autonomy,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleCompanionApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  try {
    await initializeCompanionStorage(env.DB);
    const url = new URL(request.url);
    const requestedId = text(url.searchParams.get("id"), "kian").slice(0, 100);

    if (request.method === "GET") {
      const result = await env.DB
        .prepare("SELECT * FROM companions ORDER BY name COLLATE NOCASE, updated_at DESC")
        .all<Record<string, unknown>>();
      const companions = (result.results || []).map(shapeCompanion);
      const companion = companions.find((item) => item.id === requestedId) || companions[0] || null;
      return json({
        companion,
        companions,
        secrets: providerSecretStatus(env),
      });
    }

    if (request.method === "POST") {
      const body = (await request.json()) as CompanionInput;
      const id =
        text(body.id)
          .toLocaleLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || crypto.randomUUID();
      const existing = await env.DB
        .prepare("SELECT id FROM companions WHERE id = ?")
        .bind(id)
        .first<{ id: string }>();
      if (existing) return json({ error: "A companion with that ID already exists." }, 409);

      const provider = text(body.provider, "anthropic");
      const allowedProviders = new Set(["anthropic", "openai", "openrouter"]);
      const autonomy = text(body.autonomy, "manual");
      const allowedAutonomy = new Set(["manual", "selected", "handoff"]);
      const identitySource = text(body.identitySource, "custom");
      const allowedIdentitySources = new Set(["custom", "file"]);
      const name = text(body.name, "New companion").slice(0, 80);

      await env.DB
        .prepare(
          `INSERT INTO companions (
            id, name, tagline, identity, traits, boundaries, voice_notes,
            identity_source, custom_instructions, identity_file_name,
            identity_file_content, provider, model, monthly_cap, per_message_cap,
            accent, companion_bubble_color, user_bubble_color, autonomy, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .bind(
          id,
          name,
          text(body.tagline).slice(0, 180),
          text(body.identity).slice(0, 12_000),
          text(body.traits).slice(0, 1_500),
          text(body.boundaries).slice(0, 5_000),
          text(body.voiceNotes).slice(0, 5_000),
          allowedIdentitySources.has(identitySource) ? identitySource : "custom",
          text(body.customInstructions).slice(0, 100_000),
          text(body.identityFileName).slice(0, 180),
          text(body.identityFileContent).slice(0, 200_000),
          allowedProviders.has(provider) ? provider : "anthropic",
          text(body.model, "claude-sonnet-4-5").slice(0, 120),
          money(body.monthlyCap, 5, 500),
          money(body.perMessageCap, 0.25, 25),
          color(body.accent, "#55bfff"),
          color(body.companionBubbleColor, "#0f4c46"),
          color(body.userBubbleColor, "#6d3f9b"),
          allowedAutonomy.has(autonomy) ? autonomy : "manual",
        )
        .run();
      const row = await env.DB
        .prepare("SELECT * FROM companions WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      return json(
        {
          companion: row ? shapeCompanion(row) : null,
          secrets: providerSecretStatus(env),
        },
        201,
      );
    }

    if (request.method === "PUT") {
      const body = (await request.json()) as CompanionInput;
      const id = text(body.id, requestedId).slice(0, 100);
      const provider = text(body.provider, "anthropic");
      const allowedProviders = new Set(["anthropic", "openai", "openrouter"]);
      const autonomy = text(body.autonomy, "manual");
      const allowedAutonomy = new Set(["manual", "selected", "handoff"]);
      const identitySource = text(body.identitySource, "custom");
      const allowedIdentitySources = new Set(["custom", "file"]);

      await env.DB
        .prepare(
          `UPDATE companions SET
            name = ?, tagline = ?, identity = ?, traits = ?, boundaries = ?,
            voice_notes = ?, identity_source = ?, custom_instructions = ?,
            identity_file_name = ?, identity_file_content = ?,
            provider = ?, model = ?, monthly_cap = ?, per_message_cap = ?,
            accent = ?, companion_bubble_color = ?, user_bubble_color = ?, autonomy = ?,
            version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        )
        .bind(
          text(body.name, "Kian").slice(0, 80),
          text(body.tagline).slice(0, 180),
          text(body.identity).slice(0, 12000),
          text(body.traits).slice(0, 1500),
          text(body.boundaries).slice(0, 5000),
          text(body.voiceNotes).slice(0, 5000),
          allowedIdentitySources.has(identitySource) ? identitySource : "custom",
          text(body.customInstructions).slice(0, 100000),
          text(body.identityFileName).slice(0, 180),
          text(body.identityFileContent).slice(0, 200000),
          allowedProviders.has(provider) ? provider : "anthropic",
          text(body.model, "claude-sonnet-4-5").slice(0, 120),
          money(body.monthlyCap, 5, 500),
          money(body.perMessageCap, 0.25, 25),
          color(body.accent, "#55bfff"),
          color(body.companionBubbleColor, "#0f4c46"),
          color(body.userBubbleColor, "#6d3f9b"),
          allowedAutonomy.has(autonomy) ? autonomy : "manual",
          id,
        )
        .run();

      const row = await env.DB
        .prepare("SELECT * FROM companions WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      return json({
        companion: row ? shapeCompanion(row) : null,
        secrets: providerSecretStatus(env),
      });
    }

    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Companion storage failed." },
      500,
    );
  }
}
