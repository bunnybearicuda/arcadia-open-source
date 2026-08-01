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
  -- Split retrieval budget: pinned continuity keeps a bounded number of
  -- guaranteed slots, and the rest of the budget is ranked by relevance to
  -- the query, so pinned rules can never crowd out the memories the current
  -- conversation actually needs.
  --
  -- The query text is capped before ranking: trigram similarity against a
  -- multi-thousand-character conversation excerpt is what previously made
  -- this function exceed the statement timeout on a few hundred rows.
  with parsed as (
    select
      nullif(trim(left(p_query, 2000)), '') as text_query,
      lower(nullif(trim(right(p_query, 400)), '')) as fuzzy_query
  ),
  prepared as (
    select
      fuzzy_query,
      case
        when text_query is null then null
        else websearch_to_tsquery('english', text_query)
      end as ts_query
    from parsed
  ),
  ranked as (
    select m.*,
      case
        when p.ts_query is null then 0
        else greatest(
          ts_rank_cd(m.search_vector, p.ts_query) * 3,
          coalesce(similarity(lower(m.content), p.fuzzy_query), 0)
        )
      end as relevance
    from public.memories m, prepared p
    where m.active = true
      and m.owner_id in (p_companion_id, 'shared')
  ),
  pinned_rows as (
    select * from ranked
    where pinned
    order by priority desc, relevance desc, updated_at desc
    limit least(greatest(least(greatest(p_limit, 1), 100) / 3, 5), 15)
  ),
  relevant_rows as (
    select * from ranked
    where id not in (select id from pinned_rows)
    order by relevance desc, priority desc, updated_at desc
    limit least(greatest(p_limit, 1), 100)
  )
  select id, owner_id, scope, category, content, source, source_ref, source_url,
         priority, pinned, active, notion_page_id, created_at, updated_at, search_vector
  from (
    select * from pinned_rows
    union all
    select * from relevant_rows
  ) combined
  order by pinned desc, relevance desc, priority desc, updated_at desc
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on public.memories from anon, authenticated;
revoke all on function public.search_companion_memories(text, text, integer) from anon, authenticated;
