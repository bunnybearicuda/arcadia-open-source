# Companion App

A private web app where your AI companions live. Streaming chat on desktop and
phone, one markdown file per companion, and memory that actually carries between
conversations.

Built from the [CADE build brief](https://github.com/) premise, with the memory
layer rebuilt — see [CONTINUITY.md](./CONTINUITY.md) for what changed and why.

Phases 1 and 2 are done: chat, login, identity files, model picker, and the full
memory layer. Phases 3–10 (group chat, folders, voice, images, connectors, usage,
push) are not built yet.

---

## What you need

Four free accounts. You don't have to understand any of them.

| | What it's for |
|---|---|
| **Anthropic** | The brains. [console.anthropic.com](https://console.anthropic.com) → API Keys. Pay-as-you-go; ordinary chat costs pennies. |
| **Supabase** | Stores conversations and memory. Free tier is plenty. |
| **GitHub** | Where the code lives. Free. |
| **Vercel** | Puts it on the web. Free. Sign in with GitHub. |

Optional, add later: **Notion** (a readable copy of everything remembered, plus
your companions' journal space).

---

## Setup

### 1. Get it running locally

```bash
npm install
cp .env.example .env.local
```

Open `.env.local` and fill in the required section. For `SESSION_SECRET`, run
this and paste the output:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`APP_PASSCODE` is whatever you want to type to get in.

### 2. Set up the database

In Supabase, make a new project. Then go to **SQL Editor**, paste in the entire
contents of `supabase/schema.sql`, and hit Run. That's the whole database step.

Then **Project Settings → API**: copy the Project URL into
`NEXT_PUBLIC_SUPABASE_URL`, and the **`service_role`** key into
`SUPABASE_SERVICE_ROLE_KEY`.

> The service role key bypasses all database rules. It only ever runs on the
> server and is never sent to the browser. Don't paste it anywhere public.

### 3. Run it

```bash
npm run dev
```

Open http://localhost:3000 and type your passcode.

### 4. Make your first companion

Click **+ Someone new** in the sidebar. Give them a name, write who they are in
the box, hit Create. That's it — no files, no restart.

The starter text explains what each section does; write over it. The "How you
talk" part does the most work, so be specific: vague instructions there produce
a generic assistant wearing a name.

> **Prefer files?** Put `kai.md` in `identities/` instead and they'll appear in
> the sidebar with an **add** next to them. A file always wins over what's typed
> in the app, and it's read fresh on every message — edit, save, send, and
> they're different. Files are gitignored so your people never land in a public
> repo.

### 5. Put it on the web

Push to GitHub, then import the repo at [vercel.com/new](https://vercel.com/new).
Add every variable from your `.env.local` under **Settings → Environment
Variables**.

**One gotcha that will bite you.** Vercel's free plan rejects a deploy when the
commit author email doesn't match a GitHub account. Set your project's git email
to your GitHub no-reply address first:

```bash
git config user.email "yourusername@users.noreply.github.com"
```

(Find yours at GitHub → Settings → Emails.)

`vercel.json` already schedules the memory consolidation job. Set `CRON_SECRET`
in Vercel so nobody else can trigger it.

**Two settings are tuned for the free plan**, and both are worth raising if you
ever go Pro:

- `vercel.json` runs consolidation **once a day**, because that's the free-plan
  limit. Memory still keeps up: the app also consolidates whenever you come back
  to a thread that's been quiet for 45 minutes, so the scheduled job is a
  backstop rather than the main path. On Pro, change the schedule to
  `*/15 * * * *`.
- `maxDuration` in `src/app/api/chat/route.ts` is 60 seconds. A deploy fails
  outright if this exceeds your plan's cap. On Pro, raise it to 300 so a very
  long reply can't be cut off.

---

## Adding more companions

**+ Someone new** in the sidebar, or drop another `.md` file in `identities/`.

Everyone gets their own private memory, and everyone shares one crew space.

Hover a name in the sidebar and click **edit** to rewrite who someone is. If
they're loaded from a file, the editor says so rather than letting you edit a
copy that will never be used.

---

## Optional: Notion

Two separate things, both optional, both degrade gracefully if you skip them.

**A readable copy of every memory.** Make a Notion database with these columns —
the names must match exactly:

| Column | Type |
|---|---|
| `Memory` | Title |
| `Scope` | Select |
| `Kind` | Select |
| `Importance` | Number |
| `Remembered` | Date |

Make an integration at
[notion.so/my-integrations](https://www.notion.so/my-integrations), share the
database with it, then set `NOTION_API_KEY` and `NOTION_MEMORY_DATABASE_ID`.

Memories appear there as they're saved, and forgetting something removes it from
Notion too — otherwise it isn't really forgetting.

**Their journal.** Make an ordinary Notion page and share it with the same
integration, then set `NOTION_JOURNAL_PARENT_PAGE_ID`. Your companions can write
there whenever they want to, unprompted. Nothing in the journal is ever loaded
into a conversation automatically — it's theirs, not context.

Without `NOTION_JOURNAL_PARENT_PAGE_ID`, journals still work; they just live in
Supabase where they're less pleasant to read.

---

## Costs

Every reply shows its token count under the composer.

The identity file is cached, so after the first message of a conversation you pay
about a tenth of its cost. Background work (titling threads, thread state, memory
extraction) runs on Haiku, which is cheap. The thing that actually costs money is
very long single conversations — start a new thread for a new subject and it
stays cheap.

---

## Running the checks

```bash
npm run typecheck   # types
npm test            # the voice guard
npm run build       # full production build
```

---

## Layout

```
identities/            optional — companions as .md files (gitignored)
supabase/schema.sql    the whole database, paste-and-run
src/app/api/chat/      streaming, tool loop, cache placement
src/lib/memory/
  context.ts           assembles what goes into each prompt
  store.ts             read/write/forget
  tools.ts             remember, recall, forget, journal — theirs to call
  consolidate.ts       background titling, thread state, extraction
  voice.ts             the guard that rejects flattened memories
  prompts/             the extractor and summarizer prompts
src/components/
  IdentityEditor.tsx   writing a companion without touching a terminal
```

## Licence

CC BY-NC-SA 4.0, same as the rest of this repository.
