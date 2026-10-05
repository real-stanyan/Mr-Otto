-- 0065_admin_lanes.sql —— 管理员车道（#1605，spec docs/superpowers/specs/2026-10-05-admin-lane-design.md §3.1）。幂等。
-- 原为 0064_admin_lanes.sql：与 #1606 的 0064_admin_dm_roster.sql 撞了号，两份都「先删后建」同一个约束、各自只带自己那一支，
-- 后跑的那份把先跑那份的一支抹掉（真机 2026-10-05：管理员车道 insert 撞 ws_sessions_chat_shape）。生产上跑过的是 dm_roster 那份，
-- 它留 0064；这份改号 0065，并且**两支都带**——跑完这一份，dm 的「admin 打头」与 admins 都在。
-- 同 0053 / 0056 的约定：Supabase SQL editor 手动执行一次。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**。
--
-- chat_kind 多一支 'admins'：每家主场对每位朋友一条，名单固定只有管理员（agent_ids = {admin}），peer_uid = 对面主人，
-- 对面主人以客人身份只读（workspace_session_members，同 pair 车道的 0043 那套）。两家各一条、靠桥互相镜像（智能体只能在
-- 自己主场跑，共用会话不存在）。

alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'dm' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and 6)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null)
  or (kind = 'cloud' and chat_kind = 'admins' and agent_ids = array['admin']::text[] and peer_uid is not null)
);

-- 一家对一位朋友只有一条管理员车道（同 0056 的 pair 索引形状）
create unique index if not exists ws_sessions_one_admins_per_peer
  on public.workspace_sessions (workspace_id, peer_uid)
  where chat_kind = 'admins';

-- 顺手（同一次真机排查发现）：任务投影表的 id 是 uuid，而任务 id 是 `t_<8 位十六进制>`（taskTools 的 newId）——
-- 0061 跑完以后每一次投影写入都被 22P02 拒掉（「invalid input syntax for type uuid」），状态行从没亮过。
-- 表里一行都写不进，所以改类型不丢数据；parent_id 的外键先拆再建。
alter table public.tasks drop constraint if exists tasks_parent_id_fkey;
alter table public.tasks alter column id type text using id::text;
alter table public.tasks alter column parent_id type text using parent_id::text;
alter table public.tasks add constraint tasks_parent_id_fkey foreign key (parent_id) references public.tasks(id) on delete cascade;
