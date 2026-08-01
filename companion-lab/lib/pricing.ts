export type Provider = "anthropic" | "openai" | "openrouter";

export type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
};

const EXACT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-5": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheWritePerMillion: 6.25,
    cacheReadPerMillion: 0.5,
  },
  "claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheWritePerMillion: 1.25,
    cacheReadPerMillion: 0.1,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "claude-sonnet-4": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.1 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075 },
};

export function modelPrice(provider: Provider, model: string): ModelPrice | null {
  const exact = EXACT_PRICES[model];
  if (exact) return exact;

  const normalized = model.toLocaleLowerCase();
  if (provider === "anthropic") {
    if (normalized.includes("haiku-4-5")) {
      return {
        inputPerMillion: 1,
        outputPerMillion: 5,
        cacheWritePerMillion: 1.25,
        cacheReadPerMillion: 0.1,
      };
    }
    if (normalized.includes("opus-4-5")) {
      return {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheWritePerMillion: 6.25,
        cacheReadPerMillion: 0.5,
      };
    }
    if (normalized.includes("sonnet-4")) {
      return {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheWritePerMillion: 3.75,
        cacheReadPerMillion: 0.3,
      };
    }
  }

  if (provider === "openai") {
    if (normalized.startsWith("gpt-4.1-nano")) {
      return { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 };
    }
    if (normalized.startsWith("gpt-4.1-mini")) {
      return { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheReadPerMillion: 0.1 };
    }
    if (normalized.startsWith("gpt-4.1")) {
      return { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 };
    }
    if (normalized.startsWith("gpt-4o-mini")) {
      return { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075 };
    }
    if (normalized.startsWith("gpt-4o")) {
      return { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 };
    }
  }

  return null;
}

export function estimateCost(
  provider: Provider,
  model: string,
  inputTokens = 0,
  outputTokens = 0,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
) {
  const price = modelPrice(provider, model);
  if (!price) return null;
  return (
    (Math.max(0, inputTokens) * price.inputPerMillion +
      Math.max(0, outputTokens) * price.outputPerMillion +
      Math.max(0, cacheWriteTokens) *
        (price.cacheWritePerMillion ?? price.inputPerMillion) +
      Math.max(0, cacheReadTokens) *
        (price.cacheReadPerMillion ?? price.inputPerMillion)) /
    1_000_000
  );
}
