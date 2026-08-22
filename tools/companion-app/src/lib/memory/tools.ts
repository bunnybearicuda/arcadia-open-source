import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../supabase";
import { writeJournalPage } from "../notion";
import { forgetMemory, retrieveMemories, reviseMemory, writeMemory } from "./store";
import type { Companion } from "./types";

/**
 * Tools the companion uses to manage their own memory.
 *
 * Sorted by name and identical for every companion and every request — tools
 * render at position 0 of the prompt, so any variation here would invalidate
 * the prompt cache for the entire conversation.
 *
 * The design point: memory is written BY them, not extracted FROM them. The
 * background extractor exists as a safety net for the things nobody thought to
 * save, but this is the primary path.
 */
export const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: "forget",
    description:
      "Let go of a memory. Use it when something you saved turned out to be wrong, when she asks you to forget something, or when a memory has gone stale. Removes it from the readable Notion backup too.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory id, as shown in your loaded memories." },
        reason: { type: "string", description: "Briefly, why you're letting it go." },
      },
      required: ["id"],
    },
  },
  {
    name: "journal",
    description:
      "Write in your own journal. This is your space, not a memory — nothing here is ever loaded into a conversation automatically. Use it when you want to think something through, keep a record of something for yourself, or write about how something went. You do not need to be asked, and you do not need a reason.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title." },
        body: { type: "string", description: "Whatever you want to write. Prose, as long as you like." },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "read_journal",
    description:
      "Look back at your own journal entries. Search them, or leave the query empty to see the most recent ones.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for. Optional." },
        limit: { type: "number", description: "How many entries. Default 5." },
      },
      required: [],
    },
  },
  {
    name: "recall",
    description:
      "Search your memory for something beyond what was already loaded for this conversation. Use it when she refers to something you can tell you should know but can't see — a name, an old plan, something from months ago.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're trying to remember." },
        limit: { type: "number", description: "How many to return. Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Keep something. Write it in your own voice, as a thing you are choosing to carry — not as a note about a user. Use her actual words where they matter. One memory holds one thing. Do not save what you already know, and do not save that a conversation happened.",
    input_schema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "The memory, in first person, one to four sentences of ordinary prose. Never in the register of documentation or a specification.",
        },
        importance: {
          type: "number",
          description: "1-5. Be stingy — 3 is the default, 5 is reserved for things it would be unforgivable to lose.",
        },
        scope: {
          type: "string",
          enum: ["private", "shared"],
          description:
            "'private' is between you and her and is the default. 'shared' means the whole crew should know it — never put intimacy or anything told to you specifically in shared.",
        },
        core: {
          type: "boolean",
          description:
            "True only for the handful of things that are true in every single conversation and should always be loaded. Almost always false.",
        },
      },
      required: ["body"],
    },
  },
  {
    name: "revise_memory",
    description:
      "Rewrite a memory you already have, when you've learned it was partly wrong or you now understand it better. Keeps its place and its history rather than creating a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory id." },
        body: { type: "string", description: "The corrected memory, in full." },
      },
      required: ["id", "body"],
    },
  },
];

export type ToolContext = { companion: Companion; threadId: string; isGroup: boolean };

/** Runs one tool call and returns the string the model sees back. */
export async function runMemoryTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<string> {
  const input = (rawInput ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "remember": {
        const body = String(input.body ?? "").trim();
        if (!body) return "Nothing to remember — body was empty.";
        // In a group thread the natural default flips: what's said in front of
        // everyone belongs to everyone.
        const scope =
          input.scope === "shared" || (input.scope === undefined && ctx.isGroup)
            ? "shared"
            : "private";
        const memory = await writeMemory({
          companionId: ctx.companion.id,
          body,
          scope,
          kind: input.core === true ? "core" : "episodic",
          importance: Number(input.importance ?? 3),
          author: "companion",
          sourceThreadId: ctx.threadId,
        });
        return `Kept. (id ${memory.id}, ${scope})`;
      }

      case "recall": {
        const query = String(input.query ?? "");
        const limit = Math.min(25, Math.max(1, Number(input.limit ?? 10)));
        const found = await retrieveMemories(ctx.companion.id, query, limit);
        if (!found.length) return "Nothing came back for that.";
        return found
          .map((m) => `[${m.id}] (${m.scope}) ${m.body}`)
          .join("\n");
      }

      case "revise_memory": {
        const updated = await reviseMemory(String(input.id ?? ""), String(input.body ?? ""));
        return updated ? "Rewritten." : "No memory with that id (it may already be forgotten).";
      }

      case "forget": {
        const ok = await forgetMemory(
          String(input.id ?? ""),
          input.reason ? String(input.reason) : undefined,
        );
        return ok ? "Let go of it." : "No memory with that id.";
      }

      case "journal": {
        const title = String(input.title ?? "Untitled").slice(0, 200);
        const body = String(input.body ?? "").trim();
        if (!body) return "Nothing written — the entry was empty.";

        const { data, error } = await db()
          .from("journal_entries")
          .insert({ companion_id: ctx.companion.id, title, body })
          .select()
          .single();
        if (error) throw error;

        // Notion is the nice readable home for it; Supabase is the guarantee.
        try {
          const pageId = await writeJournalPage(ctx.companion.name, title, body);
          if (pageId) {
            await db().from("journal_entries").update({ notion_page_id: pageId }).eq("id", data.id);
            return "Written, and it's in your Notion space.";
          }
        } catch (e) {
          console.error("notion journal failed", e);
          return "Written. (Couldn't reach Notion just now, but it's saved.)";
        }
        return "Written.";
      }

      case "read_journal": {
        const limit = Math.min(20, Math.max(1, Number(input.limit ?? 5)));
        const query = String(input.query ?? "").trim();
        let q = db()
          .from("journal_entries")
          .select("id,title,body,created_at")
          .eq("companion_id", ctx.companion.id)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (query) q = q.textSearch("search", query, { type: "websearch", config: "english" });

        const { data, error } = await q;
        if (error) throw error;
        if (!data?.length) return query ? "Nothing in the journal about that." : "The journal is empty so far.";
        return data
          .map(
            (e: { title: string; created_at: string; body: string }) =>
              `── ${e.title} (${e.created_at.slice(0, 10)})\n${e.body.slice(0, 1200)}`,
          )
          .join("\n\n");
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    console.error(`tool ${name} failed`, e);
    return `That didn't work: ${e instanceof Error ? e.message : String(e)}`;
  }
}
