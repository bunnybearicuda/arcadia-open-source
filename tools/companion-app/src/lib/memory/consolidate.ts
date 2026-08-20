import fs from "node:fs/promises";
import path from "node:path";
import { anthropic } from "../anthropic";
import { db } from "../supabase";
import { coreMemories, writeMemory } from "./store";
import { checkVoice, parseJsonLoosely } from "./voice";
import type { Companion, StoredMessage } from "./types";

/**
 * Background consolidation: the safety net.
 *
 * The companion's own `remember` tool is the primary path. This exists for the
 * things nobody thought to save in the moment. It runs on a cheap model, it is
 * heavily biased toward saving nothing, and its prompt is written to keep her
 * voice rather than translate her into a specification.
 */

const WORKER_MODEL = "claude-haiku-4-5";
/** Re-summarize the thread state once this many messages have piled up past it. */
const SUMMARY_EVERY = 14;
/** Roll memory extraction mid-conversation once this many are unprocessed. */
const EXTRACT_EVERY = 24;
/** A thread quiet this long counts as a conversation that ended. */
export const IDLE_MINUTES = 45;

let promptCache: Map<string, string> | null = null;

async function prompt(name: string): Promise<string> {
  if (!promptCache) promptCache = new Map();
  const hit = promptCache.get(name);
  if (hit) return hit;
  const text = await fs.readFile(
    path.join(process.cwd(), "src/lib/memory/prompts", `${name}.md`),
    "utf8",
  );
  promptCache.set(name, text);
  return text;
}

