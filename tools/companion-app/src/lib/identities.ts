import fs from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "identities");

function validSlug(slug: string): boolean {
  return /^[a-z0-9_-]+$/i.test(slug);
}

/** Read identities/<slug>.md, or null when there isn't one. */
export async function readIdentityFile(slug: string): Promise<string | null> {
  if (!validSlug(slug)) return null;
  try {
    const text = await fs.readFile(path.join(DIR, `${slug}.md`), "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Where a companion's personality comes from.
 *
 * Two sources, checked in order:
 *
 *   1. identities/<slug>.md on disk — wins when present. Read fresh on every
 *      request, so editing the file changes them immediately: no rebuild, no
 *      deploy. Gitignored, so they never land in a public repo.
 *   2. the `identity` column in Supabase — written from the app's editor. This
 *      is what makes a hosted deploy work without ever opening a terminal.
 *
 * The file wins because it's the more portable of the two, and because someone
 * who has gone to the trouble of writing one means it.
 */
export async function resolveIdentity(
  slug: string,
  stored: string | null,
): Promise<string> {
  const fromFile = await readIdentityFile(slug);
  if (fromFile) return fromFile;
  if (stored?.trim()) return stored.trim();

  throw new Error(
    `${slug} has no personality yet. Write one in Settings, or create identities/${slug}.md.`,
  );
}

/** Identity files present on disk, for surfacing ones with no row yet. */
export async function listIdentityFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(DIR);
    return files
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/** Turn a typed-in name into a usable slug. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "companion"
  );
}
