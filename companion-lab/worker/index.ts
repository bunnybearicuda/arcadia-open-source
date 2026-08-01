/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleCompanionApi } from "../lib/companion-api";
import { handleChatApi } from "../lib/chat-api";
import { handleConversationApi, handleFolderApi } from "../lib/conversation-api";
import { handleMemoryApi } from "../lib/memory-api";
import { handleModelApi } from "../lib/model-api";
import { handleNotionApi } from "../lib/notion-api";
import { handleUsageApi } from "../lib/usage-api";
import { handleAttachmentApi } from "../lib/attachment-api";
import { handleMemoryImportApi } from "../lib/memory-intelligence";
import { handleVoiceApi } from "../lib/voice-api";
import { handleProviderCreditApi } from "../lib/provider-credit-api";
import { handleSupabaseMemoryApi } from "../lib/supabase-memory";
import { handleMemoryDedupeApi } from "../lib/memory-dedupe";
import { handlePushApi } from "../lib/push-api";
import { handleCheckInApi } from "../lib/check-in-api";
import { handleConnectorApi } from "../lib/connector-api";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MANAGEMENT_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CHECK_IN_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/companion") {
      return handleCompanionApi(request, env);
    }

    if (url.pathname === "/api/chat") {
      return handleChatApi(request, env, ctx);
    }

    if (url.pathname === "/api/attachments" || url.pathname.startsWith("/api/attachments/")) {
      return handleAttachmentApi(request, env);
    }

    if (url.pathname === "/api/conversations") {
      return handleConversationApi(request, env);
    }

    if (url.pathname === "/api/folders") {
      return handleFolderApi(request, env);
    }

    if (url.pathname === "/api/push") {
      return handlePushApi(request, env);
    }

    if (url.pathname === "/api/check-ins") {
      return handleCheckInApi(request, env);
    }

    if (url.pathname === "/api/connectors") {
      return handleConnectorApi(request, env);
    }

    if (url.pathname === "/api/memory") {
      return handleMemoryApi(request, env);
    }

    if (url.pathname === "/api/memory/import") {
      return handleMemoryImportApi(request, env);
    }

    if (url.pathname === "/api/memory/dedupe") {
      return handleMemoryDedupeApi(request, env);
    }

    if (url.pathname === "/api/notion") {
      return handleNotionApi(request, env);
    }

    if (url.pathname === "/api/usage") {
      return handleUsageApi(request, env);
    }

    if (url.pathname === "/api/provider-credits") {
      return handleProviderCreditApi(request, env);
    }

    if (url.pathname === "/api/supabase-memory") {
      return handleSupabaseMemoryApi(request, env);
    }

    if (url.pathname === "/api/models") {
      return handleModelApi(request, env);
    }

    if (url.pathname === "/api/voice") {
      return handleVoiceApi(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
