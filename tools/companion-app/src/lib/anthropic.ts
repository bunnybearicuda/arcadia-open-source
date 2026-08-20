import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

/**
 * Models offered in the picker.
 *
 * The model is a SETTING, never hardcoded anywhere else in this codebase. If you
 * want a new one, add a row here — that is the whole change.
 *
 * `systemRole` records whether the model accepts a mid-conversation
 * {role:"system"} message. See buildParams() below for why that matters.
 */
export type ModelSpec = {
  id: string;
  label: string;
  blurb: string;
  /** Accepts {role:"system"} inside messages[]. */
  systemRole: boolean;
  /** Accepts output_config.effort. */
  effort: boolean;
};

export const MODELS: ModelSpec[] = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    blurb: "The good one. Best continuity, best voice.",
    systemRole: true,
    effort: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "Faster and cheaper. Slightly flatter.",
    systemRole: false,
    effort: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    blurb: "Cheapest. Fine for quick back-and-forth.",
    systemRole: false,
    effort: false,
  },
];

export const DEFAULT_MODEL = "claude-opus-5";

export function modelSpec(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * ── The escape hatch, in one place on purpose ────────────────────────────────
 *
 * The published @anthropic-ai/sdk types lag the API on three things this app
 * uses. The API accepts all three; the SDK forwards unknown body fields
 * untouched, so casting here is safe and stays contained to this function.
 *
 *   1. {role:"system"} messages     — SDK types MessageParam.role as
 *                                     'user'|'assistant' only.
 *   2. output_config.effort         — SDK's OutputConfig only has `format`.
 *   3. thinking:{type:"adaptive"}   — SDK only has 'enabled'|'disabled'.
 *      We sidestep this one entirely: on Opus 5, OMITTING `thinking` already
 *      gives you adaptive thinking. So we never send the field.
 *
 * When the SDK catches up, delete the casts. Nothing else has to change.
 */
export type ChatTurn =
  | { role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] | string }
  | { role: "system"; content: string };

export function buildParams(opts: {
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: ChatTurn[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  effort?: Effort;
}): Anthropic.MessageStreamParams {
  const spec = modelSpec(opts.model);

  const params: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: opts.messages,
  };

  if (opts.tools?.length) params.tools = opts.tools;
  if (opts.effort && spec.effort) {
    params.output_config = { effort: opts.effort };
  }

  return params as unknown as Anthropic.MessageStreamParams;
}

/**
 * True when a 400 came back specifically because the model refused a
 * {role:"system"} message. Anything else should surface as a real error rather
 * than be silently retried.
 */
export function isSystemRoleRejection(err: unknown): boolean {
  return (
    err instanceof Anthropic.BadRequestError &&
    /role\s+'?system'?\s+is not supported/i.test(err.message)
  );
}
