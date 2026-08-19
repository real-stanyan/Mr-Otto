-- migration 0006 的真库一致性校验(心跳列 + game_invites 的 RLS/列级 grant)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法:
--   ssh -p 2222 stan@<vps> "docker exec -i otto-db-1 psql -U postgres" < supabase/checks/0006_presence_heartbeat_and_game_invites.check.sql
begin;
do $$
declare
  u1 uuid := gen_random_uuid();  -- 邀请人
  u2 uuid := gen_random_uuid();  -- 被邀请人(u1 的好友)
  u3 uuid := gen_random_uuid();  -- 陌生人
  t1 uuid;
  inv uuid;
  v_status text; v_table uuid; n integer;
begin
  -- ── 形状 ──────────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'last_seen_at')
  then raise exception 'FAIL profiles.last_seen_at 不在，心跳在线没有落点'; end if;
  raise notice 'PASS profiles.last_seen_at 在';

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'game_invites'
     and column_name in ('id','inviter','invitee','table_id','table_name','status','created_at','expires_at');
  if n <> 8 then raise exception 'FAIL game_invites 少列，只找到 %', n; end if;
  raise notice 'PASS game_invites 八列齐全';

  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'game_invites_pending_unique')
  then raise exception 'FAIL 缺 game_invites_pending_unique'; end if;
  raise notice 'PASS 待回应邀请的唯一索引在';

  -- ── 造数据:两个好友 + 一张桌 ─────────────────────────────────
  insert into auth.users (id, email) values (u1, 'inv1@example.com'), (u2, 'inv2@example.com'), (u3, 'inv3@example.com');
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted');
  insert into public.poker_tables (name, tier, small_blind, big_blind, min_buyin, max_buyin, created_by)
  values ('校验桌', 'flash', 25, 50, 1000, 5000, u1) returning id into t1;

  -- ── 心跳:本人可写自己的 last_seen_at(RLS 下) ─────────────────
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  update public.profiles set last_seen_at = now() where id = u1;
  if (select last_seen_at from public.profiles where id = u1) is null
  then raise exception 'FAIL 本人写不了自己的 last_seen_at'; end if;
  raise notice 'PASS authenticated 可写自己的心跳';

  -- 别人的心跳写不动(profiles_update_self)
  update public.profiles set last_seen_at = now() where id = u3;
  if (select last_seen_at from public.profiles where id = u3) is not null
  then raise exception 'FAIL 竟然改得动别人的 last_seen_at'; end if;
  raise notice 'PASS 改不动别人的心跳';

  -- ── 邀请:好友之间可发 ────────────────────────────────────────
  insert into public.game_invites (inviter, invitee, table_id, table_name)
  values (u1, u2, t1, '校验桌') returning id into inv;
  raise notice 'PASS 好友之间可发邀请';

  -- 同一对人 + 同一张桌,第二条 pending 应被唯一索引挡下
  begin
    insert into public.game_invites (inviter, invitee, table_id, table_name)
    values (u1, u2, t1, '校验桌');
    raise exception 'FAIL 重复 pending 邀请竟然写进去了';
  exception when unique_violation then
    raise notice 'PASS 重复 pending 邀请被挡下';
  end;

  -- 非好友不能发
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  begin
    insert into public.game_invites (inviter, invitee, table_id, table_name)
    values (u3, u2, t1, '校验桌');
    raise exception 'FAIL 陌生人竟然能发邀请';
  exception when insufficient_privilege then
    raise notice 'PASS 非好友发邀请被 RLS 挡下';
  end;

  -- 第三方看不见别人的邀请
  if exists (select 1 from public.game_invites where id = inv)
  then raise exception 'FAIL 陌生人看得见别人的邀请'; end if;
  raise notice 'PASS 邀请只对当事双方可见';

  -- ── 被邀请人:可接受,但改不动 table_id(列级 grant) ────────────
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  begin
    update public.game_invites set table_id = gen_random_uuid() where id = inv;
    raise exception 'FAIL 被邀请人竟然改得动 table_id';
  exception when insufficient_privilege then
    raise notice 'PASS table_id 被列级 grant 钉死';
  end;

  update public.game_invites set status = 'accepted' where id = inv;
  select status, table_id into v_status, v_table from public.game_invites where id = inv;
  if v_status is distinct from 'accepted' then raise exception 'FAIL 接受没生效，实际 %', v_status; end if;
  if v_table is distinct from t1 then raise exception 'FAIL table_id 被改了'; end if;
  raise notice 'PASS 被邀请人可 pending → accepted';

  -- 已 accepted 的行不能再改(using 只放行 pending)
  update public.game_invites set status = 'declined' where id = inv;
  if (select status from public.game_invites where id = inv) is distinct from 'accepted'
  then raise exception 'FAIL accepted 的邀请被改成别的状态了'; end if;
  raise notice 'PASS 终态邀请不可再改';

  reset role;
  raise notice '=== 全部通过 ===';
end $$;
rollback;
