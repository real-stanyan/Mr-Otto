-- 0046_push_device_token_check.sql —— 修 0045 里推送登记那条编译不过的正则（#1418）。
-- 0045 的 register_push_device 写的是 `p_token !~ '^[0-9a-fA-F]{16,256}$'`。Postgres 正则的重复次数
-- 上限是 255，`{16,256}` 让整条正则编译失败：每一次登记都抛 2201B「invalid repetition count(s)」，
-- 令牌从没进过库，智能体的回电一通都打不出去。create function 不编译函数体里的正则，所以 0045 本身跑得成功；
-- 无登录态的冒烟被排在前面的 `not signed in` 先挡住，也没碰到这一行。
--
-- 修法：字符集与长度分开判，语义与 0045 想写的一样（16～256 个十六进制字符）。其余一字不改。
-- 可重复执行（create or replace + 重发 revoke/grant）。

create or replace function public.register_push_device(p_token text, p_bundle text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_token is null or p_token !~ '^[0-9a-fA-F]+$' or length(p_token) not between 16 and 256 then
    raise exception 'bad token';
  end if;
  if p_bundle is null or length(p_bundle) = 0 or length(p_bundle) > 200 then raise exception 'bad bundle'; end if;
  delete from push_devices where token = p_token and user_id <> auth.uid();
  insert into push_devices (token, user_id, platform, bundle_id, apns_env, updated_at)
  values (p_token, auth.uid(), 'ios', p_bundle, null, now())
  on conflict (token) do update set bundle_id = excluded.bundle_id, updated_at = now();
end $$;
revoke all on function public.register_push_device(text, text) from public;
grant execute on function public.register_push_device(text, text) to authenticated;