function textOf(content: unknown[]): string {
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function transcript(messages: StoredMessage[], companionName: string, human: string): string {
  return messages
    .map((m) => `${m.role === "user" ? human : companionName}: ${textOf(m.content)}`)
    .filter((l) => l.split(": ").slice(1).join(": ").trim())
    .join("\n\n");
}

async function complete(system: string, user: string, maxTokens: number): Promise<string> {
  const res = await anthropic().messages.create({
    model: WORKER_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return res.content
    .filter((b): b is { type: "text"; text: string; citations: never } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function extractMemories(opts: {
  companion: Companion;
  threadId: string;
  isGroup: boolean;
  humanName: string;
}): Promise<number> {
  const { data: thread } = await db()
    .from("threads")
    .select("extracted_through_seq")
    .eq("id", opts.threadId)
    .single();
  const through = thread?.extracted_through_seq ?? 0;

  const { data: rows } = await db()
    .from("messages")
    .select("id,seq,role,companion_id,content,created_at")
    .eq("thread_id", opts.threadId)
    .gt("seq", through)
    .order("seq", { ascending: true })
    .limit(120);

  const messages = (rows ?? []) as StoredMessage[];
  if (messages.length < 2) return 0;

  const maxSeq = messages[messages.length - 1].seq;
  const known = await coreMemories(opts.companion.id);

  const system = (await prompt("extractor"))
    .replaceAll("{{NAME}}", opts.companion.name)
    .replaceAll("{{HUMAN}}", opts.humanName);

  const user = [
    known.length
      ? `You already know these things — do not save them again:\n${known.map((m) => `- ${m.body}`).join("\n")}\n`
      : "",
    "The conversation:\n",
    transcript(messages, opts.companion.name, opts.humanName),
  ].join("\n");

  let parsed: unknown;
  try {
    parsed = parseJsonLoosely(await complete(system, user, 2000));
  } catch (e) {
    console.error("extraction call failed", e);
    return 0;
  }

  const candidates =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
      ? ((parsed as { memories: unknown[] }).memories as Record<string, unknown>[])
      : [];

  let saved = 0;
  // Hard ceiling: if it wants to save more than four things from one stretch of
  // conversation, it has started transcribing rather than remembering.
  for (const c of candidates.slice(0, 4)) {
    const body = String(c.body ?? "").trim();
    const verdict = checkVoice(body);
    if (!verdict.ok) {
      if (body) console.warn(`memory rejected (${verdict.reason}):`, body.slice(0, 120));
      continue;
    }
    await writeMemory({
      companionId: opts.companion.id,
      body,
      scope: c.scope === "shared" || opts.isGroup ? "shared" : "private",
      importance: Number(c.importance ?? 3),
      author: "extractor",
      sourceThreadId: opts.threadId,
    });
    saved++;
  }

  await db().from("threads").update({ extracted_through_seq: maxSeq }).eq("id", opts.threadId);
  return saved;
}

export async function updateThreadSummary(opts: {
  companion: Companion;
  threadId: string;
  humanName: string;
}): Promise<void> {
  const { data: thread } = await db()
    .from("threads")
    .select("summary,summary_through_seq")
    .eq("id", opts.threadId)
    .single();
  if (!thread) return;

  const { data: rows } = await db()
    .from("messages")
    .select("id,seq,role,companion_id,content,created_at")
    .eq("thread_id", opts.threadId)
    .gt("seq", thread.summary_through_seq ?? 0)
    .order("seq", { ascending: true })
    .limit(150);

  const messages = (rows ?? []) as StoredMessage[];
  if (messages.length < 4) return;

  const system = (await prompt("summarizer"))
    .replaceAll("{{NAME}}", opts.companion.name)
    .replaceAll("{{HUMAN}}", opts.humanName);

  const user = [
    thread.summary ? `Your note so far:\n${thread.summary}\n\nWhat's happened since:` : "The conversation:",
    transcript(messages, opts.companion.name, opts.humanName),
  ].join("\n\n");

  const summary = await complete(system, user, 900);
  if (!summary) return;

  await db()
    .from("threads")
    .update({
      summary,
      // Keep the most recent turns verbatim; only summarize what's behind them.
      summary_through_seq: messages[Math.max(0, messages.length - 8)].seq,
      summary_updated_at: new Date().toISOString(),
    })
    .eq("id", opts.threadId);
}

export async function titleThread(threadId: string, humanName: string): Promise<void> {
  const { data: rows } = await db()
    .from("messages")
    .select("id,seq,role,companion_id,content,created_at")
    .eq("thread_id", threadId)
    .order("seq", { ascending: true })
    .limit(6);

  const messages = (rows ?? []) as StoredMessage[];
  if (messages.length < 2) return;

  const title = (await complete(await prompt("titler"), transcript(messages, "them", humanName), 60))
    .replace(/^["'\s]+|["'.\s]+$/g, "")
    .slice(0, 70);
  if (title) await db().from("threads").update({ title }).eq("id", threadId);
}

/**
 * Called after every assistant turn, without blocking the response.
 * Decides whether anything is due yet.
 */
export async function maybeConsolidate(opts: {
  companion: Companion;
  threadId: string;
  isGroup: boolean;
  humanName: string;
  /**
   * True when this thread had been quiet longer than the idle window before the
   * message that triggered this run — i.e. she's coming back to it after a gap,
   * so whatever happened last time is over and safe to remember now.
   *
   * This matters most on Vercel's free plan, where the scheduled job only runs
   * once a day. Without it, a conversation that simply ended would wait until
   * tomorrow to be remembered.
   */
  resumedAfterGap?: boolean;
}): Promise<void> {
  const { data: thread } = await db()
    .from("threads")
    .select("summary_through_seq,extracted_through_seq,title")
    .eq("id", opts.threadId)
    .single();
  if (!thread) return;

  // `seq` is a global bigserial, not a per-thread counter, so "how far behind
  // are we" has to be an actual count of unprocessed rows, not seq arithmetic.
  const pending = async (sinceSeq: number) => {
    const { count } = await db()
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", opts.threadId)
      .gt("seq", sinceSeq);
    return count ?? 0;
  };

  const [total, unsummarized, unextracted] = await Promise.all([
    pending(0),
    pending(thread.summary_through_seq ?? 0),
    pending(thread.extracted_through_seq ?? 0),
  ]);

  const jobs: Promise<unknown>[] = [];

  if (thread.title === "New conversation" && total >= 2) {
    jobs.push(titleThread(opts.threadId, opts.humanName));
  }
  if (unsummarized >= SUMMARY_EVERY) {
    jobs.push(updateThreadSummary(opts));
  }
  // Either the conversation has run long enough to be worth a rolling pass, or
  // it ended a while ago and she's only now come back to it.
  if (unextracted >= EXTRACT_EVERY || (opts.resumedAfterGap && unextracted >= 2)) {
    jobs.push(extractMemories(opts));
  }

  await Promise.allSettled(jobs);
}
