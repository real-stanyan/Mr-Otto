-- 0022：usage_event 记下「这笔是哪只工作区 agent 烧的」（#946，spec §7，ADR-0221）
--
-- 同 0018 的约定：在 Supabase SQL editor 手动执行一次，幂等。
-- runtime 调网关时随 x-otto-on-behalf-of 一起带 x-otto-agent（agent_id，不是名字——
-- 名字随时会改，0021 把 agent_id 与 name 拆开正是为了这本账不断）。
-- 桌面直连的请求、0022 之前的旧行都是空串；聚合时空串单列成「未归因」。
alter table public.usage_event add column if not exists agent_id text not null default '';
comment on column public.usage_event.agent_id is
  '工作区 agent 的 agent_id（workspace_agents.agent_id）；空串 = 桌面直连或 0022 之前的旧行';
-- 设置页周用量表的查询形状：owner + 工作区 + 周窗，按 agent 聚合
--
-- usage_event 此刻只有个位数行，create index 的 SHARE 锁是毫秒级；
-- 表长到百万行级再建这种索引要改 concurrently，且不能在事务/SQL editor 里跑（psql 直连）。
create index if not exists usage_event_owner_workspace_created
  on public.usage_event (user_id, workspace_id, created_at desc);
