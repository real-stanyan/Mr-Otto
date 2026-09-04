-- 0021_workspace_agents.sql —— 工作区里的智能体名单（#928）。幂等，重跑不炸。
--
-- 与 0015 同一约定：在 Supabase SQL editor 手动执行一次。
--
-- agent_id 与 name 拆开：name 是 @ 打的那个词、随时会改；agent_id 是记忆和
-- 用量归因的键。合成一个的话，改个名字等于换了一只 agent——记忆和账一起断，
-- 而且是安静地断。

create table if not exists public.workspace_agents (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id     text not null,
  name         text not null check (char_length(name) between 1 and 32),
  description  text not null default '',
  instructions text not null default '',
  models       text[] not null default '{}',
  tools        jsonb not null default '[]'::jsonb,   -- [] = 整池放行（workspace_connectors 同口径）
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, agent_id)
);
-- name 是 @ 的寻址依据，一个工作区里不许重名
create unique index if not exists workspace_agents_name
  on public.workspace_agents (workspace_id, name);

alter table public.workspace_agents enable row level security;

-- 成员可读
drop policy if exists wsa_select_member on public.workspace_agents;
create policy wsa_select_member on public.workspace_agents for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()));

-- 任何成员可建（对称于 workspace_connectors 的「贡献不是 owner 的特权」）
drop policy if exists wsa_insert_member on public.workspace_agents;
create policy wsa_insert_member on public.workspace_agents for insert to authenticated
  with check (created_by = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));

-- 建的人或 owner 可改（对称于 workspace_sessions 的发布者可改）
-- with check 补在籍：不许把自己的行改挂到别人的工作区（0015 审查发现过的同型越权路）
drop policy if exists wsa_update_owner_or_creator on public.workspace_agents;
create policy wsa_update_owner_or_creator on public.workspace_agents for update to authenticated
  using (created_by = auth.uid()
     or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid()))
  with check (public.is_ws_member(workspace_id, auth.uid()));

-- 建的人或 owner 可删，但**管理员那只谁都删不掉**——一个 agent 都没有的
-- 工作区 @ 不到任何人，是死局。同时要求删除者必须是当前成员
-- （比 0015_workspaces.sql 严 —— wsc_delete_host_or_owner / wss_delete_publisher 不查在籍，
-- 已开 issue #930 单独修。新表不该带着已知的松口子上线）
drop policy if exists wsa_delete_owner_or_creator on public.workspace_agents;
create policy wsa_delete_owner_or_creator on public.workspace_agents for delete to authenticated
  using (agent_id <> 'admin'
     and public.is_ws_member(workspace_id, auth.uid())
     and (created_by = auth.uid()
       or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid())));

-- agent_id / workspace_id / created_by 三列不可变。
-- 为什么必须是触发器而不是策略：RLS 的 USING 绑旧行、WITH CHECK 绑新行，
-- 各自只看单侧，表达不出"这一列不许变"。而 delete 策略里那句
-- agent_id <> 'admin' 只看当前值 —— 先改名再删就能绕过去（审阅实证的两步攻击）。
-- 顺带锁住 workspace_id 与 created_by：(workspace_id, agent_id) 是记忆与用量
-- 归因的键，搬家或换创建者都会让账断，而且是安静地断。
create or replace function public.workspace_agents_lock_identity() returns trigger
language plpgsql as $$
begin
  if new.agent_id <> old.agent_id
     or new.workspace_id <> old.workspace_id
     or new.created_by <> old.created_by then
    raise exception 'workspace_agents: agent_id / workspace_id / created_by 不可变（改名请删了重建）';
  end if;
  return new;
end $$;

drop trigger if exists workspace_agents_lock_identity on public.workspace_agents;
create trigger workspace_agents_lock_identity before update on public.workspace_agents
  for each row execute function public.workspace_agents_lock_identity();

-- 建工作区时种一只「管理员」。用触发器而不是让客户端插第二条：
-- 客户端插会有一段「群建好了但一只 agent 都没有」的窗口，而那个状态
-- 界面上和「建失败了」长得一样（#843 症状 1 的同一种病）
create or replace function public.seed_workspace_admin_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by)
  values (new.id, 'admin', '管理员', '这个工作区的默认智能体', '', new.owner_uid)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists workspaces_seed_admin on public.workspaces;
create trigger workspaces_seed_admin after insert on public.workspaces
  for each row execute function public.seed_workspace_admin_agent();
