import { isAuthed } from "@/lib/auth";
import { allMemories, forgetMemory, reviseMemory, writeMemory } from "@/lib/memory/store";

export const runtime = "nodejs";

/** The tidy-up screen: everything remembered, so she can read and prune it. */
export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const memories = await allMemories({
    companionId: url.searchParams.get("companionId") ?? undefined,
    includeForgotten: url.searchParams.get("forgotten") === "1",
  });
  return Response.json(memories);
}

/** "Remember this" — her writing a memory directly, rather than them. */
export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json()) as {
    companionId: string;
    body: string;
    scope?: "private" | "shared";
    core?: boolean;
    importance?: number;
  };
  if (!body.companionId || !body.body) {
    return Response.json({ error: "companionId and body required" }, { status: 400 });
  }
  const memory = await writeMemory({
    companionId: body.companionId,
    body: body.body,
    scope: body.scope,
    kind: body.core ? "core" : "episodic",
    importance: body.importance,
    author: "human",
  });
  return Response.json(memory);
}

export async function PATCH(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id, body } = (await req.json()) as { id?: string; body?: string };
  if (!id || !body) return Response.json({ error: "id and body required" }, { status: 400 });
  const memory = await reviseMemory(id, body);
  return memory ? Response.json(memory) : new Response("Not found", { status: 404 });
}

export async function DELETE(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const ok = await forgetMemory(id, "removed from the tidy-up screen");
  return ok ? Response.json({ ok: true }) : new Response("Not found", { status: 404 });
}
