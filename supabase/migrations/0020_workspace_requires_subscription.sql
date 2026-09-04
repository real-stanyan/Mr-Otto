-- 0020_workspace_requires_subscription.sql —— 建工作区要一份活跃订阅
-- （issue #917，ADR-0217；维护者 2026-09-04 定的规则一）。幂等，重跑不炸。
--
-- 为什么闸门在**创建**这一侧而不是**参与**这一侧：同一批规则的第二条是
-- 「工作区走的都是创建者的订阅额度」（services/runtime/src/hostedRoute.ts 的
-- on-behalf-of 记的是 workspaces.owner_uid）。所以一个工作区的成员自己有没有
-- 订阅与这本账无关——拦成员等于把规则二废掉。这里只拦 insert：
--   · workspace_members 的策略不动：owner 拉人、成员退群照旧
--   · 已经存在的工作区不动：订阅过期不会让一个群消失（那是删数据，不是收权限）；
--     过期之后的后果由 runtime 承担——所有者没有活跃订阅时云会话拿不到平台
--     模型，落一条说得出口的 turn 失败（hostedRoute 的 blocked 分支）
--
-- 客户端那侧另有一道（src/renderer/src/lib/workspaceAccess.ts + NewWorkspaceDialog）。
-- 两道都要有：界面那道是为了**把话说清楚**（说明为什么、给一条去订阅的路），
-- 这一道是为了**真的拦住**——界面上的判据跑在用户的机器上。

-- 「这个人此刻有没有活跃订阅」。security definer + stable：与同一批策略里的
-- is_ws_member 同一副写法，免得日后换成查别人的订阅时撞上 subscription 的 RLS。
-- past_due / canceled 一律不算：判据与真正花钱那一层（hostedRoute 只认 active）
-- 保持一致，否则会放行一个建得出来、却跑不动任何 turn 的工作区
create or replace function public.has_active_subscription(u uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from subscription where user_id = u and status = 'active') $$;

-- 只有 owner 能建群（0015）+ owner 得有一份活跃订阅（本次新增）
drop policy if exists ws_insert_self on public.workspaces;
create policy ws_insert_self on public.workspaces for insert to authenticated
  with check (owner_uid = auth.uid() and public.has_active_subscription(auth.uid()));
