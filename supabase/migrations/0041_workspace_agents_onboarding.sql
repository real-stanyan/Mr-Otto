-- 0041_workspace_agents_onboarding.sql —— 新建的智能体先开口，第一句回话写进职责（#1356 A2，spec §7.2）。幂等，重跑不炸。
--
-- 与 0021 / 0025 / 0040 同一约定：Supabase SQL editor / Management API 手动执行一次（那个端点只回
-- 最后一条语句的结果，逐条发）。**部署顺序：先跑这份、再部署 runtime**——runtime 抢这一格失败（列不存在）
-- 时当没抢到、只记一行日志，行为退回今天；手机插入时带着这一列而库里还没有（PGRST204）会不带它再插一次
-- （src/shared/agentAdmin.ts 的 createAgentChecked），那只就是一只普通的智能体。
--
-- 判据是一格显式状态，不是推断（为什么不按「新私聊 + 职责为空」推断见 spec §7.2 / ADR-0319）：
--   'greet' : 手机「建一只」插入时写（wsa_insert_member 不管这一列）；
--   'role'  : runtime 建这只的**新**私聊时一条条件更新抢到它（'greet' → 'role'），抢到才替建的人落开场白；
--   null    : 私聊里人的第一句话到了（职责还空着就写成那句话的第一行），或手机「不建了」清掉；
--             存量的行、桌面与 create_agent 建的行一律是 null——它们的行为一个字不变。
--
-- **不新增任何策略**：手机写 'greet' / 清回 null 走现有的 wsa_insert_member / wsa_update_owner_or_creator
-- （建的人或所有者才改得动），runtime 用 service key。

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspace_agents' and column_name = 'onboarding'
  ) then
    alter table public.workspace_agents add column onboarding text;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'workspace_agents_onboarding_check'
  ) then
    alter table public.workspace_agents
      add constraint workspace_agents_onboarding_check check (onboarding in ('greet', 'role'));
  end if;
end $$;
