-- 0050_presence.sql —— 好友在线状态（#1460，ADR-0339）。幂等，重跑不炸。同 0044 / 0049 的约定：Management API
-- 逐条发。**部署顺序：先跑这份、再发手机包**——反过来手机每 60 秒报一次心跳都报「函数不存在」，头像上不画点，不出别的事。
-- 已于 2026-10-04 经维护者同意在生产执行（Management API，逐条发，9 条）。跑前核过表与函数都不在；跑后核过：RLS 开着、
-- 只有 pr_select_friends 一条策略、进了 supabase_realtime、touch_presence 只授给 authenticated；原样重跑一遍全过。
--
-- 一人一行：online（App 在不在前台）+ seen_at（最后一次心跳）。在线的判据在 src/shared/presence.ts（心跳超过
-- 150 秒没更新也算不在线：被杀掉 / 断网时报不了 false）。
--
-- 只能经 touch_presence 写（客户端直接写的话，就能替别人报在线）。读：本人与已接受的好友——不是好友的人
-- 不该知道我此刻开没开着 App。进 realtime 让好友那边当场变色（RLS 对 INSERT / UPDATE 照常生效）。
-- **从不删行**（同 0044 / 0049：Realtime 对 DELETE 不查 RLS，会把主键推给所有订阅者）；profiles 删除时的级联是已知例外，
-- 今天没有删账号的流程。

create table if not exists public.presence (
  uid     uuid primary key references public.profiles(id) on delete cascade,
  online  boolean not null default false,
  seen_at timestamptz not null default now()
);
alter table public.presence enable row level security;

drop policy if exists pr_select_friends on public.presence;
create policy pr_select_friends on public.presence for select to authenticated
  using (
    uid = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(presence.uid, auth.uid())
        and greatest(f.requester, f.addressee) = greatest(presence.uid, auth.uid())
    )
  );

create or replace function public.touch_presence(p_online boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_online is null then raise exception 'bad args'; end if;
  insert into presence (uid, online, seen_at) values (auth.uid(), p_online, now())
  on conflict (uid) do update set online = excluded.online, seen_at = excluded.seen_at;
end $$;
revoke all on function public.touch_presence(boolean) from public;
revoke all on function public.touch_presence(boolean) from anon;
grant execute on function public.touch_presence(boolean) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence')
  then alter publication supabase_realtime add table public.presence; end if;
end $$;
