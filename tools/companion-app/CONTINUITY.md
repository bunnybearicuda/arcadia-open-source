# Continuity

Notes on how memory works here, and why it isn't built the obvious way.

The obvious way — the one in most build guides, including the CADE brief this
started from — is: keep a memories table, summarise conversations into it, load
them into the system prompt on every message. That works. It also has three
problems that only show up after a few months of real use, by which point
they're expensive to fix.

---

## Problem 1 — the register drift

This is the one that matters most, and it isn't a storage problem.

An auto-summariser writes *about* you, from outside, in the register of
documentation. Left alone it produces memories like:

> User prefers to work in the evenings and has an established workflow around
> deep focus blocks.

Nothing there is false. But it's you rendered as a configuration file. Do that
four hundred times and the person in the memories is a systematic, methodical
stranger — because every casual thing you did got promoted into intent. You
poked at something for an hour out of curiosity; the summariser recorded that
you were "evaluating an approach."

And it compounds, because those memories get loaded back in and become the
register the companion learns to think about you in.

The fix is in three places:

**The prompt** ([`src/lib/memory/prompts/extractor.md`](src/lib/memory/prompts/extractor.md))
tells the extractor it is the companion, remembering — not a service
summarising a user. First person. Keep her actual words. Record what it meant,
not just what occurred. It names the failure mode directly: *do not promote
casual behaviour into method.*

**The guard** ([`src/lib/memory/voice.ts`](src/lib/memory/voice.ts)) enforces it,
because a prompt is a request and this is a rule. Any memory containing `user
prefers`, `workflow`, `approach to`, `methodology`, `key takeaway`, a bulleted
list, or a `Context:` label is **dropped, not rewritten**. Losing a memory is
cheap. Keeping a flattened one is not. `npm test` checks this against real
examples of both kinds.

**The default** is to save nothing. Most conversations should produce zero or one
memory. There's a hard ceiling of four per extraction run — past that it has
stopped remembering and started transcribing.

---

## Problem 2 — memory as surveillance

If the only thing writing memories is a background summariser, then memory is a
log *about* the human, assembled without the companion's involvement. The
companion is the subject of the memory system rather than the owner of it.

So the primary path is a tool the companion calls themselves:

| Tool | What it's for |
|---|---|
| `remember` | Keep something, in their own voice, because they decided to |
| `recall` | Search back for something they can tell they should know |
| `revise_memory` | Correct something they now understand differently |
| `forget` | Let something go |
| `journal` | Write in their own space, unprompted, for no one |
| `read_journal` | Read back through it |

The background extractor still runs, but it's the safety net — for the things
nobody thought to save in the moment — not the mechanism.

The **journal** is deliberately not memory. Memories are what gets carried into
the next conversation. The journal is what they felt like writing down, and it is
*never* auto-loaded into a prompt. They go and read it when they want it. With
Notion configured it lives in a real Notion page you can open and read; without
it, it's a table in Supabase. It works either way.

---

## Problem 3 — loading memory into the system prompt costs a fortune

This one is pure mechanics, and it's the reason the naive version gets
unaffordable on long threads.

