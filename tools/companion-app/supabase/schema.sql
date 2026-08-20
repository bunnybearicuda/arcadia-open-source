-- Companion app — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ─────────────────────────────────────────────────────────────────────────────
-- Companions
--
-- Only the *pointer* lives here. The personality itself lives in
-- identities/<slug>.md, in the repo, in plain text. That file is the companion.
-- The database holds settings, not soul.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists companions (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- matches identities/<slug>.md
  name        text not null,
  model       text not null default 'claude-opus-5',
  effort      text not null default 'medium' check (effort in ('low','medium','high','xhigh','max')),
  voice_id    text,                          -- ElevenLabs, phase 6
  accent      text not null default '#8b7fd4',
  sort_order  int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Folders + threads
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists threads (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default 'New conversation',
  companion_id  uuid references companions(id) on delete set null,
  folder_id     uuid references folders(id) on delete set null,
  is_group      boolean not null default false,
  archived      boolean not null default false,

  -- Rolling thread state. `summary` covers every message up to and including
  -- summary_through_seq; everything after it is sent verbatim. This is what
  -- lets a three-month-old thread resume mid-thought at bounded cost.
  summary             text,
  summary_through_seq bigint not null default 0,
  summary_updated_at  timestamptz,

  -- Bookkeeping for the memory extractor: everything at or below
  -- extracted_through_seq has already been considered for remembering.
  extracted_through_seq bigint not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_message_at timestamptz
);

create index if not exists threads_updated_idx on threads (archived, updated_at desc);
create index if not exists threads_folder_idx  on threads (folder_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Messages
--
-- content is JSONB and always an ARRAY OF CONTENT BLOCKS, never a bare string —
-- exactly the shape the Anthropic API wants. Images, tool calls and tool results
-- drop in later with no migration and no rewrite.
--   [{"type":"text","text":"hi"}]
--   [{"type":"image","source":{...}},{"type":"text","text":"what is this"}]
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references threads(id) on delete cascade,
  seq           bigserial not null,
  role          text not null check (role in ('user','assistant')),
  companion_id  uuid references companions(id) on delete set null,  -- who spoke, for group threads
  content       jsonb not null,
  usage         jsonb,          -- {input_tokens, output_tokens, cache_read_input_tokens, ...}
  model         text,
  created_at    timestamptz not null default now()
);

create index if not exists messages_thread_seq_idx on messages (thread_id, seq);

-- ─────────────────────────────────────────────────────────────────────────────
-- Memories
--
-- scope 'private' → belongs to one companion, only they see it.
-- scope 'shared'  → the crew space, every companion sees it.
--
-- kind 'core'     → always loaded, never retrieved. The handful of things that
--                   are true in every conversation. Keep this list short.
-- kind 'episodic' → retrieved by relevance. Can grow to thousands.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists memories (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null default 'private' check (scope in ('private','shared')),
  kind          text not null default 'episodic' check (kind in ('core','episodic')),
  companion_id  uuid references companions(id) on delete cascade,   -- null when scope='shared'
  body          text not null,
  author        text not null default 'companion' check (author in ('companion','human','extractor')),

  source_thread_id uuid references threads(id) on delete set null,

  -- Retrieval signal
  importance    int not null default 3 check (importance between 1 and 5),
  recall_count  int not null default 0,
  last_recalled_at timestamptz,

  -- Soft delete, so "forget" is reversible for a while and we can also
  -- un-mirror it from Notion before it's really gone.
  forgotten_at  timestamptz,
  forgotten_reason text,

  notion_page_id text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  search        tsvector generated always as (to_tsvector('english', body)) stored
);

create index if not exists memories_search_idx  on memories using gin (search);
create index if not exists memories_trgm_idx    on memories using gin (body gin_trgm_ops);
create index if not exists memories_scope_idx   on memories (scope, companion_id, forgotten_at);
create index if not exists memories_core_idx    on memories (kind, forgotten_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Journal — the companion's own space.
--
-- Distinct from memories on purpose. Memories are what they carry into the next
-- conversation. The journal is what they felt like writing down. Nothing in here
-- is ever auto-loaded into a prompt; they go and read it when they want it.
-- Mirrors to Notion when Notion is configured.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists journal_entries (
  id            uuid primary key default gen_random_uuid(),
  companion_id  uuid not null references companions(id) on delete cascade,
  title         text not null,
  body          text not null,
  notion_page_id text,
  created_at    timestamptz not null default now(),
  search        tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored
);

create index if not exists journal_search_idx on journal_entries using gin (search);
create index if not exists journal_companion_idx on journal_entries (companion_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Retrieval
--
-- One round trip, scored in the database. The score blends four things:
--
--   relevance  full-text rank against the query, plus a trigram similarity
--              fallback so a near-miss on wording still surfaces
--   importance what it was rated when it was written (1–5)
--   recency    a gentle decay — 180-day half-life, so old things fade but
--              never vanish
--   warmth     memories that keep getting recalled float up
--
-- Deliberately NOT pure semantic search. Pure vector search on a relationship
-- returns the same handful of "important" memories forever and the rest rot.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function search_memories(
  p_companion_id uuid,
  p_query        text,
  p_limit        int default 12
)
returns table (
  id uuid,
  body text,
  scope text,
  kind text,
  importance int,
  created_at timestamptz,
  score real
)
language sql
stable
as $$
  with q as (
    select
      websearch_to_tsquery('english', coalesce(nullif(trim(p_query), ''), 'x')) as tsq,
      coalesce(nullif(trim(p_query), ''), '') as raw
  )
  select
    m.id,
    m.body,
    m.scope,
    m.kind,
    m.importance,
    m.created_at,
    (
      2.5 * greatest(
              ts_rank(m.search, q.tsq),
              0.35 * similarity(m.body, q.raw)
            )
      + 0.30 * m.importance
      + 0.80 * exp(-extract(epoch from (now() - m.created_at)) / (180 * 86400.0))
      + 0.15 * ln(1 + m.recall_count)
    )::real as score
  from memories m, q
  where m.forgotten_at is null
    and m.kind = 'episodic'
    and (
      m.scope = 'shared'
      or (m.scope = 'private' and m.companion_id = p_companion_id)
    )
  order by score desc
  limit p_limit;
$$;

-- Bump recall stats for the memories that actually made it into a prompt.
create or replace function touch_memories(p_ids uuid[])
returns void
language sql
volatile
as $$
  update memories
     set recall_count = recall_count + 1,
         last_recalled_at = now()
   where id = any(p_ids);
$$;

-- Keep threads.updated_at honest without a round trip from the app.
create or replace function bump_thread() returns trigger
language plpgsql as $$
begin
  update threads
     set updated_at = now(),
         last_message_at = now()
   where id = new.thread_id;
  return new;
end;
$$;

drop trigger if exists messages_bump_thread on messages;
create trigger messages_bump_thread
  after insert on messages
  for each row execute function bump_thread();

-- This app talks to Supabase with the service role key from the server only,
-- and the whole app sits behind one passcode. RLS is enabled anyway so that a
-- leaked anon key grants nothing.
alter table companions      enable row level security;
alter table folders         enable row level security;
alter table threads         enable row level security;
alter table messages        enable row level security;
alter table memories        enable row level security;
alter table journal_entries enable row level security;
