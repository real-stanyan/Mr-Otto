-- 0063_otto_apps.sql —— Otto 应用（#1591，spec docs/superpowers/specs/2026-10-05-otto-apps-design.md §3）。幂等。
-- 同 0049 / 0058 的约定：Supabase SQL editor 手动执行一次。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**。
--
-- 三张表 + 一个桶：
--   apps          一个应用一行（slug 是它的稳定键；current_version 指向最新版）。runtime 写，本人读。
--   app_versions  每一版一行：清单 + 文件表（路径 / 大小 / sha256）。文件本体在桶 otto-apps 的 <uid>/<app_id>/<version>/<path>。
--   app_data      应用的数据格子：(app_id, uid, key) → value。本人读写（手机上的桥直接走 REST），runtime 的 service role 也能（智能体读写）。
-- 真相在日志里（app_card 事件 + 专员那一轮）；这三张表是索引与投影——重建 = 重新 build。**已在生产执行（2026-10-05，#1591）**。

create table if not exists public.apps (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  owner_uid         uuid not null references auth.users(id) on delete cascade,
  slug              text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name              text not null check (char_length(name) between 1 and 24),
  icon              text not null default '▫',
  description       text not null default '',
  current_version   integer not null default 0,
  created_by_agent  text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table if not exists public.app_versions (
  app_id          uuid not null references public.apps(id) on delete cascade,
  version         integer not null check (version >= 1),
  manifest        jsonb not null,
  files           jsonb not null default '[]'::jsonb,
  built_by_agent  text not null,
  note            text not null default '',
  created_at      timestamptz not null default now(),
  primary key (app_id, version)
);

create table if not exists public.app_data (
  app_id      uuid not null references public.apps(id) on delete cascade,
  uid         uuid not null references auth.users(id) on delete cascade,
  key         text not null check (char_length(key) between 1 and 200),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (app_id, uid, key)
);

alter table public.apps enable row level security;
alter table public.app_versions enable row level security;
alter table public.app_data enable row level security;

-- apps / app_versions：本人读；写只有 service role（runtime 的 build_app）
drop policy if exists apps_select_owner on public.apps;
create policy apps_select_owner on public.apps for select to authenticated using (owner_uid = auth.uid());
drop policy if exists app_versions_select_owner on public.app_versions;
create policy app_versions_select_owner on public.app_versions for select to authenticated
  using (exists (select 1 from public.apps a where a.id = app_id and a.owner_uid = auth.uid()));

-- app_data：本人读写自己那份（桥的 storage.get/set 走这里）
drop policy if exists app_data_own on public.app_data;
create policy app_data_own on public.app_data for all to authenticated
  using (uid = auth.uid()) with check (uid = auth.uid());

-- 桶：私有，本人只读（下载到手机）；写只有 service role
insert into storage.buckets (id, name, public, file_size_limit)
values ('otto-apps', 'otto-apps', false, 524288)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "otto_apps_select" on storage.objects;
create policy "otto_apps_select" on storage.objects for select to authenticated
  using (bucket_id = 'otto-apps' and (storage.foldername(name))[1] = auth.uid()::text);
