-- migration 0007 的真库一致性校验(引导标记 + 触发器不再覆盖用户自设头像)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法:
--   ssh -p 2222 stan@<vps> "docker exec -i otto-db-1 psql -U postgres" < supabase/checks/0007_profile_onboarding.check.sql
begin;
do $$
declare
  u1 uuid := gen_random_uuid();  -- 走引导的新用户
  u2 uuid := gen_random_uuid();  -- 用来验"别人的引导标记改不动"
  v_avatar text; v_name text; v_onboarded timestamptz;
begin
  -- ── 形状 ──────────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'onboarded_at')
  then raise exception 'FAIL profiles.onboarded_at 不在，首登引导判不出新用户'; end if;
  raise notice 'PASS profiles.onboarded_at 在';

  -- ── 新注册:触发器建的行 onboarded_at 必须是 null ──────────────
  -- 这条是引导能不能弹出来的全部依据。若触发器给了默认值，新用户永远看不到引导
  insert into auth.users (id, email, raw_user_meta_data)
  values (u1, 'onb1@example.com', '{"name":"Provider 名","avatar_url":"https://provider/a.png"}'::jsonb);
  select onboarded_at, name, avatar_url into v_onboarded, v_name, v_avatar
    from public.profiles where id = u1;
  if v_onboarded is not null then raise exception 'FAIL 新注册的 onboarded_at 竟然有值 %', v_onboarded; end if;
  if v_name is distinct from 'Provider 名' then raise exception 'FAIL provider 名字没落到空位，实际 %', v_name; end if;
  if v_avatar is distinct from 'https://provider/a.png' then raise exception 'FAIL provider 头像没落到空位，实际 %', v_avatar; end if;
  raise notice 'PASS 新注册 onboarded_at 为 null，且 provider 值填进了空位';

  -- ── 用户自改 + 盖章(RLS 下,走 profiles_update_self) ───────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  update public.profiles
     set name = '我自己起的名', avatar_url = 'data:image/webp;base64,AAAA', onboarded_at = now()
   where id = u1;
  select onboarded_at, name into v_onboarded, v_name from public.profiles where id = u1;
  if v_onboarded is null then raise exception 'FAIL 本人盖不了自己的引导章'; end if;
  if v_name is distinct from '我自己起的名' then raise exception 'FAIL 本人改不了自己的名字'; end if;
  raise notice 'PASS 本人可改名字/头像并盖章';

  -- ── 核心回归:再次登录不得抹掉用户自设的头像 ───────────────────
  -- auth.users 在每次登录/刷新令牌时都会被 update，触发器随之开火。
  -- 0001 的写法是 avatar_url = excluded.avatar_url(无条件覆盖)，
  -- 那意味着"用户设的头像最多活到下次登录" —— 这条断言就是钉死它不再发生
  reset role;
  update auth.users
     set raw_user_meta_data = '{"name":"Provider 改名了","avatar_url":"https://provider/b.png"}'::jsonb
   where id = u1;
  select name, avatar_url into v_name, v_avatar from public.profiles where id = u1;
  if v_avatar is distinct from 'data:image/webp;base64,AAAA'
  then raise exception 'FAIL 用户自设头像被 provider 覆盖了，现在是 %', v_avatar; end if;
  if v_name is distinct from '我自己起的名'
  then raise exception 'FAIL 用户自设名字被 provider 覆盖了，现在是 %', v_name; end if;
  raise notice 'PASS 再次登录不覆盖用户自设的名字与头像';

  -- ── 空位仍然接受 provider 的值(别把规则收成"永不更新") ────────
  update public.profiles set avatar_url = '' where id = u1;
  update auth.users
     set raw_user_meta_data = '{"avatar_url":"https://provider/c.png"}'::jsonb
   where id = u1;
  if (select avatar_url from public.profiles where id = u1) is distinct from 'https://provider/c.png'
  then raise exception 'FAIL 头像清空后 provider 的值没能补上'; end if;
  raise notice 'PASS 头像为空时仍接受 provider 的值';

  -- ── 引导标记是自己的:改不动别人的 ─────────────────────────────
  insert into auth.users (id, email) values (u2, 'onb2@example.com');
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  update public.profiles set onboarded_at = now() where id = u2;
  if (select onboarded_at from public.profiles where id = u2) is not null
  then raise exception 'FAIL 竟然盖得动别人的引导章'; end if;
  raise notice 'PASS 改不动别人的 onboarded_at';

  reset role;
  raise notice '=== 全部通过 ===';
end $$;
rollback;
