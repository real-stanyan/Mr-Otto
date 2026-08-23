-- migration 0009 的真库一致性校验(execute 权限收掉了，而注册链路没被收坏)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法(注意用 supabase_admin，不是 postgres —— postgres 没有 set role
-- supabase_auth_admin 的权限，而注册链路正是以那个角色跑的):
--   ssh -p 2222 stan@<vps> "docker exec -i otto-db-1 sh -lc 'PGPASSWORD=\$POSTGRES_PASSWORD psql -U supabase_admin -d postgres'" \
--     < supabase/checks/0009_revoke_trigger_function_execute.check.sql
--
-- 这份脚本要回答的是两个方向相反的问题，缺一个都不算验过:
--   ① 口子真的关上了吗(anon/authenticated/PUBLIC 都不能 execute)
--   ② 关上之后注册还活着吗(#62 炸过一次注册，不能靠推理)
begin;
do $$
declare
  u uuid := gen_random_uuid();
  v_name text; v_updated timestamptz; n integer;
begin
  -- ── ① 口子关上了 ─────────────────────────────────────────────
  if has_function_privilege('anon', 'public.handle_auth_user_upsert()', 'execute')
  then raise exception 'FAIL anon 仍能 execute handle_auth_user_upsert'; end if;
  if has_function_privilege('authenticated', 'public.handle_auth_user_upsert()', 'execute')
  then raise exception 'FAIL authenticated 仍能 execute handle_auth_user_upsert'; end if;
  raise notice 'PASS anon / authenticated 都不能 execute';

  -- PUBLIC 那一段单独查:acl 里的 `=X/postgres`(等号左边为空)就是它。
  -- 只查 anon/authenticated 会漏——PUBLIC 开着的话，将来任何新角色都自动带上
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'handle_auth_user_upsert'
     and array_to_string(p.proacl::text[], ' ') like '=%X/%';
  if n > 0 then raise exception 'FAIL PUBLIC 仍持有 execute（acl 里还有 =X/ 那一段）'; end if;
  raise notice 'PASS PUBLIC 也不持有 execute';

  -- public schema 下不该再有任何函数对 anon/authenticated 开着 execute。
  -- 这条是回归闸门:以后谁新建函数忘了 revoke，会在这里红，而不是在暴露面审计里
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prokind = 'f'
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  if n > 0 then raise exception 'FAIL public 下还有 % 个函数对 anon/authenticated 开着 execute', n; end if;
  raise notice 'PASS public schema 下没有任何函数对 anon/authenticated 开着 execute';

  -- ── ② 注册链路还活着 ─────────────────────────────────────────
  -- 角色必须是 supabase_auth_admin:GoTrue 就是以它写 auth.users 的。
  -- 用 postgres 跑这段等于没验——超级用户绕过权限检查，怎么改都不会红
  select count(*) into n from pg_roles where rolname = 'supabase_auth_admin';
  if n = 0 then raise exception 'FAIL supabase_auth_admin 角色不在，注册链路的角色和假设不符'; end if;

  set local role supabase_auth_admin;
  insert into auth.users (id, email, raw_user_meta_data)
  values (u, 'revoke-check@example.com', '{"name":"Check Revoke"}'::jsonb);
  reset role;
  select name into v_name from public.profiles where id = u;
  if v_name is distinct from 'Check Revoke'
  then raise exception 'FAIL 注册不再落 profiles（拿到 %），触发器被权限挡住了', v_name; end if;
  raise notice 'PASS 收掉权限后，注册仍然落 profiles';

  -- 更新路径:每次登录/刷新令牌都会更新 auth.users，触发器要照常开火
  set local role supabase_auth_admin;
  update auth.users set raw_user_meta_data = '{"name":"Ignored"}'::jsonb where id = u;
  reset role;
  select updated_at into v_updated from public.profiles where id = u;
  if v_updated is null then raise exception 'FAIL 登录刷新那条更新路径没触发'; end if;
  raise notice 'PASS 收掉权限后，登录刷新路径也照常';

  raise notice '=== 全部通过 ===';
end $$;
rollback;
