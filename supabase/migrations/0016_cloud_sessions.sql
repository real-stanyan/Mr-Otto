-- 0016_cloud_sessions.sql —— 云会话行 + 用量台账（ADR-0199，二期）。幂等，重跑不炸。
--
-- workspace_sessions 一表两用：kind='package'（一期发布包，存量默认）/
-- 'cloud'（云会话）。云会话没有 pkg_id，所以放开非空，用 check 钉住「package 必有 pkg_id」。
--
-- 云会话行由 runtime 用 service key 写（绕 RLS）；成员读走既有 select 策略（在籍可见）。
-- wss_insert_publisher 和 wss_update_publisher 策略都加 kind='package' 限制，防止成员伪造云会话行。
--
-- usage_ledger：runtime 异步镜像写（service key），本人只读自己的行。
--

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'kind'
  ) then
    alter table public.workspace_sessions
      add column kind text not null default 'package' check (kind in ('package', 'cloud'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'archived'
  ) then
    alter table public.workspace_sessions
      add column archived boolean not null default false;
  end if;
end $$;

do $$
begin
  -- Check if pkg_id column is still NOT NULL and alter if needed
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_sessions' and column_name = 'pkg_id' and is_nullable = 'NO'
  ) then
    alter table public.workspace_sessions alter column pkg_id drop not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public' and table_name = 'workspace_sessions' and constraint_name = 'ws_sessions_pkg_shape'
  ) then
    alter table public.workspace_sessions
      add constraint ws_sessions_pkg_shape check (kind <> 'package' or pkg_id is not null);
  end if;
end $$;

-- ── RLS 策略修复（堵伪造 kind='cloud' 行的洞）──────────────────────────────────
-- 成员只能发布 kind='package' 的会话（一期语义），不能伪造 kind='cloud'
drop policy if exists wss_insert_publisher on public.workspace_sessions;
create policy wss_insert_publisher on public.workspace_sessions for insert to authenticated
  with check (publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()) and kind = 'package');

-- 发布者本人可以改元数据，但只能改 kind='package' 的行（不能把 package 改成 cloud）
drop policy if exists wss_update_publisher on public.workspace_sessions;
create policy wss_update_publisher on public.workspace_sessions for update to authenticated
  using (publisher_uid = auth.uid() and kind = 'package')
  with check (publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()) and kind = 'package');
-- using 也钉 kind，策略只能触达本就是 package 的行，防止成员伪造云会话行后再改元数据

-- 发布者本人可以撤回会话，但只能删 kind='package' 的行（终审 I1）：0015 的
-- wss_delete_publisher 漏钉 kind，云会话的创建者能直接打 Supabase REST 删掉
-- 自己那一行 workspace_sessions——会话从所有成员列表消失、daemon 重启后
-- 房间不再恢复（启动引导按 kind='cloud' 且 archived=false 查这张表），
-- VPS 上的权威事件日志变成够不着的孤儿，且不产生任何归档事件。
drop policy if exists wss_delete_publisher on public.workspace_sessions;
create policy wss_delete_publisher on public.workspace_sessions for delete to authenticated
  using (publisher_uid = auth.uid() and kind = 'package');

-- 用量台账：runtime 异步镜像写（service key），本人只读自己的行。
create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  uid uuid not null,
  workspace_id uuid not null,
  session_id text not null,
  model text not null,
  prompt_tokens integer not null,
  completion_tokens integer not null,
  ts timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'usage_ledger' and indexname = 'usage_ledger_uid_ts'
  ) then
    create index usage_ledger_uid_ts on public.usage_ledger (uid, ts);
  end if;
end $$;

alter table public.usage_ledger enable row level security;

drop policy if exists usage_select_self on public.usage_ledger;
create policy usage_select_self on public.usage_ledger
  for select to authenticated using (uid = auth.uid());
-- 故意不建 insert/update/delete 策略：authed 用户全拒，只有 service key 可写。
