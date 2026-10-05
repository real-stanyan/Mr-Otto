-- 0064_admin_dm_roster.sql —— 管理员私聊可以多几只在场（#1606）。幂等。Supabase SQL editor 手动执行一次。
--
-- ADR-0367（#1571）让管理员把专员拉进**管理员那条私聊**：名单长了它还是「与管理员的私聊」（admin 恒排第一，
-- 0037 的唯一索引按 agent_ids[1] 认它）。日志早就这么记了，约束没跟上——dm 一支仍是恰好 1 只，于是
-- chat_update 写投影、启动对账补写 agent_ids 都被 ws_sessions_chat_shape 拒掉，没开着这条聊天的设备看到旧名单。
--
-- 约束名沿用 0037 / 0048 / 0053 的 ws_sessions_chat_shape：先删后建。dm 一支多一个「admin 打头、1~6 只」
-- （6 = CHAT_GROUP_MAX，同 group），其余四支与 0053 逐字相同。别的私聊照旧恰好 1 只（runtime 也拒改它们的名单）。
alter table public.workspace_sessions drop constraint if exists ws_sessions_chat_shape;
alter table public.workspace_sessions add constraint ws_sessions_chat_shape check (
  (chat_kind is null and cardinality(agent_ids) = 0)
  or (kind = 'cloud' and chat_kind = 'dm' and cardinality(agent_ids) = 1)
  or (kind = 'cloud' and chat_kind = 'dm' and agent_ids[1] = 'admin' and cardinality(agent_ids) between 1 and 6)
  or (kind = 'cloud' and chat_kind = 'group' and cardinality(agent_ids) between 0 and 6)
  or (kind = 'cloud' and chat_kind = 'outreach' and cardinality(agent_ids) = 1 and peer_uid is not null)
  or (kind = 'cloud' and chat_kind = 'pair' and cardinality(agent_ids) between 0 and 6 and peer_uid is not null and facing is not null)
);
