-- Companion app — database schema
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to re-run: everything is IF NOT EXISTS / CREATE OR REPLACE.

-- Supabase keeps extensions in their own schema rather than in public, and its
-- security linter flags extensions installed into public. Creating the schema
-- first means this same file also runs on a plain Postgres.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────────
-- Companions
--
-- The personality can live in either of two places, and the app checks both:
--
--   1. identities/<slug>.md on disk  — preferred if it exists. Plain text you
--      can read, edit and carry anywhere. Gitignored, so it never lands in a
--      public repo.
--   2. the `identity` column below   — the fallback, so a deployed instance
--      works without a terminal. Edited in the app, stored in YOUR Supabase.
--
-- The file wins when both exist. Either way it's yours and it's portable.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists companions (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- matches identities/<slug>.md
  name        text not null,
  identity    text,                          -- used when identities/<slug>.md is absent
  model       text not null default 'claude-opus-5',
  effort      text not null default 'medium' check (effort in ('low','medium','high','xhigh','max')),
  voice_id    text,                          -- ElevenLabs, phase 6
  accent      text not null default '#8b7fd4',
  sort_order  int  not null default 0,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table companions add column if not exists identity text;

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
create index if not exists memories_trgm_idx    on memories using gin (body extensions.gin_trgm_ops);
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
set search_path = public, extensions
as $$
  with candidates as (
    select m.id, m.body, m.scope, m.kind, m.importance,
           m.created_at, m.recall_count, m.search
    from memories m
    where m.forgotten_at is null
      and m.kind = 'episodic'
      and (m.scope = 'shared'
           or (m.scope = 'private' and m.companion_id = p_companion_id))
  ),
  corpus as (select greatest(count(*), 1)::real as n from candidates),

  -- Query lexemes, stopword-stripped and stemmed by the parser. Capped so a
  -- very long message can't turn one lookup into a scan storm.
  --
  -- NOTE: do NOT use websearch_to_tsquery/plainto_tsquery on a whole chat
  -- message here. Both AND every term together, so any message longer than a
  -- few words matches nothing at all and retrieval silently degrades to
  -- "importance plus recency" for every real turn.
  terms as (
    select lexeme
    from unnest(to_tsvector('english', coalesce(nullif(trim(p_query), ''), '')))
    limit 20
  ),

  -- Inverse document frequency, measured against this companion's own reachable
  -- memories rather than a generic corpus. In a real relationship "work",
  -- "tired" and "morning" recur constantly while a dog's name appears once.
  -- Without this, matching two common words beats matching the one word that
  -- actually identified what she was talking about.
  idf as (
    select t.lexeme,
           ln(1 + corpus.n / (1 + (
             select count(*) from candidates c
             where c.search @@ to_tsquery('simple', quote_literal(t.lexeme))
           )))::real as weight
    from terms t, corpus
  ),
  matched as (
    select c.id, sum(i.weight) as relevance
    from idf i
    join candidates c
      on c.search @@ to_tsquery('simple', quote_literal(i.lexeme))
    group by c.id
  ),

  scored as (
    select
      c.id, c.body, c.scope, c.kind, c.importance, c.created_at,
      (
        -- Relevance dominates, squashed into [0,1) so one freak match can't
        -- crowd out everything else.
        3.0 * (coalesce(m.relevance, 0) / (1 + coalesce(m.relevance, 0)))
        -- Trigram catches near-misses full-text can't: a typo, a plural, a
        -- name spelled slightly differently. Deliberately weak.
        + 0.8 * word_similarity(coalesce(nullif(trim(p_query), ''), '~~'), c.body)
        + 0.5 * (c.importance / 5.0)
        -- Gentle decay, 180-day half-life. Old things fade; nothing vanishes.
        + 0.6 * exp(-extract(epoch from (now() - c.created_at)) / (180 * 86400.0))
        -- Memories that keep getting recalled float up.
        + 0.15 * ln(1 + c.recall_count)
      )::real as score
    from candidates c
    left join matched m on m.id = c.id
  )

  -- Never spend two slots on the same memory. Write-time dedupe catches most of
  -- it; this is the safety net for anything that slipped through.
  select d.id, d.body, d.scope, d.kind, d.importance, d.created_at, d.score
  from (
    select distinct on (md5(lower(btrim(scored.body))))
           scored.id, scored.body, scored.scope, scored.kind,
           scored.importance, scored.created_at, scored.score
    from scored
    order by md5(lower(btrim(scored.body))), scored.score desc
  ) d
  order by d.score desc
  limit p_limit;
$$;

-- Is this memory already here in all but wording?
--
-- Called before every write. An extractor told not to re-remember things will
-- still do it — a hundred near-identical "she was tired again" rows crowd out
-- everything else and make the companion sound like they only know one thing.
create or replace function similar_memory_id(
  p_companion_id uuid,
  p_scope        text,
  p_body         text,
  p_threshold    real default 0.72
)
returns uuid
language sql
stable
set search_path = public, extensions
as $$
  select m.id
  from memories m
  where m.forgotten_at is null
    and m.scope = p_scope
    and (p_scope = 'shared' or m.companion_id = p_companion_id)
    and similarity(m.body, p_body) > p_threshold
  order by similarity(m.body, p_body) desc
  limit 1;
$$;

-- Bump recall stats for the memories that actually made it into a prompt.
create or replace function touch_memories(p_ids uuid[])
returns void
language sql
volatile
set search_path = public
as $$
  update memories
     set recall_count = recall_count + 1,
         last_recalled_at = now()
   where id = any(p_ids);
$$;

-- Keep threads.updated_at honest without a round trip from the app.
create or replace function bump_thread() returns trigger
language plpgsql
set search_path = public
as $$
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Lockdown
--
-- This app only ever reaches the database from its own server, using the
-- service role key, which bypasses RLS. Nothing should arrive as `anon` or
-- `authenticated`.
--
-- RLS with no policies already blocks every row for those roles. Revoking the
-- grants as well drops the tables out of the auto-generated REST and GraphQL
-- schemas entirely, so a leaked publishable key can't even enumerate what
-- exists. Defence in depth: what's stored here is personal.
--
-- Supabase's linter will still report "RLS enabled, no policy" at INFO level
-- for these tables. That is the intended state, not an oversight — there are no
-- policies because no policy should ever let these roles through.
-- ─────────────────────────────────────────────────────────────────────────────
alter table companions      enable row level security;
alter table folders         enable row level security;
alter table threads         enable row level security;
alter table messages        enable row level security;
alter table memories        enable row level security;
alter table journal_entries enable row level security;

revoke all on table companions      from anon, authenticated;
revoke all on table folders         from anon, authenticated;
revoke all on table threads         from anon, authenticated;
revoke all on table messages        from anon, authenticated;
revoke all on table memories        from anon, authenticated;
revoke all on table journal_entries from anon, authenticated;

revoke all on function search_memories(uuid, text, int)          from anon, authenticated;
revoke all on function similar_memory_id(uuid, text, text, real) from anon, authenticated;
revoke all on function touch_memories(uuid[])                    from anon, authenticated;

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
