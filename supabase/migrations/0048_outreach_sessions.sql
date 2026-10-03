-- 0048 外联会话（#1441）：派智能体给好友打电话。每对（智能体，好友）一条，住在主人的个人主场里。
-- 好友读这条会话走 0043 的 is_session_guest（runtime 写 workspace_session_members），这里不加策略。
-- 幂等，重跑不炸。
alter table public.workspace_sessions add column if not exists peer_uid uuid;

-- 约束名沿用 0037 的 ws_sessions_chat_shape：先删后建，三支原样、只多 outreach 一支
alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
);

-- 每对一条：同一只智能体对同一个好友的外联会话复用，不另起
create unique index if not exists ws_sessions_one_outreach_per_pair
  on public.workspace_sessions (workspace_id, (agent_ids[1]), peer_uid)
  where chat_kind = 'outreach';
