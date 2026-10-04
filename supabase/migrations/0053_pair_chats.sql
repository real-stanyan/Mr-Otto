-- 0053 好友私聊里带上自己的智能体（#1461 P1，ADR-0343，方案 B「两条车道」）：私密车道。
-- 人和人的私聊仍是 messages 表，一行不迁；我带进来的智能体住在**我主场里**一条与这位朋友配对的会话里
-- （chat_kind = 'pair'），只有我看得到（主场的工作区成员只有我，车道不收客人——朋友在服务端没有任何读取路径）。
-- 幂等，重跑不炸。同 0044 的约定：Supabase SQL editor / Management API 手动执行一次（逐条发）。
-- **部署顺序：先跑这份、再部署 runtime（协议 23）、再发桌面版 + 手机包**——反过来 runtime 建车道时
-- CHECK 与唯一索引都不在，insert 直接被 ws_sessions_chat_shape 拒掉。**还没有在生产执行**。

-- ① 朝向一列。P1 只建 'self'；'both'（两人都看得到、都能 @ 的共享车道，复用 0043 的客人那一套）是 P2
alter table public.workspace_sessions add column if not exists facing text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ws_sessions_facing_check') then
    alter table public.workspace_sessions add constraint ws_sessions_facing_check check (facing is null or facing in ('self', 'both'));
  end if;
end $$;

-- ② 约束名沿用 0037 / 0048 的 ws_sessions_chat_shape：先删后建，前四支与 0048 逐字相同，只多 pair 一支。
-- pair 的智能体名单下限 0（带走最后一只是合法终局，同 group）、上限 6（同 group 的 CHAT_GROUP_MAX）
alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null)
);

-- ③ 同一对 (主场, 朋友, 朝向) 只有一条：两台设备同时第一次「带上」时落进同一条车道（runtime 先查 + 接住 23505）
create unique index if not exists ws_sessions_one_pair_per_peer
  on public.workspace_sessions (workspace_id, peer_uid, facing)
  where chat_kind = 'pair';

-- ④ 朋友那一侧的在场提示（维护者拍板第 3 条：告诉，只显示存在、不显示内容）。
-- 只回一个数：p_owner 主场里、与调用者配对的那条**私密**车道里此刻有几只智能体。名字、职责、内容一格都不给。
-- security definer：朋友对那一行没有任何读权限（这正是私密的定义），只能经这个函数拿到一个计数。
-- 两道闸：调用者就是那条车道配对的朋友（peer_uid = auth.uid()），且两人此刻仍是已接受的好友——
-- 删了好友的人不该再看到「对方带了几只」。没有车道 / 不是朋友一律回 0（「没有」与「不许问」不分，不泄露存在性）
create or replace function public.pair_presence(p_owner uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((
    select cardinality(s.agent_ids)
    from workspace_sessions s
    join workspaces w on w.id = s.workspace_id
    where w.kind = 'home'
      and w.owner_uid = p_owner
      and s.chat_kind = 'pair'
      and s.facing = 'self'
      and s.peer_uid = auth.uid()
      and exists (
        select 1 from friendships f
        where f.status = 'accepted'
          and ((f.requester = p_owner and f.addressee = auth.uid()) or (f.requester = auth.uid() and f.addressee = p_owner))
      )
    limit 1
  ), 0)
$$;
revoke all on function public.pair_presence(uuid) from public;
grant execute on function public.pair_presence(uuid) to authenticated;
