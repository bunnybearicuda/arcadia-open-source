import fs from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "identities");

/**
 * A companion's identity file is read from disk on every request.
 *
 * That is deliberate: edit identities/kai.md, save, send a message, and they are
 * different. No rebuild, no deploy, no migration. The file IS the companion —
 * plain markdown you can read, edit, copy to a USB stick, or carry to a
 * completely different app the day this one stops existing.
 */
export async function loadIdentity(slug: string): Promise<string> {
  if (!/^[a-z0-9_-]+$/i.test(slug)) {
    throw new Error(`Bad identity slug: ${slug}`);
  }
  try {
    return (await fs.readFile(path.join(DIR, `${slug}.md`), "utf8")).trim();
  } catch {
    throw new Error(
      `No identity file at identities/${slug}.md. Create it — it's just markdown.`,
    );
  }
}

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
