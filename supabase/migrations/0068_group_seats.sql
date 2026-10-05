-- 0068_group_seats.sql —— 群聊座位制（#1682，ADR-0376，spec docs/superpowers/specs/2026-10-05-group-seats-design.md §4）。幂等。
-- 同 0053 / 0056 / 0065 的约定：Supabase SQL editor 手动执行一次。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**。
--
-- 群里每个人都带着自己的管理员：管理员在**各自主场**里一群一条「座位」会话里干活（chat_kind = 'seat'，名单固定只有管理员），
-- 群那条会话只记人说的话与各家管理员的回话。座位按 (主场, 群) 找，所以多一列 group_session_id + 一条唯一索引。
-- 群的 agent_ids 在座位制里恒为 {}（group 那一支本来就允许 0 只）。
--
-- 约束是「先删后建」整条重写：带齐 0065 之后的每一支（dm 的 admin 打头、admins），再加 seat 那一支。

alter table public.workspace_sessions add column if not exists group_session_id uuid;

alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'dm' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and 6)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null)
  or (kind = 'cloud' and chat_kind = 'admins' and agent_ids = array['admin']::text[] and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'seat' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and 6 and group_session_id is not null)
);

-- 一个人在一个群里只有一个座位
create unique index if not exists ws_sessions_one_seat_per_group
  on public.workspace_sessions (workspace_id, group_session_id)
  where chat_kind = 'seat';

-- 群座位里定的提醒到点回那个座位跑（管理员的话经桥回到群里），不回私聊。缺席 = 那只的私聊（改动前的口径）
alter table public.agent_routines add column if not exists session_id uuid;
