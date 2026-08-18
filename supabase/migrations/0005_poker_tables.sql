-- 牌桌本体 + 入座/离座（ADR-0022 决定四：仅 accepted 好友可同桌，issue #58）
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。

create table if not exists public.poker_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  -- 桌子建的时候定档位，桌上所有人押的都是这个桶的 token（ADR-0022 决定一）
  tier text not null,
  small_blind bigint not null check (small_blind > 0),
  big_blind bigint not null,
  min_buyin bigint not null,
  max_buyin bigint not null,
  max_seats integer not null default 6 check (max_seats between 2 and 9),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check (big_blind >= small_blind),
  check (max_buyin >= min_buyin),
  -- 买入下限至少一个大盲，否则一坐下就只能全下
  check (min_buyin >= big_blind)
);
alter table public.poker_tables enable row level security;

-- 看得见的桌 = 自己坐着的，或建桌人是自己好友的（还没坐下也得先看得见才能入座）
drop policy if exists "poker_tables_select_visible" on public.poker_tables;
create policy "poker_tables_select_visible" on public.poker_tables
  for select to authenticated using (
    auth.uid() = created_by
    or exists (
      select 1 from public.poker_stacks s
      where s.table_id = id and s.user_id = auth.uid()
    )
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester, f.addressee) = least(created_by, auth.uid())
        and greatest(f.requester, f.addressee) = greatest(created_by, auth.uid())
    )
  );

-- ── poker_stacks 补 seat_index + 外键 ─────────────────────────────
-- 座位次序决定庄位与盲注顺序，不能靠 user_id 排序凑（那样换个人上桌顺序就变了）
alter table public.poker_stacks add column if not exists seat_index integer;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'poker_stacks_table_fk'
  ) then
    alter table public.poker_stacks
      add constraint poker_stacks_table_fk
      foreign key (table_id) references public.poker_tables(id) on delete cascade;
  end if;
end $$;
create unique index if not exists poker_stacks_seat_unique
  on public.poker_stacks (table_id, seat_index) where seat_index is not null;

-- ── poker_join：好友门 + 分座位 + 买入，一个事务 ──────────────────
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

  -- 已经在桌上就只是补买入（rebuy），座位不变
  select seat_index into v_seat from public.poker_stacks
    where table_id = p_table and user_id = p_user;

  if v_seat is null then
    -- 好友门（ADR-0022 决定四）：必须与**在座每一个人**都是 accepted 好友。
    -- 只查"跟建桌人是好友"不够 —— 那样两个互不相识的人能在同一张桌上
    -- 看着对方打牌，而"私人圈子"这个前提正是靠这一条落地的
    if exists (
      select 1 from public.poker_stacks s
      where s.table_id = p_table and s.user_id <> p_user
        and not exists (
          select 1 from public.friendships f
          where f.status = 'accepted'
            and least(f.requester, f.addressee) = least(s.user_id, p_user)
            and greatest(f.requester, f.addressee) = greatest(s.user_id, p_user)
        )
    ) then
      raise exception '桌上有人不是你的好友' using errcode = 'P0005';
    end if;

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

  if p_amount < t.min_buyin or p_amount > t.max_buyin then
    raise exception '买入要在 %..% 之间，给了 %', t.min_buyin, t.max_buyin, p_amount
      using errcode = 'P0007';
  end if;

  perform public.poker_buyin(p_user, p_table, t.tier, p_amount, p_request_id);
  return v_seat;
end $$;

-- ── poker_leave：带走筹码 + 空出座位 ──────────────────────────────
create or replace function public.poker_leave(
  p_user uuid, p_table uuid, p_request_id text
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_taken bigint;
begin
  v_taken := public.poker_cashout(p_user, p_table, p_request_id);
  -- 删行而不是把 seat_index 置空：留着一行 0 筹码的空壳，
  -- 下一个人算好友门时还会把他当"在座"
  delete from public.poker_stacks where table_id = p_table and user_id = p_user;
  return v_taken;
end $$;

revoke all on function public.poker_join(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.poker_leave(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.poker_join(uuid, uuid, bigint, text) to service_role;
grant execute on function public.poker_leave(uuid, uuid, text) to service_role;
