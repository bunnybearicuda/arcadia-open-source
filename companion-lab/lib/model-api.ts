import type { CompanionApiEnv } from "./companion-api";
import { modelPrice } from "./pricing";

type Provider = "anthropic" | "openai" | "openrouter";

type ModelOption = {
  id: string;
  label: string;
  provider: Provider;
  inputPerMillion?: number;
  outputPerMillion?: number;
};

const OPENAI_BLOCKED_KINDS = [
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "image",
  "search",
  "embedding",
  "moderation",
  "whisper",
  "dall-e",
];

const OPENROUTER_FAMILIES = new Set([
  "deepseek",
  "google",
  "meta-llama",
  "mistralai",
  "moonshotai",
  "nousresearch",
  "openai",
  "qwen",
]);

const OPENROUTER_FAVORITES = [
  "moonshotai/kimi-k2",
  "moonshotai/kimi-k2-0905",
  "moonshotai/kimi-k2-thinking",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-r1",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
];

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function requestKey(request: Request) {
  return (request.headers.get("x-companion-provider-key") || "").trim().slice(0, 1000);
}

function keyFor(provider: Provider, env: CompanionApiEnv, suppliedKey: string) {
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY || suppliedKey;
  if (provider === "openai") return env.OPENAI_API_KEY || suppliedKey;
  return env.OPENROUTER_API_KEY || suppliedKey;
}

function dollarsPerMillion(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
}

function isOpenAIChatModel(id: string) {
  const lowered = id.toLowerCase();
  if (OPENAI_BLOCKED_KINDS.some((kind) => lowered.includes(kind))) return false;
  if (/^gpt-(4\.1|4o)(?:$|-)/.test(lowered)) return true;
  return /^gpt-[5-9].*(mini|nano)/.test(lowered);
}

function normalizeAnthropic(payload: unknown): ModelOption[] {
  const data = (payload as { data?: Array<{ id?: string; display_name?: string }> }).data || [];
  return data
    .filter((model): model is { id: string; display_name?: string } => Boolean(model.id?.startsWith("claude-")))
    .map((model) => ({
      id: model.id,
      label: model.display_name || model.id,
      provider: "anthropic" as const,
      ...(modelPrice("anthropic", model.id) || {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeOpenAI(payload: unknown): ModelOption[] {
  const data = (payload as { data?: Array<{ id?: string }> }).data || [];
  return data
    .filter((model): model is { id: string } => Boolean(model.id && isOpenAIChatModel(model.id)))
    .map((model) => ({
      id: model.id,
      label: model.id
        .replace(/^gpt-/, "GPT ")
        .replace("4o", "4o")
        .replaceAll("-", " "),
      provider: "openai" as const,
      ...(modelPrice("openai", model.id) || {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOpenRouter(payload: unknown): ModelOption[] {
  const data = (
    payload as {
      data?: Array<{
        id?: string;
        name?: string;
        pricing?: { prompt?: string; completion?: string };
        architecture?: { output_modalities?: string[] };
      }>;
    }
  ).data || [];

  return data
    .filter((model): model is NonNullable<(typeof data)[number]> & { id: string } => {
      if (!model.id || !OPENROUTER_FAMILIES.has(model.id.split("/")[0])) return false;
      if (
        model.architecture?.output_modalities &&
        !model.architecture.output_modalities.includes("text")
      ) {
        return false;
      }
      const input = dollarsPerMillion(model.pricing?.prompt);
      const output = dollarsPerMillion(model.pricing?.completion);
      return (input === undefined || input <= 3) && (output === undefined || output <= 15);
    })
    .map((model) => ({
      id: model.id,
      label: model.name || model.id,
      provider: "openrouter" as const,
      inputPerMillion: dollarsPerMillion(model.pricing?.prompt),
      outputPerMillion: dollarsPerMillion(model.pricing?.completion),
    }))
    .sort((a, b) => {
      const aFavorite = OPENROUTER_FAVORITES.indexOf(a.id);
      const bFavorite = OPENROUTER_FAVORITES.indexOf(b.id);
      if (aFavorite >= 0 || bFavorite >= 0) {
        if (aFavorite < 0) return 1;
        if (bFavorite < 0) return -1;
        return aFavorite - bFavorite;
      }
      const aPrice = (a.inputPerMillion || 0) + (a.outputPerMillion || 0);
      const bPrice = (b.inputPerMillion || 0) + (b.outputPerMillion || 0);
      return aPrice - bPrice || a.label.localeCompare(b.label);
    })
    .slice(0, 100);
}

async function providerError(response: Response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message || parsed.message || `Provider request failed (${response.status}).`;
  } catch {
    return raw.slice(0, 400) || `Provider request failed (${response.status}).`;
  }
}

export async function handleModelApi(request: Request, env: CompanionApiEnv) {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const provider = new URL(request.url).searchParams.get("provider") as Provider | null;
  if (!provider || !["anthropic", "openai", "openrouter"].includes(provider)) {
    return json({ error: "Choose a supported provider." }, 400);
  }

  const suppliedKey = requestKey(request);
  const key = keyFor(provider, env, suppliedKey);
  if (provider !== "openrouter" && !key) {
    return json({ error: `Connect the ${provider} API key to load its available models.` }, 409);
  }

  let response: Response;
  if (provider === "anthropic") {
    response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
  } else if (provider === "openai") {
    response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
  } else {
    response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
    });
  }

  if (!response.ok) return json({ error: await providerError(response) }, response.status);
  const payload = await response.json();
  const models =
    provider === "anthropic"
      ? normalizeAnthropic(payload)
      : provider === "openai"
        ? normalizeOpenAI(payload)
        : normalizeOpenRouter(payload);
  return json({ provider, models });
}
