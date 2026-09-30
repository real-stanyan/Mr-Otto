-- 0047_push_devices_kind.sql —— 推送令牌分两种：普通通知（alert）与 VoIP（voip）（#1428）。
-- 智能体回电改走 CallKit + VoIP 推送：普通通知 iOS 会路由到正在用的设备（开着 iPhone 镜像的 Mac、手表），
-- 保证不了在手机上响。VoIP 令牌由 PushKit 给，与普通推送令牌不是同一个，所以同一张表加一列说它是哪一种；
-- runtime 只给 voip 发。存量行都是普通令牌，默认值 'alert' 恰好对。
-- 可重复执行（if not exists / 约束先查再加 / drop if exists + create or replace + 重发 revoke/grant）。

alter table public.push_devices add column if not exists kind text not null default 'alert';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_devices_kind_check') then
    alter table public.push_devices add constraint push_devices_kind_check check (kind in ('alert', 'voip'));
  end if;
end $$;

-- 旧的两参版要先删：Postgres 按签名区分重载，不删就是两份函数并存，旧客户端调到的还是不写 kind 的那份
drop function if exists public.register_push_device(text, text);

create or replace function public.register_push_device(p_token text, p_bundle text, p_kind text default 'alert') returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]+$' or length(p_token) not between 16 and 256 then
    raise exception 'bad token';
  end if;
  if p_bundle is null or length(p_bundle) = 0 or length(p_bundle) > 200 then raise exception 'bad bundle'; end if;
  if p_kind is null or p_kind not in ('alert', 'voip') then raise exception 'bad kind'; end if;
  delete from push_devices where token = p_token and user_id <> auth.uid();
  insert into push_devices (token, user_id, platform, bundle_id, apns_env, kind, updated_at)
  values (p_token, auth.uid(), 'ios', p_bundle, null, p_kind, now())
  on conflict (token) do update set bundle_id = excluded.bundle_id, kind = excluded.kind, updated_at = now();
end $$;
revoke all on function public.register_push_device(text, text, text) from public;
grant execute on function public.register_push_device(text, text, text) to authenticated;
