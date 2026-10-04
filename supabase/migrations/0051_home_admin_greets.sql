-- 0051_home_admin_greets.sql —— 新用户的管理员先开口：自我介绍、引导建第一只专属智能体（#1465，ADR-0341）。幂等，重跑不炸。
-- 同 0041 / 0049 的约定：Management API 逐条发。**部署顺序：先跑这份、再部署 runtime、再发手机**——
-- 反过来 runtime 抢不到这一格（还是 null），新用户的管理员不开口，退回今天的行为，不出别的事。
--
-- 只改种子函数：新建的**主场**里那只管理员带 onboarding = 'greet'（与 0041「建一只」同一格同一个值）。
-- runtime 建它的新私聊时一条条件更新抢到它（'greet' → 'role'）才落开场白，落完把这一格清回 null
-- （管理员没有「第一句回话写成职责」那一步，它的职责是固定的）。
-- 存量主场与团队的管理员一个字不变（都是 null）：老用户早就有自己的智能体，不该冒出一段新手引导。

create or replace function public.seed_workspace_admin_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by, onboarding)
  values (new.id, 'admin', '管理员',
          case when new.kind = 'home' then '帮你建智能体，接没人对口的活' else '这个工作区的默认智能体' end,
          '', new.owner_uid,
          case when new.kind = 'home' then 'greet' else null end)
  on conflict do nothing;
  return new;
end $$;
