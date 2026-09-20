-- 0037_home_workspace_and_chats.sql —— 个人主场与聊天（#1280，spec §4）
--
-- 第三栏从「团队」改成「我的智能体」。智能体不另起一套租户：每个账号一个隐藏的
-- workspaces.kind='home'，容器 / 卷 / wiki / 连接器 / 计费 / Pro-Max 闸全部原样复用。
-- 一条聊天就是一条 kind='cloud' 的 workspace_sessions，多两列说清它是私聊还是群聊、里面站着谁。
--
-- 这两列是**投影不是事实**：事实是 VPS 上那份日志里的 chat_roster_changed。它们存在的唯一理由
-- 是桌面在没开着那条会话时也要画得出「群里有谁」（同 0035 的 title / participants）。
-- 写方只有 runtime（service key）：kind='cloud' 的行客户端本来就写不了（0016 的三条策略钉死在 package）。
--
-- 可重复执行。与客户端发版的先后：先跑这份，再部署 runtime，再发桌面。
-- 客户端读这三列一律走单独一条容错查询，这份没跑时团队照常能用。

-- ① 个人主场 ---------------------------------------------------------------
alter table public.workspaces
  add column if not exists kind text not null default 'team';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspaces_kind_check') then
    alter table public.workspaces add constraint workspaces_kind_check check (kind in ('team', 'home'));
  end if;
end $$;
-- 每个账号至多一个主场。两台设备同时建，后到的那台撞 23505，客户端回头重查
create unique index if not exists workspaces_one_home_per_owner
  on public.workspaces (owner_uid) where kind = 'home';

-- kind 不可变：全免审批（runtime 按 kind 判）与提示词里那句话（建会话时记进日志）说的是同一件事，
-- 这一列能改的话两处就会分家
create or replace function public.workspaces_lock_kind() returns trigger
language plpgsql as $$
begin
  if new.kind <> old.kind then
    raise exception 'workspaces: kind 不可变';
  end if;
  return new;
end $$;
drop trigger if exists workspaces_lock_kind on public.workspaces;
create trigger workspaces_lock_kind before update on public.workspaces
  for each row execute function public.workspaces_lock_kind();

-- 主场不收别人。owner 自己那一行照旧走这条策略（建主场的第二笔插入）
drop policy if exists wsm_insert_owner on public.workspace_members;
create policy wsm_insert_owner on public.workspace_members for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_uid = auth.uid()
      and (w.kind = 'team' or uid = auth.uid())));

-- 主场的种子管理员换一句职责：这一句不只给人看，群里没人被 @ 时派活就是按它挑人
create or replace function public.seed_workspace_admin_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by)
  values (new.id, 'admin', '管理员',
          case when new.kind = 'home' then '帮你建智能体，接没人对口的活' else '这个工作区的默认智能体' end,
          '', new.owner_uid)
  on conflict do nothing;
  return new;
end $$;

-- ② 聊天 = 云会话上的两列 ----------------------------------------------------
alter table public.workspace_sessions
  add column if not exists chat_kind text,
  add column if not exists agent_ids text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ws_sessions_chat_shape') then
    alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
      (chat_kind is null and cardinality(agent_ids) = 0)
      or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
      or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6));
  end if;
end $$;
-- 每只智能体至多一条私聊。**不带 archived**：聊天不许归档，只有删除（spec §6.6）
create unique index if not exists ws_sessions_one_dm_per_agent
  on public.workspace_sessions (workspace_id, (agent_ids[1])) where chat_kind = 'dm';
