-- 0015_workspaces.sql —— 工作区（ADR-0198，issue #811）。幂等，重跑不炸。
--
-- 工作区是多人协作的会话集合。owner 建群，可以拉人（拉人时发邀请码）、
-- 踢人、改权限。成员可以看到工作区内的会话、添加会话、查看工作区内的已连服务。
--
-- 与 0014 同一约定：在 Supabase SQL editor 手动执行一次（幂等，重跑不炸）。
--
-- 表设计：
-- · workspaces —— 群信息（名字、owner），作为 workspace_members/connectors/sessions 的外键。
-- · workspace_members —— 在籍记录。owner 在 workspaces.owner_uid 记了一份，
--   这张表也要补一行（INSERT ... RETURNING 前 owner 行还不存）。
-- · workspace_connectors —— 目录元数据，「这个好友在这个工作区接通了哪些服务」。
--   真相在 escrow 箱 + RLS，这张表可以撒谎，拦不过闸。
-- · workspace_sessions —— 在工作区发布的会话清单。包下载的 RLS 靠这张表指名白名单。

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  owner_uid uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uid uuid not null references auth.users(id),
  role text not null default 'member' check (role in ('owner','member')),
  added_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, uid)
);
-- 连接器目录（展示元数据；执行真相在 escrow 箱 + 关系闸，这张表撒谎也越不过闸）
create table if not exists public.workspace_connectors (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  host_uid uuid not null references auth.users(id),
  server_id text not null,
  label text not null default '',
  tools jsonb not null default '[]'::jsonb,   -- [] = 整服务放行（proxyProtocol 口径）
  updated_at timestamptz not null default now(),
  primary key (workspace_id, host_uid, server_id)
);
create table if not exists public.workspace_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  publisher_uid uuid not null references auth.users(id),
  pkg_id text not null,
  title text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_connectors enable row level security;
alter table public.workspace_sessions enable row level security;

-- 在籍判断给 policy 用。security definer：RLS 下 workspace_members 自查会递归
create or replace function public.is_ws_member(ws uuid, u uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from workspace_members where workspace_id = ws and uid = u) $$;

-- ── workspaces RLS ────────────────────────────────────────────────────────
-- owner 可以看自己建的群；成员可以看所在的群
drop policy if exists ws_select_member on public.workspaces;
create policy ws_select_member on public.workspaces for select to authenticated
  using (owner_uid = auth.uid() or public.is_ws_member(id, auth.uid()));
-- 只有 owner 能建群（另外一张表的策略保证 owner 必须先加自己）
drop policy if exists ws_insert_self on public.workspaces;
create policy ws_insert_self on public.workspaces for insert to authenticated
  with check (owner_uid = auth.uid());
-- 只有 owner 能删群（级联删成员/连接器/会话）
drop policy if exists ws_delete_owner on public.workspaces;
create policy ws_delete_owner on public.workspaces for delete to authenticated
  using (owner_uid = auth.uid());

-- ── workspace_members RLS ─────────────────────────────────────────────────
-- 成员只能看自己所在群的成员清单
drop policy if exists wsm_select_member on public.workspace_members;
create policy wsm_select_member on public.workspace_members for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
-- owner 拉人（只能拉进自己 own 的群）；建群第一行（owner 自己）也走这条
drop policy if exists wsm_insert_owner on public.workspace_members;
create policy wsm_insert_owner on public.workspace_members for insert to authenticated
  with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));
-- owner 踢人，或成员删自己那行（退群）。owner 行由 ws_delete_owner 级联走
drop policy if exists wsm_delete on public.workspace_members;
create policy wsm_delete on public.workspace_members for delete to authenticated
  using (uid = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));

-- ── workspace_connectors RLS ──────────────────────────────────────────────
-- 成员只能看自己所在群的连接器清单
drop policy if exists wsc_select_member on public.workspace_connectors;
create policy wsc_select_member on public.workspace_connectors for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
-- host 本人可以在自己所在的群里添加服务（upsert）
drop policy if exists wsc_upsert_host on public.workspace_connectors;
create policy wsc_upsert_host on public.workspace_connectors for insert to authenticated
  with check (host_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));
-- host 本人可以修改自己的那行（调整标签/权限清单）
drop policy if exists wsc_update_host on public.workspace_connectors;
create policy wsc_update_host on public.workspace_connectors for update to authenticated
  using (host_uid = auth.uid());
-- host 或群 owner 可以删掉这条接入（host 撤销接入，或 owner 踢掉 host 的服务）
drop policy if exists wsc_delete_host_or_owner on public.workspace_connectors;
create policy wsc_delete_host_or_owner on public.workspace_connectors for delete to authenticated
  using (host_uid = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()));

-- ── workspace_sessions RLS ────────────────────────────────────────────────
-- 成员只能看自己所在群发布的会话
drop policy if exists wss_select_member on public.workspace_sessions;
create policy wss_select_member on public.workspace_sessions for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));
-- 成员可以在自己所在的群里发布会话（自己是 publisher）
drop policy if exists wss_insert_publisher on public.workspace_sessions;
create policy wss_insert_publisher on public.workspace_sessions for insert to authenticated
  with check (publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));
-- 发布者本人可以改标题等元数据
drop policy if exists wss_update_publisher on public.workspace_sessions;
create policy wss_update_publisher on public.workspace_sessions for update to authenticated
  using (publisher_uid = auth.uid());
-- 发布者本人可以撤回会话（删掉这条记录）
drop policy if exists wss_delete_publisher on public.workspace_sessions;
create policy wss_delete_publisher on public.workspace_sessions for delete to authenticated
  using (publisher_uid = auth.uid());

-- ── storage.objects 包下载策略（workspace 新增）────────────────────────────
-- 0014 只对好友开；发布进工作区的包，同群成员也要能下——只对
-- workspace_sessions 里**指名**的那个包放行（不是发布者的全部包）
drop policy if exists session_packages_select_ws on storage.objects;
create policy session_packages_select_ws on storage.objects for select to authenticated
  using (
    bucket_id = 'session-packages'
    and exists (
      select 1 from public.workspace_sessions ws
      where ws.publisher_uid::text = (storage.foldername(name))[1]
        and ws.pkg_id = (storage.foldername(name))[2]
        and public.is_ws_member(ws.workspace_id, auth.uid())
    )
  );
