-- 0045_push_devices.sql —— 手机的推送令牌（#1411，spec §1.1，ADR-0331）。
-- 智能体办完事打电话回给你：runtime 直发 APNs，要知道你有哪几台手机、各自的令牌。
--
-- 写方两个：手机只走下面两个 RPC（登记 / 注销自己这台），runtime 用 service key 读令牌、回写发成功的
-- 那个环境、删掉失效的。不给 authenticated 任何写策略：直接 insert 的话，一台手机能把自己的令牌挂到
-- 别人名下（别人的来电响在它手上）。
-- 0011 的 devices.push_token 一直没人读写（那张表给已删掉的远程配对用），这里不复用。

create table if not exists public.push_devices (
  token      text primary key,                                          -- APNs 设备令牌（十六进制）
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   text not null default 'ios',
  bundle_id  text not null,
  apns_env   text,                                                      -- 'production' / 'sandbox'；null = 还没发成功过
  updated_at timestamptz not null default now()
);
-- runtime 按人取令牌
create index if not exists push_devices_user_idx on public.push_devices (user_id);

alter table public.push_devices enable row level security;
drop policy if exists pd_select_self on public.push_devices;
create policy pd_select_self on public.push_devices for select to authenticated using (user_id = auth.uid());

-- 登记这台手机：先删掉这个令牌挂在别人名下的那一行，再按令牌 upsert 到自己名下。同一台手机换了账号，
-- 令牌就归新账号——不删的话，上一个账号的来电会响在这台手机上，锁屏上还会显示对方那句话。
-- 新行的 apns_env 是空（下一次发的时候按「先生产、不认再沙盒」探）；同一个人重复登记不清它：
-- 同一个令牌的环境不会变
create or replace function public.register_push_device(p_token text, p_bundle text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]{16,256}$' then raise exception 'bad token'; end if;
  if p_bundle is null or length(p_bundle) = 0 or length(p_bundle) > 200 then raise exception 'bad bundle'; end if;
  delete from push_devices where token = p_token and user_id <> auth.uid();
  insert into push_devices (token, user_id, platform, bundle_id, apns_env, updated_at)
  values (p_token, auth.uid(), 'ios', p_bundle, null, now())
  on conflict (token) do update set bundle_id = excluded.bundle_id, updated_at = now();
end $$;
revoke all on function public.register_push_device(text, text) from public;
grant execute on function public.register_push_device(text, text) to authenticated;

-- 注销这台手机（退出登录前）：只删自己名下的这一行
create or replace function public.unregister_push_device(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from push_devices where token = p_token and user_id = auth.uid()
$$;
revoke all on function public.unregister_push_device(text) from public;
grant execute on function public.unregister_push_device(text) to authenticated;
