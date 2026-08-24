-- 德州规则变更（issue #318 / ADR-0082，推翻 ADR-0022 决定四）：
-- 1. 取消好友同桌门：任何登录用户都能看见并加入任何开着的桌
-- 2. 买入不设区间：min_buyin/max_buyin 列保留但不再强制，
--    上限由钱包余额天然限制（poker_buyin 的余额检查不动，不能透支）
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。

-- ── 可见性放开：所有登录用户可见（原政策：自己坐着的 / 建桌人是好友的） ──
drop policy if exists "poker_tables_select_visible" on public.poker_tables;
create policy "poker_tables_select_visible" on public.poker_tables
  for select to authenticated using (true);

-- ── poker_join：分座位 + 买入，一个事务。好友门与买入区间检查已删 ──
create or replace function public.poker_join(
  p_user uuid, p_table uuid, p_amount bigint, p_request_id text
) returns integer language plpgsql security definer set search_path = public as $$
declare
  t public.poker_tables%rowtype;
  v_seat integer;
  v_taken integer;
begin
  select * into t from public.poker_tables where id = p_table for update;
  if not found then raise exception '没有这张桌：%', p_table; end if;
  if t.closed_at is not null then raise exception '这张桌已经关了'; end if;

  if p_amount <= 0 then
    raise exception '买入额要是正整数，给了 %', p_amount using errcode = 'P0007';
  end if;

  -- 已经在桌上就只是补买入（rebuy），座位不变
  select seat_index into v_seat from public.poker_stacks
    where table_id = p_table and user_id = p_user;

  if v_seat is null then
    select count(*) into v_taken from public.poker_stacks where table_id = p_table;
    if v_taken >= t.max_seats then
      raise exception '这张桌满了（%/%）', v_taken, t.max_seats using errcode = 'P0006';
    end if;

    -- 取最小的空位号，而不是 max+1：有人离桌后座位要能被填回去
    select min(g) into v_seat from generate_series(0, t.max_seats - 1) g
      where g not in (
        select seat_index from public.poker_stacks
        where table_id = p_table and seat_index is not null
      );

    insert into public.poker_stacks (table_id, user_id, tier, seat_index)
    values (p_table, p_user, t.tier, v_seat);
  end if;

  perform public.poker_buyin(p_user, p_table, t.tier, p_amount, p_request_id);
  return v_seat;
end $$;

revoke all on function public.poker_join(uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.poker_join(uuid, uuid, bigint, text) to service_role;
