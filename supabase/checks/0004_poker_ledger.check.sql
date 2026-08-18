-- migration 0004 的真库一致性校验。整段包在事务里，最后 rollback，**不留痕**。
--
-- 为什么要有它：单测只能证明网关这一侧发对了 rpc，证不了 plpgsql 里的
-- 幂等键、行锁、零和断言在真的 Postgres 上成立。0002 就栽过一次
-- （部分唯一索引推断不出仲裁索引，只有真库跑得出来）。
--
-- 跑法：
--   scp -P 2222 supabase/checks/0004_poker_ledger.check.sql stan@<host>:/tmp/v4.sql
--   ssh -p 2222 stan@<host> 'docker exec -i otto-db-1 psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f /dev/stdin < /tmp/v4.sql'
--
-- 全绿的标志是最后一行 "=== 全部通过 ==="。任何一条 FAIL 都会中断整段。
-- u1 用的是维护者自己的账号（只读余额、动的部分随事务回滚）；u2 是临时造的。

begin;
do $$
declare
  u1 uuid := '32c6716a-2215-4fef-8865-7da11e0feab9';
  u2 uuid := gen_random_uuid();
  t  uuid := gen_random_uuid();
  h  uuid := gen_random_uuid();
  b1 bigint; b2 bigint; s1 bigint; s2 bigint; ok boolean; caught text;
begin
  insert into auth.users (id, email) values (u2, 'poker-test@example.com');
  perform public.grant_tokens(u2, 'flash', 20000000);

  select balance_tokens into b1 from public.token_balances where user_id = u1 and tier = 'flash';

  -- 买入
  perform public.poker_buyin(u1, t, 'flash', 1000, 'poker:buyin:' || t || ':' || u1 || ':1');
  perform public.poker_buyin(u2, t, 'flash', 1000, 'poker:buyin:' || t || ':' || u2 || ':1');
  select stack_tokens into s1 from public.poker_stacks where table_id = t and user_id = u1;
  select balance_tokens into b2 from public.token_balances where user_id = u1 and tier = 'flash';
  if s1 <> 1000 then raise exception 'FAIL 买入后栈应为 1000，实际 %', s1; end if;
  if b2 <> b1 - 1000 then raise exception 'FAIL 买入后桶应减 1000，% -> %', b1, b2; end if;
  raise notice 'PASS 买入：桶 % -> %，栈 %', b1, b2, s1;

  -- 买入重放
  perform public.poker_buyin(u1, t, 'flash', 1000, 'poker:buyin:' || t || ':' || u1 || ':1');
  select stack_tokens into s1 from public.poker_stacks where table_id = t and user_id = u1;
  if s1 <> 1000 then raise exception 'FAIL 重放把栈变成了 %', s1; end if;
  raise notice 'PASS 买入重放：栈仍为 %', s1;

  -- 结算
  ok := public.poker_settle(h, t, 'flash', 0, 'deadbeef', '[1,2,3]'::jsonb, 'salt',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        jsonb_build_object(u1::text, 400, u2::text, -400));
  select stack_tokens into s1 from public.poker_stacks where table_id = t and user_id = u1;
  select stack_tokens into s2 from public.poker_stacks where table_id = t and user_id = u2;
  if not ok or s1 <> 1400 or s2 <> 600 then
    raise exception 'FAIL 结算后应 1400/600，实际 %/% (ok=%)', s1, s2, ok;
  end if;
  raise notice 'PASS 结算：% / %', s1, s2;

  -- 结算重放
  ok := public.poker_settle(h, t, 'flash', 0, 'deadbeef', '[1,2,3]'::jsonb, 'salt',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        jsonb_build_object(u1::text, 400, u2::text, -400));
  select stack_tokens into s1 from public.poker_stacks where table_id = t and user_id = u1;
  if ok or s1 <> 1400 then raise exception 'FAIL 结算重放 ok=% 栈=%', ok, s1; end if;
  raise notice 'PASS 结算重放：返回 false，栈仍为 %', s1;

  -- 非零和被拒
  begin
    perform public.poker_settle(gen_random_uuid(), t, 'flash', 0, 'x', '[]'::jsonb, 's',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      jsonb_build_object(u1::text, 400, u2::text, -300));
    raise exception 'FAIL 非零和竟然通过了';
  exception when sqlstate 'P0004' then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 非零和被拒：%', caught;
  end;

  -- 余额不够被拒
  begin
    perform public.poker_buyin(u2, t, 'flash', 99999999999, 'poker:buyin:' || t || ':' || u2 || ':2');
    raise exception 'FAIL 超额买入竟然通过了';
  exception when sqlstate 'P0003' then
    get stacked diagnostics caught = message_text;
    raise notice 'PASS 超额买入被拒：%', caught;
  end;

  -- 投影可重算
  if public.rebuild_stack(u1, t) <> 1400 then raise exception 'FAIL rebuild_stack 对不上'; end if;
  if public.rebuild_stack(u2, t) <> 600 then raise exception 'FAIL rebuild_stack(u2) 对不上'; end if;
  raise notice 'PASS rebuild_stack 与存储值一致';

  -- 离桌
  perform public.poker_cashout(u1, t, 'poker:cashout:' || t || ':' || u1 || ':1');
  select stack_tokens into s1 from public.poker_stacks where table_id = t and user_id = u1;
  select balance_tokens into b2 from public.token_balances where user_id = u1 and tier = 'flash';
  if s1 <> 0 or b2 <> b1 + 400 then
    raise exception 'FAIL 离桌后栈=% 桶=%（应 0 / %）', s1, b2, b1 + 400;
  end if;
  raise notice 'PASS 离桌：栈 0，桶 % -> %（净赢 400）', b1, b2;

  -- 转移记录与账本一一对应
  if (select count(*) from public.poker_transfers where table_id = t) <> 3 then
    raise exception 'FAIL 转移记录条数不对';
  end if;
  if exists (
    select 1 from public.poker_transfers pt where pt.table_id = t
      and not exists (select 1 from public.token_ledger l where l.request_id = pt.request_id)
  ) then raise exception 'FAIL 有转移记录在账本里找不到对应行'; end if;
  raise notice 'PASS 转移记录 3 条，每条在账本里都有对应行';

  raise notice '=== 全部通过 ===';
end $$;
rollback;
