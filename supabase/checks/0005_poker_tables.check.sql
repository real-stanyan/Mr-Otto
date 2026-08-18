-- migration 0005 的真库一致性校验。整段包在事务里，最后 rollback，**不留痕**。
-- 跑法见 0004_poker_ledger.check.sql 的头注释。
begin;
do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  u3 uuid := gen_random_uuid();
  t uuid;
  v_seat integer; v_stack bigint; caught text;
begin
  insert into auth.users (id, email) values
    (u1, 'p1@example.com'), (u2, 'p2@example.com'), (u3, 'p3@example.com');
  insert into public.profiles (id) values (u1), (u2), (u3) on conflict (id) do nothing;
  perform public.grant_tokens(u1, 'flash', 100000);
  perform public.grant_tokens(u2, 'flash', 100000);
  perform public.grant_tokens(u3, 'flash', 100000);

  insert into public.poker_tables (tier, small_blind, big_blind, min_buyin, max_buyin, max_seats, created_by)
  values ('flash', 25, 50, 1000, 5000, 2, u1) returning id into t;

  -- 建桌人自己先入座
  v_seat := public.poker_join(u1, t, 2000, 'join:' || t || ':' || u1);
  if v_seat <> 0 then raise exception 'FAIL 首位应是 0 号座，实际 %', v_seat; end if;
  raise notice 'PASS 入座：座位 %', v_seat;

  -- 好友门：u2 与 u1 还不是好友
  begin
    perform public.poker_join(u2, t, 2000, 'join:' || t || ':' || u2);
    raise exception 'FAIL 非好友竟然坐下了';
  exception when sqlstate 'P0005' then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 非好友被挡：%', caught;
  end;

  -- 加好友后可入座
  insert into public.friendships (requester, addressee, status) values (u1, u2, 'accepted');
  v_seat := public.poker_join(u2, t, 2000, 'join:' || t || ':' || u2);
  if v_seat <> 1 then raise exception 'FAIL 第二位应是 1 号座，实际 %', v_seat; end if;
  raise notice 'PASS 好友入座：座位 %', v_seat;

  -- 满桌（max_seats = 2）。u3 与 u1、u2 都是好友，仍应被满桌挡下
  insert into public.friendships (requester, addressee, status) values
    (u1, u3, 'accepted'), (u2, u3, 'accepted');
  begin
    perform public.poker_join(u3, t, 2000, 'join:' || t || ':' || u3);
    raise exception 'FAIL 满桌还能坐进去';
  exception when sqlstate 'P0006' then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 满桌被挡：%', caught;
  end;

  -- 买入区间
  begin
    perform public.poker_join(u1, t, 999, 'join:' || t || ':' || u1 || ':lo');
    raise exception 'FAIL 低于下限的买入通过了';
  exception when sqlstate 'P0007' then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 买入区间被守住：%', caught;
  end;

  -- 离桌腾出座位，且座位号被填回去而不是一路递增
  v_stack := public.poker_leave(u1, t, 'leave:' || t || ':' || u1);
  if v_stack <> 2000 then raise exception 'FAIL 离桌应带走 2000，实际 %', v_stack; end if;
  if exists (select 1 from public.poker_stacks where table_id = t and user_id = u1) then
    raise exception 'FAIL 离桌后还留着 stack 行 —— 下一个人算好友门时会把他当在座';
  end if;
  v_seat := public.poker_join(u3, t, 2000, 'join:' || t || ':' || u3 || ':2');
  if v_seat <> 0 then raise exception 'FAIL 空出的 0 号座没被填回，给了 %', v_seat; end if;
  raise notice 'PASS 离桌带走 %，空位被填回（座位 %）', v_stack, v_seat;

  -- 好友门是**对在座每一个人**，不是只对建桌人
  insert into public.poker_tables (tier, small_blind, big_blind, min_buyin, max_buyin, max_seats, created_by)
  values ('flash', 25, 50, 1000, 5000, 6, u1) returning id into t;
  perform public.poker_join(u2, t, 2000, 'join2:' || t || ':' || u2);
  delete from public.friendships
    where least(requester, addressee) = least(u2, u3) and greatest(requester, addressee) = greatest(u2, u3);
  begin
    -- u3 与建桌人 u1 是好友，但与在座的 u2 不是
    perform public.poker_join(u3, t, 2000, 'join2:' || t || ':' || u3);
    raise exception 'FAIL 只跟建桌人是好友就坐进去了';
  exception when sqlstate 'P0005' then
    raise notice 'PASS 好友门是对在座每一个人，不是只对建桌人';
  end;

  raise notice '=== 全部通过 ===';
end $$;
rollback;
