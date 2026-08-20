import { isAuthed } from "@/lib/auth";
import { db } from "@/lib/supabase";
import { listIdentityFiles } from "@/lib/identities";

export const runtime = "nodejs";

export async function GET() {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const { data, error } = await db()
    .from("companions")
    .select("*")
    .eq("archived", false)
    .order("sort_order")
    .order("name");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Surface identity files that have no row yet, so adding a companion is:
  // drop in the .md, click the name.
  const files = await listIdentityFiles();
  const known = new Set((data ?? []).map((c: { slug: string }) => c.slug));
  const unregistered = files.filter((f) => !known.has(f) && f !== "_example");

  return Response.json({ companions: data ?? [], unregistered });
}

export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { slug, name } = (await req.json()) as { slug?: string; name?: string };
  if (!slug || !name) return Response.json({ error: "slug and name required" }, { status: 400 });

  const { data, error } = await db()
    .from("companions")
    .insert({ slug, name })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function PATCH(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id, ...patch } = (await req.json()) as { id?: string } & Record<string, unknown>;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const allowed = ["name", "model", "effort", "accent", "voice_id", "sort_order", "archived"];
  const update = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));

  const { data, error } = await db().from("companions").update(update).eq("id", id).select().single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
