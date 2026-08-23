-- migration 0008 的真库一致性校验(工作区在场的两列 + 它们借用的读写权限)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法:
--   ssh -p 2222 stan@<vps> "docker exec -i otto-db-1 psql -U postgres" < supabase/checks/0008_workspace_presence.check.sql
--
-- 0008 只有两行 `add column if not exists`，看着不需要校验——需要校验的不是那两行，
-- 是它头注里那句「写权限沿用 0001 的 profiles_update_self，读权限沿用既有的 select
-- policy」。列是新加的，policy 是旧的，两者之间没有任何东西保证它们对得上：
-- profiles 上若哪天多出一条列级 grant 或换了 policy，分支在场会静默变成
-- 「谁都能改我在哪根分支」或「谁都读不到好友的分支」，而客户端对两种都有退化路径
-- (PGRST204/42703 → 旧形状)，坏了也不报错。这份校验就是把那句注释变成可执行的断言。
begin;
do $$
declare
  u1 uuid := gen_random_uuid();  -- 本人
  u2 uuid := gen_random_uuid();  -- 好友(读得到 u1 的分支，但改不动)
  v_key text; v_branch text;
  v_nullable text;
begin
  -- ── 形状 ──────────────────────────────────────────────────────
  select is_nullable into v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name = 'repo_key';
  if v_nullable is null then raise exception 'FAIL profiles.repo_key 不在，好友分支在场没有落点'; end if;
  -- 可空是硬要求:不在仓库里的会话写 null，非空约束会让整拍心跳失败、在线点陪葬
  if v_nullable <> 'YES' then raise exception 'FAIL profiles.repo_key 竟然非空'; end if;

  select is_nullable into v_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name = 'repo_branch';
  if v_nullable is null then raise exception 'FAIL profiles.repo_branch 不在'; end if;
  if v_nullable <> 'YES' then raise exception 'FAIL profiles.repo_branch 竟然非空(detached 要写 null)'; end if;
  raise notice 'PASS repo_key / repo_branch 都在，且都可空';

  -- ── 造数据:两个互为好友的账号 ────────────────────────────────
  insert into auth.users (id, email) values (u1, 'ws1@example.com'), (u2, 'ws2@example.com');
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted');

  -- ── 写:本人可写自己的两列(profiles_update_self) ───────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  update public.profiles
     set last_seen_at = now(), repo_key = 'a1b2c3d4e5f60718', repo_branch = 'main'
   where id = u1;
  select repo_key, repo_branch into v_key, v_branch from public.profiles where id = u1;
  if v_key is distinct from 'a1b2c3d4e5f60718' then raise exception 'FAIL 本人写不了自己的 repo_key'; end if;
  if v_branch is distinct from 'main' then raise exception 'FAIL 本人写不了自己的 repo_branch'; end if;
  raise notice 'PASS 本人可随心跳写自己的仓库/分支';

  -- detached HEAD:分支写 null，不该被任何约束挡下
  update public.profiles set repo_branch = null where id = u1;
  if (select repo_branch from public.profiles where id = u1) is not null
  then raise exception 'FAIL detached 的 null 分支没写进去'; end if;
  raise notice 'PASS detached 可写 null 分支';
  update public.profiles set repo_branch = 'feat/x' where id = u1;

  -- ── 写:改不动别人的(这两列没有自己的 policy，全靠 profiles_update_self) ──
  update public.profiles set repo_key = 'deadbeefdeadbeef', repo_branch = 'evil' where id = u2;
  if (select repo_key from public.profiles where id = u2) is not null
  then raise exception 'FAIL 竟然改得动别人的 repo_key'; end if;
  raise notice 'PASS 改不动别人的仓库/分支';

  -- ── 读:好友读得到对方的两列(profiles_select_authenticated) ────
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select repo_key, repo_branch into v_key, v_branch from public.profiles where id = u1;
  if v_key is distinct from 'a1b2c3d4e5f60718' then raise exception 'FAIL 好友读不到对方的 repo_key，徽章永远是空的'; end if;
  if v_branch is distinct from 'feat/x' then raise exception 'FAIL 好友读不到对方的 repo_branch'; end if;
  raise notice 'PASS 好友读得到对方的仓库/分支';

  reset role;
  raise notice '=== 全部通过 ===';
end $$;
rollback;
