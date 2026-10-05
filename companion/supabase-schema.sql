create extension if not exists pgcrypto;

create table if not exists public.knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.important_talks (
  id uuid primary key default gen_random_uuid(),
  speaker text not null check (speaker in ('user', 'assistant')),
  content text not null,
  importance integer not null default 1,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function public.touch_knowledge_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists knowledge_set_updated_at on public.knowledge;
create trigger knowledge_set_updated_at
before update on public.knowledge
for each row
execute function public.touch_knowledge_updated_at();

create index if not exists idx_knowledge_updated_at on public.knowledge (updated_at desc);
create index if not exists idx_important_talks_created_at on public.important_talks (created_at desc);
