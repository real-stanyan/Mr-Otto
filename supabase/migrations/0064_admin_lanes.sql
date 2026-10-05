-- 0064_admin_lanes.sql —— 管理员车道（#1605，spec docs/superpowers/specs/2026-10-05-admin-lane-design.md §3.1）。幂等。
-- 同 0053 / 0056 的约定：Supabase SQL editor 手动执行一次。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**。
--
-- chat_kind 多一支 'admins'：每家主场对每位朋友一条，名单固定只有管理员（agent_ids = {admin}），peer_uid = 对面主人，
-- 对面主人以客人身份只读（workspace_session_members，同 pair 车道的 0043 那套）。两家各一条、靠桥互相镜像（智能体只能在
-- 自己主场跑，共用会话不存在）。**还没有在生产执行**。

alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null)
  or (kind = 'cloud' and chat_kind = 'admins' and agent_ids = array['admin']::text[] and peer_uid is not null)
);

-- 一家对一位朋友只有一条管理员车道（同 0056 的 pair 索引形状）
create unique index if not exists ws_sessions_one_admins_per_peer
  on public.workspace_sessions (workspace_id, peer_uid)
  where chat_kind = 'admins';
