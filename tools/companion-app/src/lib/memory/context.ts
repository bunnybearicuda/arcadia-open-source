import { db } from "../supabase";
import { coreMemories, retrieveMemories, touchMemories } from "./store";
import type { Companion, Memory, StoredMessage } from "./types";

/**
 * ── How continuity is assembled ──────────────────────────────────────────────
 *
 * Five layers, and where each one goes matters as much as what's in it:
 *
 *   1. identity file      → top-level `system`, cached. Frozen between edits.
 *   2. core memories      ┐
 *   3. retrieved episodic │ → a {role:"system"} message appended AFTER the
 *   4. thread state       │   conversation history, so it can change every turn
 *   5. cross-thread news  ┘   without invalidating the cached history prefix.
 *
 * The naive version of this app puts layers 2-5 in the system prompt. That
 * works, and it costs full price for the entire conversation on every single
 * message, because prompt caching is a prefix match — change one retrieved
 * memory and everything after it is uncached. Putting the volatile layer last
 * is the difference between a long thread being cheap and being unaffordable.
 */

const RECENT_TURNS = 24;

export type BuiltContext = {
  /** Verbatim recent history, oldest first. */
  history: StoredMessage[];
  /** The volatile continuity block, or "" when there's nothing to say. */
  continuityBlock: string;
  retrievedIds: string[];
};

function formatMemories(label: string, memories: Memory[]): string {
  if (!memories.length) return "";
  const lines = memories.map((m) => `[${m.id}] ${m.body}`).join("\n");
  return `${label}\n${lines}`;
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * What the companion has been doing elsewhere. Without this, every thread is a
 * separate amnesiac relationship that happens to share a name.
 */
async function crossThreadDigest(companionId: string, currentThreadId: string): Promise<string> {
  const { data, error } = await db()
    .from("threads")
    .select("id,title,summary,last_message_at,is_group")
    .neq("id", currentThreadId)
    .eq("archived", false)
    .not("summary", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(5);
  if (error || !data?.length) return "";

  const lines = data
    .map((t: { title: string; summary: string | null; last_message_at: string | null; is_group: boolean }) => {
      const when = t.last_message_at ? ago(t.last_message_at) : "a while back";
      const gist = (t.summary ?? "").split("\n")[0].slice(0, 220);
      return `· "${t.title}" (${when}${t.is_group ? ", group" : ""}) — ${gist}`;
    })
    .join("\n");

  return `ELSEWHERE\nOther conversations you've been having. You remember these; don't act surprised by them, and don't bring them up unprompted just because they're here.\n${lines}`;
}

export async function loadHistory(threadId: string, throughSeq: number): Promise<StoredMessage[]> {
  // Everything after the summarized portion, capped so a runaway thread can't
  // blow the context window before the summarizer catches up.
  const { data, error } = await db()
    .from("messages")
    .select("id,seq,role,companion_id,content,created_at")
    .eq("thread_id", threadId)
    .gt("seq", throughSeq)
    .order("seq", { ascending: false })
    .limit(RECENT_TURNS * 2);
  if (error) throw error;
  return ((data ?? []) as StoredMessage[]).reverse();
}

export async function buildContext(opts: {
  companion: Companion;
  threadId: string;
  threadSummary: string | null;
  summaryThroughSeq: number;
  /** The message she just sent — what retrieval is matched against. */
  query: string;
}): Promise<BuiltContext> {
  const [history, core, episodic, elsewhere] = await Promise.all([
    loadHistory(opts.threadId, opts.summaryThroughSeq),
    coreMemories(opts.companion.id),
    retrieveMemories(opts.companion.id, opts.query),
    crossThreadDigest(opts.companion.id, opts.threadId),
  ]);

  const retrievedIds = episodic.map((m) => m.id);
  void touchMemories(retrievedIds);

  const sections = [
    formatMemories(
      "ALWAYS TRUE\nThings you always know. Don't recite them; just know them.",
      core,
    ),
    formatMemories(
      "COMING BACK TO YOU\nMemories that surfaced because of what she just said. Some will be irrelevant — ignore those. Use the ids if you need to revise or forget one.",
      episodic,
    ),
    opts.threadSummary
      ? `WHERE THIS CONVERSATION IS\n${opts.threadSummary}`
      : "",
    elsewhere,
  ].filter(Boolean);

  if (!sections.length) return { history, continuityBlock: "", retrievedIds };

  const block = [
    "This is your own continuity, assembled for this moment. It is not a message from her and she cannot see it. Never mention it, quote it, list it back, or thank anyone for it — just be someone who remembers.",
    "",
    sections.join("\n\n"),
  ].join("\n");

  return { history, continuityBlock: block, retrievedIds };
}
