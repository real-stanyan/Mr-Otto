-- 好友系统第二期:心跳在线 + 牌局邀请(ADR-0027)
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。
--
-- 为什么要心跳:在线点原本只有 Realtime presence 一个来源,而线上 /realtime/v1
-- 经 Kong 返 503(issue #77)——presence 一断,好友列表全灰,"谁能陪我打牌"这个
-- 问题就没答案了。last_seen_at 是纯 REST 的第二来源:客户端每 30s 写自己一行,
-- 读的人按 90s 窗口判活。两个来源取并集,任一条路活着在线点就是准的。

-- ── profiles.last_seen_at:心跳列 ─────────────────────────────────
alter table public.profiles add column if not exists last_seen_at timestamptz;
-- 只按时间窗口过滤,索引给"最近活跃"这种扫描用
create index if not exists profiles_last_seen_idx on public.profiles (last_seen_at);
-- 写权限沿用 0001 的 profiles_update_self(本人可改自己的行),不需要新 policy

-- ── game_invites:约好友上牌桌 ───────────────────────────────────
-- 为什么是表不是 Realtime broadcast:broadcast 是瞬时的,对端 app 没开就永远收不到;
-- 邀请必须能落盘等人回来看(而且 #77 的教训是链路本身不可靠)。
create table if not exists public.game_invites (
  id uuid primary key default gen_random_uuid(),
  inviter uuid not null references public.profiles(id) on delete cascade,
  invitee uuid not null references public.profiles(id) on delete cascade,
  table_id uuid not null references public.poker_tables(id) on delete cascade,
  -- 桌名快照:邀请卡上要显示"来 XX 桌",而被邀请人不一定看得见那张桌的行
  -- (poker_tables 的 RLS 只放行自己建的/坐着的/好友建的)
  table_name text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  -- 过期是投影不是状态:到点了 UI 自己不显示,不需要定时任务去改 status
  expires_at timestamptz not null default now() + interval '10 minutes',
  check (inviter <> invitee)
);
-- 同一个人、同一张桌,同时只能挂一条待回应的邀请(防连点刷屏)
create unique index if not exists game_invites_pending_unique
  on public.game_invites (inviter, invitee, table_id) where status = 'pending';
-- 收件箱查询:按被邀请人 + 时间倒序拉
create index if not exists game_invites_invitee_idx
  on public.game_invites (invitee, id desc);
alter table public.game_invites enable row level security;

-- 意图:仅当事双方可见;只能以自己名义邀,且必须已是 accepted 好友;
-- 被邀请人接受/拒绝,邀请人撤回,都只能改 status
drop policy if exists "game_invites_select_parties" on public.game_invites;
create policy "game_invites_select_parties" on public.game_invites
  for select to authenticated
  using (auth.uid() = inviter or auth.uid() = invitee);

drop policy if exists "game_invites_insert_friend" on public.game_invites;
create policy "game_invites_insert_friend" on public.game_invites
  for insert to authenticated
  with check (
    auth.uid() = inviter
    and status = 'pending'
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(inviter, invitee)
        and greatest(f.requester, f.addressee) = greatest(inviter, invitee)
    )
  );

-- 被邀请人:pending → accepted / declined
drop policy if exists "game_invites_respond_invitee" on public.game_invites;
create policy "game_invites_respond_invitee" on public.game_invites
  for update to authenticated
  using (auth.uid() = invitee and status = 'pending')
  with check (status in ('accepted', 'declined'));

-- 邀请人:pending → cancelled(撤回)
drop policy if exists "game_invites_cancel_inviter" on public.game_invites;
create policy "game_invites_cancel_inviter" on public.game_invites
  for update to authenticated
  using (auth.uid() = inviter and status = 'pending')
  with check (status = 'cancelled');

-- with check 看不到旧行,列级 grant 才能钉死"只有 status 可改"——
-- 否则被邀请人可以把 table_id 改成任意一张桌(同 0001 对 friendships 的处理)
revoke update on public.game_invites from authenticated;
grant update (status) on public.game_invites to authenticated;

-- Realtime:进 publication 才有 postgres_changes 可推(RLS 照常生效)。
-- 推不动也不致命——客户端有轮询兜底(ADR-0027),这条只是快的那条路
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'game_invites')
  then alter publication supabase_realtime add table public.game_invites; end if;
end $$;
