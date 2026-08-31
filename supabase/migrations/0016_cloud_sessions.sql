-- 0016_cloud_sessions.sql —— 云会话行 + 用量台账（ADR-0199，二期）。幂等，重跑不炸。
--
-- workspace_sessions 一表两用：kind='package'（一期发布包，存量默认）/
-- 'cloud'（云会话）。云会话没有 pkg_id，所以放开非空，用 check 钉住「package 必有 pkg_id」。
--
-- 云会话行由 runtime 用 service key 写（绕 RLS）；成员读走既有 select 策略（在籍可见）。
-- 现有 insert/delete 策略只约束 authed 用户，service key 不受限，无需新策略。
--
-- usage_ledger：runtime 异步镜像写（service key），本人只读自己的行。
--

alter table public.workspace_sessions
  add column kind text not null default 'package' check (kind in ('package', 'cloud')),
  add column archived boolean not null default false;

alter table public.workspace_sessions alter column pkg_id drop not null;
alter table public.workspace_sessions
  add constraint ws_sessions_pkg_shape check (kind <> 'package' or pkg_id is not null);

-- 用量台账：runtime 异步镜像写（service key），本人只读自己的行。
create table public.usage_ledger (
  id bigint generated always as identity primary key,
  uid uuid not null,
  workspace_id uuid not null,
  session_id text not null,
  model text not null,
  prompt_tokens integer not null,
  completion_tokens integer not null,
  ts timestamptz not null default now()
);
create index usage_ledger_uid_ts on public.usage_ledger (uid, ts);
alter table public.usage_ledger enable row level security;
create policy usage_select_self on public.usage_ledger
  for select using (uid = auth.uid());
-- 故意不建 insert/update/delete 策略：authed 用户全拒，只有 service key 可写。