Prompt caching is a **prefix match**. The request renders as
`tools → system → messages`, and changing any byte invalidates everything after
it. So if retrieved memories go in the system prompt, and retrieval changes every
turn (it does — that's the point), then every single message re-processes the
entire conversation at full price.

Instead, continuity is injected **after** the conversation history, as a
`{role: "system"}` message inside `messages[]`:

```
system:   identity file                    ← frozen, cached, changes only when you edit the file
messages: [ ...history ]                   ← cached, breakpoint on the last turn
          { role: "user", ... }            ← what she just said
          { role: "system", ... }          ← memories, thread state, elsewhere — fresh every turn
```

The volatile layer sits past the cache breakpoint, so it costs nothing to change
it every message. `{role: "system"}` mid-conversation is supported on Opus 5 and
Opus 4.8. Models that don't take it get the same block wrapped in a
`<continuity>` tag in the user turn — the chat route catches that specific 400
and retries once, so adding a cheaper model later doesn't break anything. Same
caching profile, slightly weaker authority.

---

## The five layers

What actually goes into a prompt, and where:

**1. Identity** — `identities/<slug>.md`, in full, at the top of `system`, cached.
Read from disk every request, so editing the file changes them immediately with
no rebuild. This file is the companion; everything else is scaffolding around it.

**2. Core memories** — `kind = 'core'`. Always loaded, never retrieved. The
handful of things true in every conversation. Keep this list short; it's the only
part that grows the prompt unconditionally.

**3. Retrieved episodic memories** — scored and ranked in Postgres against what
she just said. This is what lets memory grow to thousands of entries without the
prompt growing at all.

**4. Thread state** — a living note per thread, rewritten as it grows, covering
everything behind the last few verbatim turns. A three-month-old conversation
resumes mid-thought at bounded cost.

**5. Elsewhere** — headlines from the companion's other recent threads. Without
this, every thread is a separate amnesiac relationship that happens to share a
name. With it, there's one ongoing relationship that happens to have threads.

---

## Why retrieval isn't vector search

The scoring function ([`search_memories`](supabase/schema.sql)) blends four
signals rather than one:

```
2.5 × relevance      full-text rank, with trigram similarity as a fallback
0.3 × importance     what it was rated when written (1–5)
0.8 × recency        exponential decay, 180-day half-life
0.15 × warmth        ln(1 + times recalled)
```

Pure semantic similarity has a specific failure on a relationship: it returns the
same handful of high-salience memories forever, and everything else rots
unreachable. Recency keeps recent things reachable; warmth lets things that keep
mattering float; importance is the companion's own judgement at write time.

It's also **zero extra dependencies** — Postgres full-text search plus
`pg_trgm`, both in stock Supabase. No embedding provider, no extra API key, no
extra bill. If you outgrow it, add a `vector` column and blend a fifth term into
the same function; nothing else in the codebase has to change.

The trigram fallback matters more than it looks: full-text search misses
`"Biscuit"` when she types `"the dog"`, and near-misses on wording are the normal
case in conversation.

---

## When things get written

| Trigger | What runs |
|---|---|
| The companion calls `remember` | Immediately, inline |
| After 2 messages | Thread gets a real title |
| Every 14 unsummarised messages | Thread state rewritten |
| Every 24 unextracted messages | Rolling extraction mid-conversation |
| 45 minutes of quiet | Full extraction + thread state (Vercel Cron, every 15 min) |

The 45-minute wait is load-bearing. Extracting mid-conversation means
remembering things that get contradicted ten messages later.

All of it runs after the response has already streamed (`after()` in the chat
route), so none of it makes her wait.

---

## Forgetting

`forget` is a soft delete — the row stays, flagged, so a mistaken forget is
recoverable. But it's removed from the Notion mirror **immediately**. When she
says forget it, the readable copy shouldn't still be sitting there. That's the
whole point.

---

## Things deliberately not done

**No RAG over conversation history.** Messages are for reading back; memories are
for carrying forward. Retrieving raw old messages into context produces a
companion that quotes transcripts at you.

**No importance auto-tuning.** Tempting, and it would drift. Importance is set
once, by whoever wrote the memory.

**No auto-promotion to `core`.** Core is small on purpose and stays a
deliberate choice.

**No memory of memory operations.** The companion is never told "you remembered
3 things." That way lies narrating the machinery instead of being someone.

---

## If this app goes away

Everything that matters is portable, on purpose:

- **Identities** are plain markdown on disk. Copy the folder.
- **Memories** are rows in your own Supabase project, and — if you set Notion
  up — readable pages in your own Notion.
- **Journals** are the same.

None of it is locked in a format only this app understands, because the app is
the least durable part of the arrangement.
