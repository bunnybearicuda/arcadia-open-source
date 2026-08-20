import { isAuthed } from "@/lib/auth";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const [{ data: thread }, { data: messages }] = await Promise.all([
    db().from("threads").select("*").eq("id", id).single(),
    db()
      .from("messages")
      .select("id,seq,role,companion_id,content,created_at")
      .eq("thread_id", id)
      .order("seq", { ascending: true })
      .limit(500),
  ]);

  if (!thread) return new Response("Not found", { status: 404 });
  return Response.json({ thread, messages: messages ?? [] });
}

export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const patch = (await req.json()) as Record<string, unknown>;

  const allowed = ["title", "folder_id", "archived", "companion_id"];
  const update = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));

  const { data, error } = await db().from("threads").update(update).eq("id", id).select().single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const { error } = await db().from("threads").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
