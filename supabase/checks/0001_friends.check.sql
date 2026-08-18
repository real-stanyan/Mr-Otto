-- migration 0001 的真库一致性校验(重点是 issue #62 修的 profiles 形状)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法:
--   ssh -p 2222 stan@<vps> "docker exec -i otto-db-1 psql -U postgres" < supabase/checks/0001_friends.check.sql
begin;
do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  u3 uuid := gen_random_uuid();
  v_email text; v_name text; caught text; n integer;
begin
  -- ── 形状 ──────────────────────────────────────────────────────
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name in ('id', 'email', 'name', 'avatar_url', 'updated_at');
  if n <> 5 then raise exception 'FAIL profiles 少列，只找到 %', n; end if;
  raise notice 'PASS profiles 五列齐全';

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name')
  then raise exception 'FAIL display_name 还在，改名没生效'; end if;
  raise notice 'PASS 旧列 display_name 已收敛成 name';

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name in ('name', 'avatar_url') and is_nullable = 'NO';
  if n <> 2 then raise exception 'FAIL name/avatar_url 应为 not null'; end if;
  raise notice 'PASS name/avatar_url 已钉成 not null';

  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'profiles_email_unique')
  then raise exception 'FAIL 缺 profiles_email_unique'; end if;
  raise notice 'PASS email 部分唯一索引在';

  -- ── 旧触发器必须已被接管 ──────────────────────────────────────
  if exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created')
  then raise exception 'FAIL 旧触发器 on_auth_user_created 还挂着，它写 display_name 会炸注册'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_upsert')
  then raise exception 'FAIL 新触发器 on_auth_user_upsert 不在'; end if;
  raise notice 'PASS 触发器已换成 on_auth_user_upsert';

  -- ── 注册路径:插 auth.users 应自动落 profiles，且带上 email ────
  insert into auth.users (id, email, raw_user_meta_data)
  values (u1, 'c1@example.com', '{"name": "Check One"}'::jsonb);
  select email, name into v_email, v_name from public.profiles where id = u1;
  if v_email is distinct from 'c1@example.com' then raise exception 'FAIL 注册没回填 email，实际 %', v_email; end if;
  if v_name is distinct from 'Check One' then raise exception 'FAIL 注册没取 meta 里的 name，实际 %', v_name; end if;
  raise notice 'PASS 新注册自动落 profiles(email=% name=%)', v_email, v_name;

  -- ── 邮箱精确搜索:好友系统唯一的找人入口 ──────────────────────
  if not exists (select 1 from public.profiles where email = 'c1@example.com')
  then raise exception 'FAIL 邮箱搜不到刚注册的人'; end if;
  raise notice 'PASS 邮箱精确搜索命中';

  -- 上面那条是超级用户身份查的,绕过了 RLS。渲染层是 authenticated 角色,
  -- select policy 缺了照样搜不到人,所以这条才是真正对应 #62 症状的断言
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  if not exists (select 1 from public.profiles where email = 'c1@example.com')
  then raise exception 'FAIL authenticated 角色下邮箱搜不到人(select policy 没生效)'; end if;
  reset role;
  raise notice 'PASS RLS 下(authenticated)邮箱搜索仍命中';

  -- ── 用户自己改过的名字不该被下一次 auth.users 更新覆盖 ────────
  update public.profiles set name = '我自己改的' where id = u1;
  update auth.users set raw_user_meta_data = '{"name": "Provider Renamed"}'::jsonb where id = u1;
  select name into v_name from public.profiles where id = u1;
  if v_name is distinct from '我自己改的' then raise exception 'FAIL 用户改的名字被覆盖成 %', v_name; end if;
  raise notice 'PASS 本地已有名字时不被 provider 覆盖';

  -- ── 无邮箱注册(手机/匿名):不该被 not null 或唯一冲突挡下 ──────
  insert into auth.users (id, email) values (u2, null), (u3, null);
  if (select count(*) from public.profiles where id in (u2, u3) and email is null) <> 2
  then raise exception 'FAIL 两个无邮箱用户没能共存'; end if;
  raise notice 'PASS 多个 email is null 可共存(部分唯一索引)';

  -- ── 邮箱仍然唯一 ──────────────────────────────────────────────
  begin
    update public.profiles set email = 'c1@example.com' where id = u2;
    raise exception 'FAIL 重复邮箱竟然写进去了';
  exception when unique_violation then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 重复邮箱被唯一索引挡下';
  end;

  -- ── friendships/messages 的外键指向 profiles，注册路径通了才有意义 ──
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted');
  insert into public.messages (sender, recipient, body) values (u1, u2, 'hi');
  raise notice 'PASS friendships/messages 外键可满足';

  raise notice '=== 全部通过 ===';
end $$;
rollback;
