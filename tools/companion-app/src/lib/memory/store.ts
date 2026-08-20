import { db } from "../supabase";
import type { Memory, MemoryScope } from "./types";
import { mirrorMemory, unmirrorMemory } from "../notion";

export async function coreMemories(companionId: string): Promise<Memory[]> {
  const { data, error } = await db()
    .from("memories")
    .select("*")
    .eq("kind", "core")
    .is("forgotten_at", null)
    .or(`scope.eq.shared,and(scope.eq.private,companion_id.eq.${companionId})`)
    .order("importance", { ascending: false })
    .limit(40);
  if (error) throw error;
  return (data ?? []) as Memory[];
}

/**
 * Relevance-ranked episodic memories. Scoring happens in Postgres
 * (see search_memories in supabase/schema.sql) so this is one round trip.
 */
export async function retrieveMemories(
  companionId: string,
  query: string,
  limit = 12,
): Promise<Memory[]> {
  const { data, error } = await db().rpc("search_memories", {
    p_companion_id: companionId,
    p_query: query.slice(0, 2000),
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as Memory[];
}

/** Record that these memories were actually used, so warm ones stay warm. */
export async function touchMemories(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await db().rpc("touch_memories", { p_ids: ids });
  if (error) console.error("touch_memories failed", error);
}

export async function writeMemory(input: {
  companionId: string;
  body: string;
  scope?: MemoryScope;
  kind?: "core" | "episodic";
  importance?: number;
  author?: "companion" | "human" | "extractor";
  sourceThreadId?: string | null;
}): Promise<Memory> {
  const scope = input.scope ?? "private";
  const body = input.body.trim();

  // Don't store the same memory twice in different words. An extractor told not
  // to re-remember things will still do it, and a hundred near-identical "she
  // was tired again" rows crowd out everything else — the companion ends up
  // sounding like they only know one thing about her.
  const { data: dupeId } = await db().rpc("similar_memory_id", {
    p_companion_id: input.companionId,
    p_scope: scope,
    p_body: body,
  });
  if (dupeId) {
    const { data: existing } = await db()
      .from("memories")
      .select("*")
      .eq("id", dupeId as string)
      .single();
    if (existing) return existing as Memory;
  }

  const row = {
    body,
    scope,
    kind: input.kind ?? "episodic",
    // A shared memory belongs to the crew, not to one companion.
    companion_id: scope === "shared" ? null : input.companionId,
    importance: Math.min(5, Math.max(1, input.importance ?? 3)),
    author: input.author ?? "companion",
    source_thread_id: input.sourceThreadId ?? null,
  };

  const { data, error } = await db().from("memories").insert(row).select().single();
  if (error) throw error;

  const memory = data as Memory;
  // Notion is a mirror, never the source of truth. If it fails, the memory
  // still exists; we just lost the readable copy for now.
  void mirrorMemory(memory).catch((e) => console.error("notion mirror failed", e));
  return memory;
}

export async function reviseMemory(id: string, body: string): Promise<Memory | null> {
  const { data, error } = await db()
    .from("memories")
    .update({ body: body.trim(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("forgotten_at", null)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const memory = data as Memory;
  void mirrorMemory(memory).catch((e) => console.error("notion mirror failed", e));
  return memory;
}

/**
 * Soft delete. The row stays for a while so a mistaken forget is recoverable,
 * but it is removed from Notion immediately — when she says forget it, the
 * readable copy should not still be sitting there.
 */
export async function forgetMemory(id: string, reason?: string): Promise<boolean> {
  const { data, error } = await db()
    .from("memories")
    .update({ forgotten_at: new Date().toISOString(), forgotten_reason: reason ?? null })
    .eq("id", id)
    .is("forgotten_at", null)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  void unmirrorMemory(data as Memory).catch((e) => console.error("notion unmirror failed", e));
  return true;
}

/** Everything remembered, for the tidy-up screen. */
export async function allMemories(opts: {
  companionId?: string;
  includeForgotten?: boolean;
}): Promise<Memory[]> {
  let q = db().from("memories").select("*").order("created_at", { ascending: false });
  if (!opts.includeForgotten) q = q.is("forgotten_at", null);
  if (opts.companionId) {
    q = q.or(`scope.eq.shared,and(scope.eq.private,companion_id.eq.${opts.companionId})`);
  }
  const { data, error } = await q.limit(1000);
  if (error) throw error;
  return (data ?? []) as Memory[];
}
