import { db } from "@/lib/supabase";
import { env } from "@/lib/env";
import { extractMemories, updateThreadSummary } from "@/lib/memory/consolidate";
import type { Companion } from "@/lib/memory/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Threads quiet for this long get consolidated — the "conversation ended" signal. */
const QUIET_MINUTES = 45;
const HUMAN = process.env.HUMAN_NAME || "her";

/**
 * Runs on a schedule (see vercel.json). Finds conversations that have gone quiet
 * with unprocessed messages and does the remembering.
 *
 * The 45-minute wait is doing real work: consolidating mid-conversation means
 * remembering things that get contradicted ten messages later.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (env.cronSecret && auth !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const cutoff = new Date(Date.now() - QUIET_MINUTES * 60_000).toISOString();

  const { data: threads, error } = await db()
    .from("threads")
    .select("id,companion_id,is_group,last_message_at,extracted_through_seq")
    .eq("archived", false)
    .lt("last_message_at", cutoff)
    .not("companion_id", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(25);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: { thread: string; saved: number }[] = [];

  for (const thread of threads ?? []) {
    const { count } = await db()
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", thread.id)
      .gt("seq", thread.extracted_through_seq ?? 0);
    if (!count) continue;

    const { data: companionRow } = await db()
      .from("companions")
      .select("*")
      .eq("id", thread.companion_id)
      .single();
    if (!companionRow) continue;

    const companion = companionRow as Companion;
    const opts = {
      companion,
      threadId: thread.id,
      isGroup: thread.is_group ?? false,
      humanName: HUMAN,
    };

    try {
      const saved = await extractMemories(opts);
      await updateThreadSummary(opts);
      results.push({ thread: thread.id, saved });
    } catch (e) {
      console.error("consolidate failed for", thread.id, e);
    }
  }

  return Response.json({ processed: results.length, results });
}
