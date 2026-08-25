-- migration 0006 心跳那一半的真库一致性校验(`profiles.last_seen_at` + 它借的 RLS)。
-- 整段包在事务里，最后 rollback，**不留痕**。
-- 跑法:
--   OTTO_DB_URL='postgresql://...' scripts/db-checks.sh 0006
--
-- 0006 另一半的 `game_invites` 已随 `0011_drop_poker.sql` 从库里消失，对应断言一起摘掉；
-- 心跳这一半跟牌局无关,它是在线点的第二来源(Realtime 断了走它),照旧要验。
begin;
do $$
declare
  u1 uuid := gen_random_uuid();  -- 本人
  u3 uuid := gen_random_uuid();  -- 陌生人
begin
  -- ── 形状 ──────────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'last_seen_at')
  then raise exception 'FAIL profiles.last_seen_at 不在，心跳在线没有落点'; end if;
  raise notice 'PASS profiles.last_seen_at 在';

  insert into auth.users (id, email) values (u1, 'inv1@example.com'), (u3, 'inv3@example.com');

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

  reset role;
  raise notice '=== 全部通过 ===';
end $$;
rollback;
