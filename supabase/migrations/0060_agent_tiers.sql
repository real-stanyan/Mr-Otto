-- 0060_agent_tiers.sql —— 智能体分级（#1571，ADR-0364，spec docs/superpowers/specs/2026-10-05-agent-tiers-design.md §4）。
-- 幂等，重跑不炸。同 0049 / 0058 的约定：Supabase SQL editor 手动执行一次。
-- **部署顺序：先跑这份（与 0061）、再部署 runtime、再发手机热更新**——手机要写 tier / domain，列不在就 42703。
--
-- ⚠ 这份里有一句**不可逆的清除**（§3，维护者 2026-10-05 拍板「之前所有智能体清除，重新来过」）：
--    delete from workspace_agents where agent_id <> 'admin'
-- 连带 cascade：会话名单里的它们、定时任务（0058）、共有记录（0059）、状态行（0044）。生产跑之前在 #1571 里再确认一次。
--
-- 三列：
--   tier  0 管理员 / 1 专员 / 2 子工。admin ⇔ 0 用 check 钉死；一主场只有一只 0 用部分唯一索引钉死。
--   domain  职责域：清单键（travel / writing / …，见 src/shared/agentDomain.ts）、'admin'、或 'custom:<名字>'。
--           库里只管非空；形状在 shared 校验（清单会加，不写进 check）。
--   parent_agent_id  只有 tier=2 有，指同主场里的一只 tier=1（fk + check；上级是不是 1 由 shared 校验 + runtime 复核——
--           跨行的条件 check 写不了，触发器又多一处要维护的逻辑，这一条先放在应用层）。
-- 删 L1 连带删它的 L2（fk on delete cascade）。**还没有在生产执行**。

alter table public.workspace_agents add column if not exists tier smallint not null default 1;
alter table public.workspace_agents add column if not exists domain text not null default 'custom:未分配';
alter table public.workspace_agents add column if not exists parent_agent_id text;

alter table public.workspace_agents drop constraint if exists workspace_agents_tier_range;
alter table public.workspace_agents add constraint workspace_agents_tier_range check (tier in (0, 1, 2));

alter table public.workspace_agents drop constraint if exists workspace_agents_domain_nonempty;
alter table public.workspace_agents add constraint workspace_agents_domain_nonempty check (char_length(domain) between 1 and 40);

alter table public.workspace_agents drop constraint if exists workspace_agents_admin_tier;
alter table public.workspace_agents add constraint workspace_agents_admin_tier check ((agent_id = 'admin') = (tier = 0));

alter table public.workspace_agents drop constraint if exists workspace_agents_l2_parent;
alter table public.workspace_agents add constraint workspace_agents_l2_parent check ((tier = 2) = (parent_agent_id is not null));

alter table public.workspace_agents drop constraint if exists workspace_agents_parent_fk;
alter table public.workspace_agents add constraint workspace_agents_parent_fk
  foreign key (workspace_id, parent_agent_id) references public.workspace_agents (workspace_id, agent_id) on delete cascade;

create unique index if not exists workspace_agents_one_admin on public.workspace_agents (workspace_id) where tier = 0;

-- seed 的那只从此带等级：触发器改成插 tier=0 / domain='admin'（0021 的函数原样换体）
create or replace function public.seed_workspace_admin_agent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by, tier, domain)
  values (new.id, 'admin', '管理员', '这个工作区的默认智能体', '', new.owner_uid, 0, 'admin')
  on conflict do nothing;
  return new;
end $$;

-- 清除重来（§3，不可逆）
delete from public.workspace_agents where agent_id <> 'admin';
update public.workspace_agents set tier = 0, domain = 'admin', parent_agent_id = null where agent_id = 'admin';

-- 自愈的兜底：哪个主场没有管理员就补一只（与 0021 末尾那句同形，带上等级）
insert into public.workspace_agents (workspace_id, agent_id, name, description, instructions, created_by, tier, domain)
select w.id, 'admin', '管理员', '这个工作区的默认智能体', '', w.owner_uid, 0, 'admin' from public.workspaces w
on conflict do nothing;
