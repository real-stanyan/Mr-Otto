-- supabase/migrations/0033_workspace_wiki_journal.sql —— 团队 wiki 的追加式备份 + 历史（#1140，spec §6）。
-- 幂等，重跑不炸；与 0021 起同一约定：在 Supabase SQL editor 手动执行一次。
-- 单向：/work/wiki/ 里的文件是事实，这张表是备份；wiki/ 不存在时 runtime 从各路径最新版本物化回来。
-- 写方只有 runtime（service key）。authenticated 没有 insert / update / delete 策略：
-- 给 insert = 让任何在籍成员替 agent 伪造一次写入；给 delete = 让「读过」与「没发生」变成同一件事（同 ADR-0256）。

create table if not exists public.workspace_wiki_journal (
  seq          bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  path         text not null,
  content      text,                         -- null = 该页被删
  kind         text not null,                -- write | remove | edit | migrate | restore | seed | external
  author_kind  text not null,                -- agent | member | system | external
  author_id    text not null default '',     -- agent_id 或 uid；system / external 为空串
  author_label text not null default '',     -- 写入那一刻的名字（快照，改名不回写）
  created_at   timestamptz not null default now()
);

create index if not exists wwj_ws_path_seq on public.workspace_wiki_journal (workspace_id, path, seq desc);

alter table public.workspace_wiki_journal enable row level security;

drop policy if exists wwj_select_member on public.workspace_wiki_journal;
create policy wwj_select_member on public.workspace_wiki_journal for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
