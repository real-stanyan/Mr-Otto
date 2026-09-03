-- 0019_memory_docs.sql — 记忆跟账号走（#852，ADR-0206）
-- 本地 ~/.mr-otto/accounts/<hash>/memories/** 是缓存；这张表是账号级副本，后写胜。
-- key = memoryRelPath 的相对路径（memories/USER.md、memories/topics/work.md、
-- memories/projects/<hash16>/MEMORY.md、…/root.txt、…/<slug>.label）。

create table if not exists public.memory_docs (
  uid        uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  content    text        not null,
  updated_at timestamptz not null default now(),
  primary key (uid, key)
);

alter table public.memory_docs enable row level security;

drop policy if exists "memory_docs_select_own" on public.memory_docs;
create policy "memory_docs_select_own" on public.memory_docs
  for select to authenticated using (auth.uid() = uid);

drop policy if exists "memory_docs_insert_own" on public.memory_docs;
create policy "memory_docs_insert_own" on public.memory_docs
  for insert to authenticated with check (auth.uid() = uid);

drop policy if exists "memory_docs_update_own" on public.memory_docs;
create policy "memory_docs_update_own" on public.memory_docs
  for update to authenticated using (auth.uid() = uid) with check (auth.uid() = uid);

drop policy if exists "memory_docs_delete_own" on public.memory_docs;
create policy "memory_docs_delete_own" on public.memory_docs
  for delete to authenticated using (auth.uid() = uid);
