-- 0044_agent_activity.sql —— 每只智能体此刻在干嘛（#1282，spec docs/superpowers/specs/2026-09-28-agent-status-design.md §3.1）。
-- 幂等，重跑不炸。与 0030 / 0040 同一约定：Supabase SQL editor / Management API 手动执行一次（那个端点
-- 只回最后一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime**——反过来 runtime 每条会话
-- 记一行「表不存在」，列表照旧静止，不出别的事。
--
-- 为什么要一张新表：聊天页外面拿不到「谁在跑」（手机同一时刻只连一条云会话），列表只能画静止的脸。
-- 这张表是 runtime 手上那份日志的**投影**（判据 src/shared/agentActivity.ts，runtime 写库与手机聊天页
-- 现算共用一份）。整表丢掉也没关系：daemon 重启时各会话按日志重新写回来。
--
-- 一行 = 一条会话里的一只智能体。闲下来写 'idle'，**不删行**：Realtime 对 DELETE 不查 RLS，会把主键推给
-- 所有订阅者（客户端也只订 INSERT / UPDATE）。会话删了，这几行跟着级联删。
-- state 不加 CHECK：以后 runtime 多一档状态时，旧手机把认不出的值当「不知道」，库不用跟着改。
--
-- 写方只有 runtime（service key，绕过 RLS）。**不给 authenticated 任何写策略**：给了就是让任何在籍成员
-- 伪造「某只智能体正在等你审批」。
--
-- since : 进入这个状态的时刻
-- beat  : 最后一次心跳。此刻在进行的几档每 60 秒补一次，客户端 3 分钟没收到就当「不知道」

create table if not exists public.agent_activity (
  session_id   uuid not null references public.workspace_sessions(id) on delete cascade,
  agent_id     text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  state        text not null,
  since        timestamptz not null,
  beat         timestamptz not null,
  primary key (session_id, agent_id)
);

alter table public.agent_activity enable row level security;

-- 读：这个工作区的在籍成员，或这条群的客人（0043）。与 workspace_sessions 那两条读策略同一个范围
drop policy if exists aa_select on public.agent_activity;
create policy aa_select on public.agent_activity for select to authenticated
  using (public.is_ws_member(workspace_id, auth.uid()) or public.is_session_guest(session_id::text, auth.uid()));

-- Realtime：进 publication 才有 postgres_changes 可推（RLS 照常生效）。
-- workspace_sessions 顺带进来：列表里的最后一句、排序要跟着脸一起实时变（spec §3.1）。
-- 幂等：add table 对已在 publication 里的表会报 42710，用 exception 吞掉（同 0013 / 0030）
do $$
begin
  alter publication supabase_realtime add table public.agent_activity;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.workspace_sessions;
exception when duplicate_object then null;
end $$;
