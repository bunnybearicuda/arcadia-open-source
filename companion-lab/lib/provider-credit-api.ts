import type { CompanionApiEnv } from "./companion-api";

type OpenRouterKeyPayload = {
  data?: {
    label?: unknown;
    limit?: unknown;
    limit_reset?: unknown;
    limit_remaining?: unknown;
    usage?: unknown;
    usage_daily?: unknown;
    usage_weekly?: unknown;
    usage_monthly?: unknown;
  };
};

type OpenRouterCreditsPayload = {
  data?: {
    total_credits?: unknown;
    total_usage?: unknown;
  };
};

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function headerKey(request: Request, name: string) {
  return (request.headers.get(name) || "").trim().slice(0, 1000);
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function providerError(response: Response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message || parsed.message || `OpenRouter request failed (${response.status}).`;
  } catch {
    return raw.slice(0, 300) || `OpenRouter request failed (${response.status}).`;
  }
}

async function fetchKeyActivity(key: string) {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(await providerError(response));
  const payload = (await response.json()) as OpenRouterKeyPayload;
  const data = payload.data || {};
  return {
    label: typeof data.label === "string" ? data.label : "OpenRouter key",
    limit: finiteNumber(data.limit),
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    limitRemaining: finiteNumber(data.limit_remaining),
    usage: Math.max(0, finiteNumber(data.usage) || 0),
    usageDaily: Math.max(0, finiteNumber(data.usage_daily) || 0),
    usageWeekly: Math.max(0, finiteNumber(data.usage_weekly) || 0),
    usageMonthly: Math.max(0, finiteNumber(data.usage_monthly) || 0),
  };
}

async function fetchAccountCredits(key: string) {
  const response = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(await providerError(response));
  const payload = (await response.json()) as OpenRouterCreditsPayload;
  const totalCredits = finiteNumber(payload.data?.total_credits);
  const totalUsage = finiteNumber(payload.data?.total_usage);
  if (totalCredits === null || totalUsage === null) {
    throw new Error("OpenRouter returned an incomplete credit summary.");
  }
  return {
    totalCredits: Math.max(0, totalCredits),
    totalUsage: Math.max(0, totalUsage),
    remaining: Math.max(0, totalCredits - totalUsage),
  };
}

export async function handleProviderCreditApi(
  request: Request,
  env: CompanionApiEnv,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== "openrouter") {
    return json(
      { error: "Live provider credit sync is currently available for OpenRouter." },
      400,
    );
  }

  const chatKey =
    headerKey(request, "x-companion-provider-key") || env.OPENROUTER_API_KEY || "";
  const managementKey =
    headerKey(request, "x-openrouter-management-key") ||
    env.OPENROUTER_MANAGEMENT_KEY ||
    "";

  if (!chatKey && !managementKey) {
    return json(
      { error: "Connect an OpenRouter API key to sync live key activity." },
      409,
    );
  }

  const [keyResult, accountResult] = await Promise.allSettled([
    chatKey ? fetchKeyActivity(chatKey) : Promise.resolve(null),
    managementKey ? fetchAccountCredits(managementKey) : Promise.resolve(null),
  ]);

  const key = keyResult.status === "fulfilled" ? keyResult.value : null;
  const account =
    accountResult.status === "fulfilled" ? accountResult.value : null;
  const keyError =
    keyResult.status === "rejected"
      ? keyResult.reason instanceof Error
        ? keyResult.reason.message
        : "OpenRouter key activity could not be read."
      : null;
  const accountError =
    accountResult.status === "rejected"
      ? accountResult.reason instanceof Error
        ? accountResult.reason.message
        : "OpenRouter account credits could not be read."
      : null;

  if (!key && !account) {
    return json(
      {
        error: accountError || keyError || "OpenRouter credit sync failed.",
        keyError,
        accountError,
      },
      502,
    );
  }

  return json({
    provider: "openrouter",
    fetchedAt: new Date().toISOString(),
    key,
    account,
    keyError,
    accountError,
  });
}
