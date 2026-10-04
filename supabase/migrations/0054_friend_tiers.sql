-- 0054 好友三档权限（#1494，ADR-0350）：仅聊天 chat / 可带智能体 agents / 全部开放 full。
-- **每人一边、生效取两边的最小值**（维护者拍板）：friendships 加两列 requester_tier / addressee_tier，
-- 哪一列是「我给 TA 的」看这一行里我是请求方还是被请求方。幂等，重跑不炸。同 0053 的约定：Supabase SQL editor /
-- Management API 手动执行一次（逐条发）。**部署顺序：先跑这份、再部署 runtime、再发手机热更新**——反过来
-- runtime 的 select 带着两列查会报 42703（它会退回按默认档算，不炸，但档位形同虚设）。**还没有在生产执行**。

-- ① 两列，默认 'agents'（第 2 档）：0054 之前已经是朋友的那些行按这一档算，不打断已经在用私密车道 / 来电的人；
--    老客户端插进来的新请求也落这一档。新客户端发请求时自己选（默认 chat）
alter table public.friendships add column if not exists requester_tier text not null default 'agents';
alter table public.friendships add column if not exists addressee_tier text not null default 'agents';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'friendships_requester_tier_check') then
    alter table public.friendships add constraint friendships_requester_tier_check check (requester_tier in ('chat', 'agents', 'full'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'friendships_addressee_tier_check') then
    alter table public.friendships add constraint friendships_addressee_tier_check check (addressee_tier in ('chat', 'agents', 'full'));
  end if;
end $$;

-- ② 发请求时只能定**自己那一边**：addressee_tier 必须是默认值（接受方接受时自己选）。老客户端不带这两列，
--    默认值正好过闸；新客户端给对方那一边塞 'full' 过不了
drop policy if exists "friendships_insert_requester" on public.friendships;
create policy "friendships_insert_requester" on public.friendships
  for insert to authenticated
  with check (auth.uid() = requester and status = 'pending' and addressee_tier = 'agents');

-- ③ 已接受之后双方都能改——但只能改自己那一边（触发器 ④ 钉死）。接受那一刻（pending→accepted）走 0001 的
--    friendships_accept_addressee，顺手带上 addressee_tier 也行：列级 grant 放开这两列
drop policy if exists "friendships_tier_parties" on public.friendships;
create policy "friendships_tier_parties" on public.friendships
  for update to authenticated
  using (status = 'accepted' and (auth.uid() = requester or auth.uid() = addressee))
  with check (status = 'accepted' and (auth.uid() = requester or auth.uid() = addressee));
grant update (requester_tier, addressee_tier) on public.friendships to authenticated;

-- ④ 自己只能改自己那一边：RLS 的 with check 看不到旧行，列级 grant 分不出「谁」，所以是触发器。
--    service role（runtime）没有 auth.uid()，不受限
create or replace function public.friendships_guard_tiers()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if auth.uid() = old.requester and new.addressee_tier is distinct from old.addressee_tier then
    raise exception 'friend tier: only the other party may change addressee_tier';
  end if;
  if auth.uid() = old.addressee and new.requester_tier is distinct from old.requester_tier then
    raise exception 'friend tier: only the other party may change requester_tier';
  end if;
  return new;
end $$;
drop trigger if exists friendships_guard_tiers on public.friendships;
create trigger friendships_guard_tiers before update on public.friendships
  for each row execute function public.friendships_guard_tiers();

-- ⑤ 朋友那一侧「对方带了几只」的在场提示（0053）也按档位走：仅聊天的关系里不该再看到对方带了智能体
create or replace function public.pair_presence(p_owner uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((
    select cardinality(s.agent_ids)
    from workspace_sessions s
    join workspaces w on w.id = s.workspace_id
    where w.kind = 'home'
      and w.owner_uid = p_owner
      and s.chat_kind = 'pair'
      and s.facing = 'self'
      and s.peer_uid = auth.uid()
      and exists (
        select 1 from friendships f
        where f.status = 'accepted'
          and ((f.requester = p_owner and f.addressee = auth.uid()) or (f.requester = auth.uid() and f.addressee = p_owner))
          and f.requester_tier <> 'chat' and f.addressee_tier <> 'chat'
      )
    limit 1
  ), 0)
$$;
revoke all on function public.pair_presence(uuid) from public;
revoke all on function public.pair_presence(uuid) from anon;
grant execute on function public.pair_presence(uuid) to authenticated;
