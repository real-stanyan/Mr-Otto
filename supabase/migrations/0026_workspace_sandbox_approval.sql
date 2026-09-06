-- 0026_workspace_sandbox_approval.sql —— 沙箱内工具（bash / write_file）要不要人批，工作区可配（#977，ADR-0231）。幂等。
-- 与 0024 同一约定：Supabase SQL editor / Management API 手动执行一次。
--
-- 为什么要这一列：云会话的审批门只看 tool.requiresApproval，runtime 没有桌面那套
-- approvalMode——每一次 bash / write_file 都要人批，而 drain 串行 + 10 分钟超时 = 一只
-- agent 跑 10 条命令冻群 10 次。容器本来就是隔离面（ADR-0199 / 0200：凭据不进容器）。
-- 默认 'ask' = 今天的行为一字不变，owner 在智能体 tab 翻成 'auto'；连接器（好友代理）
-- 与 create_agent 不受这一列影响，照旧要批。
-- owner 能改：0024 的 ws_update_owner 已经给了 owner 整表 UPDATE，这里不再动策略。

alter table public.workspaces
  add column if not exists sandbox_approval text not null default 'ask'
  check (sandbox_approval in ('ask', 'auto'));
