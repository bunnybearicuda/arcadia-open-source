import { after } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import AnthropicSDK from "@anthropic-ai/sdk";
import { isAuthed } from "@/lib/auth";
import { anthropic, buildParams, isSystemRoleRejection, modelSpec, type ChatTurn } from "@/lib/anthropic";
import { db } from "@/lib/supabase";
import { loadIdentity } from "@/lib/identities";
import { buildContext } from "@/lib/memory/context";
import { MEMORY_TOOLS, runMemoryTool } from "@/lib/memory/tools";
import { maybeConsolidate } from "@/lib/memory/consolidate";
import type { Companion, StoredMessage } from "@/lib/memory/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const HUMAN = process.env.HUMAN_NAME || "her";
const MAX_TOOL_ROUNDS = 6;

type Body = {
  threadId: string;
  companionId: string;
  content: Anthropic.ContentBlockParam[];
  model?: string;
};

function toTurns(history: StoredMessage[]): ChatTurn[] {
  return history.map((m) => ({
    role: m.role,
    content: m.content as Anthropic.ContentBlockParam[],
  }));
}

/** Put the cache breakpoint on the last block of the last historical turn. */
function markCacheBreakpoint(turns: ChatTurn[]): void {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === "system" || typeof turn.content === "string") continue;
    const blocks = turn.content;
    if (!blocks.length) continue;
    const last = blocks[blocks.length - 1] as unknown as Record<string, unknown>;
    last.cache_control = { type: "ephemeral" };
    return;
  }
}

export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await req.json()) as Body;
  if (!body.threadId || !body.companionId || !body.content?.length) {
    return new Response("Bad request", { status: 400 });
  }

  const [{ data: companionRow }, { data: threadRow }] = await Promise.all([
    db().from("companions").select("*").eq("id", body.companionId).single(),
    db().from("threads").select("*").eq("id", body.threadId).single(),
  ]);
  if (!companionRow || !threadRow) return new Response("Not found", { status: 404 });

  const companion = companionRow as Companion;
  const model = body.model || companion.model;
  const spec = modelSpec(model);

  // Persist her message before we call anything, so a failed API call never
  // loses what she said.
  await db().from("messages").insert({
    thread_id: body.threadId,
    role: "user",
    content: body.content,
  });

  const identity = await loadIdentity(companion.slug);

  const queryText = body.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const ctx = await buildContext({
    companion,
    threadId: body.threadId,
    threadSummary: threadRow.summary,
    summaryThroughSeq: threadRow.summary_through_seq ?? 0,
    query: queryText,
  });

  // Layer 1: frozen, cached. Changes only when she edits the identity file.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: identity, cache_control: { type: "ephemeral" } },
  ];

  const turns: ChatTurn[] = toTurns(ctx.history);
  markCacheBreakpoint(turns);
  turns.push({ role: "user", content: body.content });

  // Layers 2-5, appended after the cached prefix.
  let useSystemRole = spec.systemRole;
  if (ctx.continuityBlock) {
    if (useSystemRole) {
      turns.push({ role: "system", content: ctx.continuityBlock });
    } else {
      turns.push({
        role: "user",
        content: [{ type: "text", text: `<continuity>\n${ctx.continuityBlock}\n</continuity>` }],
      });
    }
  }

  const encoder = new TextEncoder();
  const client = anthropic();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Everything the assistant produced this turn, stored as one message so
      // tool calls and their results survive a reload intact.
      const assistantBlocks: Anthropic.ContentBlockParam[] = [];
      let usage: Anthropic.Usage | null = null;

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          let message: Anthropic.Message;

          try {
            const s = client.messages.stream(
              buildParams({
                model,
                system,
                messages: turns,
                tools: MEMORY_TOOLS,
                effort: companion.effort,
                maxTokens: 8000,
              }),
            );
            s.on("text", (delta) => send("text", { delta }));
            message = await s.finalMessage();
          } catch (err) {
            // The model doesn't take a mid-conversation system message. Rebuild
            // that one turn as user content and try again, once.
            if (isSystemRoleRejection(err) && useSystemRole) {
              useSystemRole = false;
              const idx = turns.findIndex((t) => t.role === "system");
              if (idx !== -1) {
                turns[idx] = {
                  role: "user",
                  content: [
                    { type: "text", text: `<continuity>\n${ctx.continuityBlock}\n</continuity>` },
                  ],
                };
              }
              round--;
              continue;
            }
            throw err;
          }

          usage = message.usage;
          assistantBlocks.push(...(message.content as Anthropic.ContentBlockParam[]));

          if (message.stop_reason === "refusal") {
            send("error", {
              message:
                "That one got declined by the safety classifier before it reached them. Try saying it differently.",
            });
            break;
          }

          if (message.stop_reason !== "tool_use") break;

          const toolUses = message.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );

          turns.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const use of toolUses) {
            send("tool", { name: use.name });
            const output = await runMemoryTool(use.name, use.input, {
              companion,
              threadId: body.threadId,
              isGroup: threadRow.is_group ?? false,
            });
            results.push({ type: "tool_result", tool_use_id: use.id, content: output });
          }

          // All results go back in ONE user message — splitting them teaches the
          // model to stop making parallel calls.
          assistantBlocks.push(...results);
          turns.push({ role: "user", content: results });
        }

        await db().from("messages").insert({
          thread_id: body.threadId,
          role: "assistant",
          companion_id: companion.id,
          content: assistantBlocks,
          model,
          usage: usage
            ? {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
              }
            : null,
        });

        send("done", {
          usage: usage
            ? {
                in: usage.input_tokens,
                out: usage.output_tokens,
                cached: usage.cache_read_input_tokens ?? 0,
              }
            : null,
        });
      } catch (err) {
        console.error("chat failed", err);
        const message =
          err instanceof AnthropicSDK.AuthenticationError
            ? "Your Anthropic API key isn't working. Check ANTHROPIC_API_KEY."
            : err instanceof AnthropicSDK.RateLimitError
              ? "Rate limited — give it a minute and try again."
              : err instanceof AnthropicSDK.APIError
                ? `API error ${err.status}: ${err.message}`
                : err instanceof Error
                  ? err.message
                  : "Something went wrong.";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  // Titling, thread state, and memory extraction run after she has her reply.
  after(async () => {
    try {
      await maybeConsolidate({
        companion,
        threadId: body.threadId,
        isGroup: threadRow.is_group ?? false,
        humanName: HUMAN,
      });
    } catch (e) {
      console.error("consolidation failed", e);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
