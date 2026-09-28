-- 0043_chat_guests.sql —— 主场群里的客人（#1393，ADR-0325）
--
-- 你的智能体和朋友可以在同一个群里了。一个「有真人的群」= 群主个人主场（workspaces.kind='home'）
-- 里的一条群聊，多一份**真人名单**（群主之外的人，叫「客人」）。智能体仍是群主的那几只、在群主的
-- 云电脑上干活、花群主的额度。
--
-- 在籍今天只有工作区一级（is_ws_member），而主场的 workspace_members 只收群主本人（0037）——
-- 客人不是工作区成员，所以这份迁移加的是**按会话**的在籍：
--   ① 一张投影表 workspace_session_members（会话 × 客人）。**事实在 VPS 上那份日志里**
--      （chat_roster_changed.humans）；这张表存在的理由是 RLS 与「我被拉进了哪几个群」这条查询。
--      写方只有 runtime（service key），先落日志再写表，启动对账时日志赢（同 agent_ids 那一列）。
--   ② 客人读得到自己在的那几条会话、那几条会话的客人名单、自己被 @ 的那几行。
--   ③ 智能体只经一个 RPC 读：**这条群里那几只**的名字 / 职责 / 头像——不给提示词、不给群主别的智能体。
--
-- 可重复执行。先跑这份，再部署 runtime（协议 21），再发客户端。这份没跑时：runtime 写投影表失败只记一笔
-- （日志照旧是事实，群照常能聊），客人那一侧找不到这个群——少一个入口，不是一个错误。

-- ① 投影表 ------------------------------------------------------------------
create table if not exists public.workspace_session_members (
  session_id uuid not null references public.workspace_sessions(id) on delete cascade,
  uid        uuid not null references auth.users(id) on delete cascade,
  -- 谁拉进来的（群主，或拉自己朋友进来的另一位客人）。只作记录：权限判据在 runtime，不读这一格
  added_by   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (session_id, uid)
);
-- 「我在哪几个群」按 uid 找
create index if not exists workspace_session_members_uid_idx on public.workspace_session_members (uid);

alter table public.workspace_session_members enable row level security;

-- 会话级在籍。security definer：策略里直接查这张表会被它自己的 RLS 按「查询者」过滤（同 is_ws_member）。
-- 参数收 text：workspace_mentions.session_id 是 text（0030），拿 uuid 去 cast 的话一行脏数据就能让整条
-- 查询抛错；这边把 uuid 那一列转成 text 去比，只会「对不上」不会炸
create or replace function public.is_session_guest(sid text, u uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from workspace_session_members where session_id::text = sid and uid = u) $$;

-- ② 读的权限 ------------------------------------------------------------------
-- 客人读得到自己在的那几条会话（群名、名单投影、最近一句）。与 wss_select_member 是 or 的关系
drop policy if exists wss_select_guest on public.workspace_sessions;
create policy wss_select_guest on public.workspace_sessions for select to authenticated
  using (public.is_session_guest(id::text, auth.uid()));

-- 客人名单：这条群里的客人、以及这条会话所在工作区的成员（群主）都读得到整份
drop policy if exists wssm_select on public.workspace_session_members;
create policy wssm_select on public.workspace_session_members for select to authenticated
  using (
    public.is_session_guest(session_id::text, auth.uid())
    or exists (
      select 1 from public.workspace_sessions s
      where s.id = session_id and public.is_ws_member(s.workspace_id, auth.uid())
    )
  );
-- **不给 insert / update / delete**：写方只有 runtime。给客户端 insert 等于让任何人把自己塞进别人的群；
-- 退群走 chat_update 帧（runtime 先落日志再删这一行），不直接删表

-- 被 @ 的客人读得到自己那几行（通知正文与角标）。update 那条（0030 的 wsmn_update_self）本来就只看 uid
drop policy if exists wsmn_select_self on public.workspace_mentions;
create policy wsmn_select_self on public.workspace_mentions for select to authenticated
  using (
    uid = auth.uid()
    and (public.is_ws_member(workspace_id, auth.uid()) or public.is_session_guest(session_id, auth.uid()))
  );

-- ③ 这条群里的智能体 ---------------------------------------------------------
-- 客人读不了 workspace_agents（那张表要在籍）。这个函数只回**这条群名单里**那几只、只回画头像和
-- @ 选人要用的四列。提示词（instructions）、型号、连接器授权一格都不给——那些是群主的东西
create or replace function public.guest_chat_agents(p_session uuid)
returns table (agent_id text, name text, description text, avatar_slot smallint)
language sql stable security definer set search_path = public as $$
  select a.agent_id, a.name, a.description, a.avatar_slot
  from workspace_sessions s
  join workspace_agents a on a.workspace_id = s.workspace_id and a.agent_id = any (s.agent_ids)
  where s.id = p_session
    and (is_session_guest(p_session::text, auth.uid()) or is_ws_member(s.workspace_id, auth.uid()))
  order by a.created_at
$$;
revoke all on function public.guest_chat_agents(uuid) from public;
grant execute on function public.guest_chat_agents(uuid) to authenticated;
