import { isAuthed } from "@/lib/auth";
import { db } from "@/lib/supabase";
import { listIdentityFiles, readIdentityFile, slugify } from "@/lib/identities";

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

  const companions = data ?? [];

  // Tell the UI where each personality is coming from, so the editor can say
  // "this one lives in a file" instead of silently letting her edit a copy
  // that will never be used.
  const withSource = await Promise.all(
    companions.map(async (c: { slug: string; identity: string | null }) => ({
      ...c,
      identity_source: (await readIdentityFile(c.slug)) ? "file" : c.identity ? "app" : "none",
    })),
  );

  // Identity files with no row yet — one click to bring them in.
  const files = await listIdentityFiles();
  const known = new Set(companions.map((c: { slug: string }) => c.slug));
  const unregistered = files.filter((f) => !known.has(f) && f !== "_example");

  return Response.json({ companions: withSource, unregistered });
}

export async function POST(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { name, slug, identity } = (await req.json()) as {
    name?: string;
    slug?: string;
    identity?: string;
  };
  if (!name?.trim()) return Response.json({ error: "name required" }, { status: 400 });

  const finalSlug = slug?.trim() || slugify(name);

  const { data, error } = await db()
    .from("companions")
    .insert({ slug: finalSlug, name: name.trim(), identity: identity?.trim() || null })
    .select()
    .single();

  if (error) {
    const message = error.code === "23505" ? `There's already someone called "${finalSlug}".` : error.message;
    return Response.json({ error: message }, { status: 400 });
  }
  return Response.json(data);
}

export async function PATCH(req: Request) {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });
  const { id, ...patch } = (await req.json()) as { id?: string } & Record<string, unknown>;
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const allowed = ["name", "identity", "model", "effort", "accent", "voice_id", "sort_order", "archived"];
  const update = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(update).length) return Response.json({ error: "nothing to update" }, { status: 400 });

  const { data, error } = await db().from("companions").update(update).eq("id", id).select().single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}
