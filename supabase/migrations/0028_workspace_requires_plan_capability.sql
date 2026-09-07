-- 0028_workspace_requires_plan_capability.sql —— 建工作区从「有活跃订阅」收窄成
-- 「这一档带工作区」（issue #1024，ADR-0242；维护者在 #1022 的设计评审里定的：
-- Pro 和 Max 可以用工作区，Lite 不可以，Free 自然也不可以）。幂等，重跑不炸。
--
-- **判据放在 plan.capabilities 这一列，不写死档位 id**。「哪一档有什么」是 plan 表的
-- 事实（同 ADR-0203 对价格的规矩：改价改档不发版）。写死 in ('pro','max') 的话，
-- 这句话就有了两份——一份在这里，一份在客户端 workspaceAccess.ts——而它们只会
-- 在改档那天分家，且分家不报错：界面说能建，RLS 拒；或者反过来。
--
-- 存量：**一个都不受影响**。跑这条之前查过真库（#1024 的评论里贴了）——
-- Lite 订阅一条都没有过，两个已有工作区的主人一个是 max active、一个完全没订阅
-- （建于 0020 那道闸落地之前）。所以「存量 Lite 用户怎么办」这个问题在今天的
-- 数据上不存在，本迁移只收窄 insert，不碰任何已有行：
--   · 已经存在的工作区不动（同 0020 的理由：降档不该让一个群消失，那是删数据不是收权限）
--   · workspace_members 的策略不动：owner 拉人、成员退群照旧
--   · 参与不受档位限制（规则二：工作区走创建者的额度，成员自己订不订与这本账无关）
--
-- 客户端那侧另有一道（src/renderer/src/lib/workspaceAccess.ts）。两道都要有：
-- 界面那道是为了**把话说清楚**（为什么、以及一条去升档的路），这一道是为了
-- **真的拦住**——界面上的判据跑在用户的机器上。

-- ① 档位能力补一格。`||` 是浅合并：已有的 image/video 原样留着，重跑也不会翻。
--    addon 那一行不动 —— 它是一次性加购的单价，不是档位（/me 下发时就被滤掉）
update public.plan set capabilities = coalesce(capabilities, '{}'::jsonb) || '{"workspace": true}'::jsonb
  where id in ('pro', 'max');
update public.plan set capabilities = coalesce(capabilities, '{}'::jsonb) || '{"workspace": false}'::jsonb
  where id = 'lite';

-- ② 「这个人此刻建得了工作区吗」。security definer + stable，与 has_active_subscription
--    同一副写法（免得日后换成查别人时撞上 subscription / plan 的 RLS）。
--    另起一个名字而不是改 has_active_subscription：后者的名字说的是「有没有活跃订阅」，
--    让它顺带判能力就成了一个名不副实的函数，下一个人照名字用它会用错。
--    past_due / canceled 一律不算 —— 判据与真正花钱那一层（hostedRoute 只认 active）
--    保持一致，否则会放行一个建得出来、却跑不动任何 turn 的工作区
create or replace function public.can_create_workspace(u uuid) returns boolean
language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from subscription s
    join plan p on p.id = s.plan_id
    where s.user_id = u
      and s.status = 'active'
      and coalesce((p.capabilities ->> 'workspace')::boolean, false)
  )
$$;

-- ③ 只有 owner 能建群（0015）+ owner 的档位得带工作区（本次收窄 0020）
drop policy if exists ws_insert_self on public.workspaces;
create policy ws_insert_self on public.workspaces for insert to authenticated
  with check (owner_uid = auth.uid() and public.can_create_workspace(auth.uid()));

-- has_active_subscription 留着不删：本仓此刻没有别的调用方，但它是 0020 的历史记录，
-- 而 migration 文件是历史（supabase/README.md）。删函数是不可回滚的一步，收益为零
