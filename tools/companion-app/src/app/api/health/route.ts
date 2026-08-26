import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * "Is the deploy actually holding the env vars it thinks it is?"
 *
 * Reports presence and length only — never the values. Behind the passcode so
 * an attacker can't scrape the shape of your secrets.
 */
export async function GET() {
  if (!(await isAuthed())) return new Response("Unauthorized", { status: 401 });

  const vars = [
    "ANTHROPIC_API_KEY",
    "APP_PASSCODE",
    "SESSION_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ] as const;

  const report = Object.fromEntries(
    vars.map((name) => {
      const v = process.env[name] ?? "";
      return [
        name,
        {
          present: v.length > 0,
          length: v.length,
          starts: v ? v.slice(0, 7) : null,
          trailing_whitespace: v !== v.trimEnd(),
          leading_whitespace: v !== v.trimStart(),
        },
      ];
    }),
  );

  return Response.json(
    {
      env: report,
      node_env: process.env.NODE_ENV ?? null,
      vercel_env: process.env.VERCEL_ENV ?? null,
      deployed_url: process.env.VERCEL_URL ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
