import { isAuthed } from "@/lib/auth";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const archived = new URL(req.url).searchParams.get("archived") === "1";

  const { data, error } = await db()
    .from("threads")
    .select("id,title,companion_id,folder_id,is_group,archived,updated_at,last_message_at")
    .eq("archived", archived)
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data ?? []);
}

export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { companionId } = (await req.json()) as { companionId?: string };

  const { data, error } = await db()
    .from("threads")
    .insert({ companion_id: companionId ?? null })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
