create extension if not exists pg_trgm;

create table if not exists public.memories (
  id text primary key,
  owner_id text not null,
  scope text not null check (scope in ('private', 'shared')),
  category text not null default 'memory',
  content text not null,
  source text not null default 'manual',
  source_ref text,
  source_url text,
  priority integer not null default 1,
  pinned boolean not null default false,
  active boolean not null default true,
  notion_page_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(category, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored
);

create index if not exists memories_owner_active_idx
  on public.memories (owner_id, active, pinned desc, priority desc, updated_at desc);
create index if not exists memories_search_vector_idx
  on public.memories using gin (search_vector);
create index if not exists memories_content_trgm_idx
  on public.memories using gin (content gin_trgm_ops);

alter table public.memories enable row level security;

create or replace function public.search_companion_memories(
  p_companion_id text,
  p_query text,
  p_limit integer default 40
)
returns setof public.memories
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select m.*,
      case
        when nullif(trim(p_query), '') is null then 0
        else ts_rank_cd(m.search_vector, websearch_to_tsquery('english', p_query))
      end as text_rank,
      case
        when nullif(trim(p_query), '') is null then 0
        else similarity(lower(m.content), lower(p_query))
      end as fuzzy_rank
    from public.memories m
    where m.active = true
      and m.owner_id in (p_companion_id, 'shared')
  )
  select id, owner_id, scope, category, content, source, source_ref, source_url,
         priority, pinned, active, notion_page_id, created_at, updated_at, search_vector
  from ranked
  order by pinned desc,
           priority desc,
           greatest(text_rank * 3, fuzzy_rank) desc,
           updated_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on public.memories from anon, authenticated;
revoke all on function public.search_companion_memories(text, text, integer) from anon, authenticated;
