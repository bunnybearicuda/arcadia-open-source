import { cookies } from "next/headers";
import { checkPasscode, mintToken, sessionCookieName, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { passcode } = (await req.json()) as { passcode?: string };
  if (!passcode || !checkPasscode(passcode)) {
    // A small delay takes the shine off guessing at it.
    await new Promise((r) => setTimeout(r, 600));
    return Response.json({ ok: false }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(sessionCookieName, mintToken(), sessionCookieOptions);
  return Response.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(sessionCookieName);
  return Response.json({ ok: true });
}
