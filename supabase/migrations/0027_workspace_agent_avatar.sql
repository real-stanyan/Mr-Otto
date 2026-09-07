-- 0027_workspace_agent_avatar.sql —— 智能体头像可自选（#1007）。幂等。
-- 与 0024/0025/0026 同一约定：Supabase SQL editor / Management API 手动执行一次。
-- 已于 2026-09-07 经维护者确认后在生产执行（Management API；执行后核过：列在且可空、
-- 约束在、存量 3 行仍全为 null、写 3 再清回 null 通、写 -5 被约束拒）。**先跑迁移再合代码**：
-- 快照那条 select 现在点名要 avatar_slot，列不在的话整份工作区快照会炸（ADR-0223 的部署顺序）。
--
-- 这一条推翻 ADR-0229 里「不给 workspace_agents 加一列」那条决定。当时的理由是
-- 「头像是纯展示，派生比落库便宜一个量级，而且存量 agent 立刻有头像」——**前两条
-- 仍然成立**，所以派生留着当缺省（这一列可空，null = 照旧按 agent_id 哈希派生，
-- 存量行一行不改也一字不变）。被推翻的只是「不需要让人自己挑」这个前提，那是
-- 维护者的产品判断，不是技术结论。
--
-- 约束**不写死 13**：`avatar_slot >= 0` 而已。把内置头像的张数写进 DB 约束，
-- 哪天加第 14 张就要再跑一次迁移，而越界这件事渲染层本来就得兜（旧客户端读到
-- 一个它那一版没有的坑位）——判据放在够得着的那一层。

alter table public.workspace_agents
  add column if not exists avatar_slot smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'workspace_agents_avatar_slot_range'
       and conrelid = 'public.workspace_agents'::regclass
  ) then
    alter table public.workspace_agents
      add constraint workspace_agents_avatar_slot_range
      check (avatar_slot is null or avatar_slot >= 0);
  end if;
end $$;

comment on column public.workspace_agents.avatar_slot is
  '内置头像坑位（0 起）。null = 没挑过，按 agent_id 哈希派生（agentAvatarSlot.ts）。#1007';
