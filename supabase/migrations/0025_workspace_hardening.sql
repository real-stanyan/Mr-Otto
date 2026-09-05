-- 0025_workspace_hardening.sql —— 工作区多智能体自查第一批的 DB 兜底（ADR-0225，issue #957）。
--
-- **本迁移尚未在生产执行，只进仓，等维护者（stanyan）点头后手动在 Supabase SQL editor 跑一次**。
-- 与 0015/0021 同一约定：幂等，重跑不炸。
--
-- 两类改动：
-- 1) #930（issue #930，0021_workspace_agents.sql 文件头已经点名过这两条松口子）：
--    workspace_connectors / workspace_sessions 各有一条 delete 策略不查在籍——
--    退群/被踢之后那条行还删得掉，与 workspace_agents 那条严格版本不对称，
--    是「新表不该带着已知的松口子上线」这句话反过来欠的账。
--    · wsc_delete_host_or_owner：照 0015 原文（host_uid = auth.uid() or 该工作区 owner）
--      补 `is_ws_member`——host 已经退群/被踢的话，这条接入记录该由还在籍的 owner 收尾，
--      不在籍的 host 自己也删不动。
--    · wss_delete_publisher：**现行策略是 0016_cloud_sessions.sql:74-76 那一版**
--      （`publisher_uid = auth.uid() and kind = 'package'`），不是 0015 的原文——0016
--      的终审 I1 已经把它从「不查 kind」收紧成 `kind = 'package'` 白名单。这里只补
--      `is_ws_member`，**白名单原样保留**：写成 `kind <> 'cloud'` 黑名单等于把 0016
--      那次收紧退回去（将来多一个 kind 就自动获得删除权）。云会话行（kind='cloud'）的
--      出口是**归档**（sessionService.archive，见 services/runtime/），不是这条「发布者删行」
--      的路；云会话被人从这条策略删掉，runtime 那边的会话对象与订阅还活着，界面上会变成
--      一条查无此表的孤儿直播。
-- 2) workspace_agents 形状约束（B-I3 / B-I5 裁决，DB 兜底）：agent_id 与 name 的形状校验、
--    每工作区最多 32 只 agent 的硬上限——桌面表单与 create_agent 工具（ADR-0224）已经在
--    应用层挡过一轮，这里是"就算应用层的闸被绕过（直接打 REST/别的客户端）也吃不进去脏行"
--    的最后一道。

-- ── #930：两条 delete 策略补在籍 ───────────────────────────────────────────
drop policy if exists wsc_delete_host_or_owner on public.workspace_connectors;
create policy wsc_delete_host_or_owner on public.workspace_connectors for delete to authenticated
  using (public.is_ws_member(workspace_id, auth.uid())
     and (host_uid = auth.uid() or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_uid = auth.uid())));

drop policy if exists wss_delete_publisher on public.workspace_sessions;
create policy wss_delete_publisher on public.workspace_sessions for delete to authenticated
  using (kind = 'package' and publisher_uid = auth.uid() and public.is_ws_member(workspace_id, auth.uid()));

-- ── workspace_agents 形状约束（B-I3 / B-C1 的 DB 兜底）──────────────────────
-- agent_id 只能是种子管理员的字面量，或者建 agent 那条路（桌面表单 / create_agent 工具）
-- 生成的 `a_` + 12 位 hex；name/description 不许带换行——同 ADR-0224 决策 2 那条
-- 「审批卡逐行呈现，一个 \n 就能伪造出一张良性卡」的病，这里补的是数据库层面的最后一道。
alter table public.workspace_agents drop constraint if exists workspace_agents_agent_id_shape;
alter table public.workspace_agents add constraint workspace_agents_agent_id_shape
  check (agent_id = 'admin' or agent_id ~ '^a_[0-9a-f]{12}$');
alter table public.workspace_agents drop constraint if exists workspace_agents_no_newline;
alter table public.workspace_agents add constraint workspace_agents_no_newline
  check (name !~ '[\r\n]' and description !~ '[\r\n]');

-- ── 每工作区最多 32 只 agent（B-I5）──────────────────────────────────────────
-- 接力棒 + create_agent 工具理论上能无限造 agent（每条 turn 都能建一只再 @ 它）；
-- 上限是硬顶不是软提醒，触发器在 insert 之前挡，不给应用层留下"先插入再回滚"的窗口。
create or replace function public.workspace_agents_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.workspace_agents where workspace_id = new.workspace_id) >= 32 then
    raise exception 'workspace_agents: 一个工作区最多 32 只智能体';
  end if;
  return new;
end $$;

drop trigger if exists workspace_agents_cap on public.workspace_agents;
create trigger workspace_agents_cap before insert on public.workspace_agents
  for each row execute function public.workspace_agents_cap();
