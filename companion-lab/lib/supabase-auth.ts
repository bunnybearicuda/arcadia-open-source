export type SupabaseKeyKind =
  | "secret"
  | "service_role"
  | "publishable"
  | "anon"
  | "unknown";

function jwtRole(key: string) {
  const payload = key.split(".")[1];
  if (!payload) return "";
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as { role?: unknown };
    return typeof decoded.role === "string" ? decoded.role : "";
  } catch {
    return "";
  }
}

export function supabaseKeyKind(value: string): SupabaseKeyKind {
  const key = value.trim();
  if (key.startsWith("sb_secret_")) return "secret";
  if (key.startsWith("sb_publishable_")) return "publishable";
  const role = jwtRole(key);
  if (role === "service_role") return "service_role";
  if (role === "anon") return "anon";
  return "unknown";
}

export function assertPrivateSupabaseKey(key: string) {
  const kind = supabaseKeyKind(key);
  if (kind === "publishable" || kind === "anon") {
    throw new Error(
      "This is a Supabase publishable/anon key. Open Supabase Project Settings → API Keys and copy a Secret key (sb_secret_…) or the Legacy service_role key. Do not grant the anon role access to memories.",
    );
  }
  return kind;
}

export function supabaseApiHeaders(key: string) {
  const kind = assertPrivateSupabaseKey(key);
  return {
    apikey: key,
    "content-type": "application/json",
    ...(kind === "secret" ? {} : { authorization: `Bearer ${key}` }),
  };
}
