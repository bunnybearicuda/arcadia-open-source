/** Fail loudly at the first request rather than mysteriously at the third. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill it in ` +
        `(or add it in Vercel → Settings → Environment Variables).`,
    );
  }
  return v;
}

export const env = {
  get anthropicKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get passcode() {
    return required("APP_PASSCODE");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseServiceKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  // Optional — every one of these degrades gracefully.
  notionKey: process.env.NOTION_API_KEY || null,
  notionMemoryDb: process.env.NOTION_MEMORY_DATABASE_ID || null,
  notionJournalParent: process.env.NOTION_JOURNAL_PARENT_PAGE_ID || null,
  cronSecret: process.env.CRON_SECRET || null,
};

export const notionEnabled = () => Boolean(env.notionKey && env.notionMemoryDb);
