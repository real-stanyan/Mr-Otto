-- 德州：桌上筹码 + 手牌记录 + 零和结算（ADR-0022/0023，issue #57）
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。
--
-- 两个容器，不是两套账（ADR-0023）：
--   桶余额 public.token_balances —— 能买推理的 token
--   桌上筹码 public.poker_stacks —— 已经推到桌面上的 token
-- 同一个 token 任一时刻只在其中一个容器里。容器之间只有两个入口：
-- 买入（桶 → 桌）和离桌（桌 → 桶），两者都在一个事务里同时改两边，
-- 且都在 token_ledger 里留一行 —— 桶的每一分变动仍然只有账本一个来源。
--
-- 手牌之间的输赢**不进 token_ledger**：那些 token 从没离开牌桌。
-- 它们的 append-only 记录是 poker_hands，投影是 poker_stacks，
-- 与「事件日志 → 投影」同一条法理。

-- ── 桌上筹码：一张桌一个人一行 ────────────────────────────────────
create table if not exists public.poker_stacks (
  -- 牌桌本身在 #58 才建表，这里先不加外键，免得两个 PR 互相阻塞。
  -- 代价：孤儿 stack 行（桌没了钱还在桌上）要靠 #58 的建表 migration 补外键收口
  table_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  tier text not null,
  -- 负数栈是不可能的：桌注制下最多输光。这条 check 是引擎写错时的最后一道墙
  stack_tokens bigint not null default 0 check (stack_tokens >= 0),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (table_id, user_id)
);
alter table public.poker_stacks enable row level security;

drop policy if exists "poker_stacks_select_self" on public.poker_stacks;
create policy "poker_stacks_select_self" on public.poker_stacks
  for select to authenticated using (auth.uid() = user_id);

-- ── 桶↔桌的转移记录：append-only ──────────────────────────────────
-- 为什么不直接从 token_ledger 里筛：账本里认不出这笔买入属于哪张桌
-- （reason 只有 'poker_buyin'，桌号只能从 request_id 里用 LIKE 抠字符串，
-- 那等于把格式约定当外键用，改一次格式旧数据就重算不出来了）
create table if not exists public.poker_transfers (
  id bigint generated always as identity primary key,
  table_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  tier text not null,
  -- 对**桌上筹码**的影响：买入为正，离桌为负。桶那侧的符号正好相反
  delta_tokens bigint not null,
  -- 与 token_ledger 里那一行共用同一个幂等键，两边一一对应
  request_id text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists poker_transfers_table_user
  on public.poker_transfers (table_id, user_id);
alter table public.poker_transfers enable row level security;

drop policy if exists "poker_transfers_select_self" on public.poker_transfers;
create policy "poker_transfers_select_self" on public.poker_transfers
  for select to authenticated using (auth.uid() = user_id);

-- ── 手牌记录：一手一行，append-only ───────────────────────────────
create table if not exists public.poker_hands (
  -- id 由网关生成（结算的幂等键）：重投同一手不会扣两遍
  id uuid primary key,
  table_id uuid not null,
  tier text not null,
  button integer not null,
  -- 牌堆承诺：开局公布 hash，这里存的是摊牌后揭示的 deck + salt。
  -- 任何一个玩家都能自己算 sha256(salt || ':' || deck) 验庄家没中途换牌
  deck_hash text not null,
  deck jsonb not null,
  deck_salt text not null,
  -- seats: [{userId, startStack, hole}]；deltas: {userId: 净变动}
  seats jsonb not null,
  board jsonb not null,
  log jsonb not null,
  pots jsonb not null,
  deltas jsonb not null,
  -- RLS 用：jsonb 里的 userId 没法直接写进 policy，摊平成一列
  seat_ids uuid[] not null,
  created_at timestamptz not null default now()
);
create index if not exists poker_hands_table on public.poker_hands (table_id, created_at desc);
create index if not exists poker_hands_seats on public.poker_hands using gin (seat_ids);
alter table public.poker_hands enable row level security;

-- 意图：只有坐过这一手的人能看这手牌的记录（含所有人的底牌 —— 牌已经摊完了）
drop policy if exists "poker_hands_select_seated" on public.poker_hands;
create policy "poker_hands_select_seated" on public.poker_hands
  for select to authenticated using (auth.uid() = any(seat_ids));

-- ── poker_buyin：桶 → 桌，一个事务 ───────────────────────────────
-- 不允许透支：用量结算事后才知道用了多少，拦不住；买入是事前动作，拦得住
create or replace function public.poker_buyin(
  p_user uuid, p_table uuid, p_tier text, p_amount bigint, p_request_id text
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_stack bigint;
  v_balance bigint;
begin
  if p_amount <= 0 then raise exception '买入额必须为正'; end if;
  if p_request_id = '' then raise exception '买入必须带幂等键'; end if;

  -- 先把 stack 行锁住：并发的同一次买入都在这排队，
  -- 第一个提交后第二个才去查账本，看见已记过就原样返回
  insert into public.poker_stacks (table_id, user_id, tier)
  values (p_table, p_user, p_tier)
  on conflict (table_id, user_id) do nothing;
  select stack_tokens into v_stack from public.poker_stacks
    where table_id = p_table and user_id = p_user for update;

  if exists (select 1 from public.token_ledger where request_id = p_request_id) then
    return v_stack;   -- 重放
  end if;

  select balance_tokens into v_balance from public.token_balances
    where user_id = p_user and tier = p_tier;
  if v_balance is null then raise exception '用户 % 没有 % 桶', p_user, p_tier; end if;
  if v_balance < p_amount then
    raise exception '% 桶余额 % 不够买入 %', p_tier, v_balance, p_amount
      using errcode = 'P0003';
  end if;

  perform public.spend_tokens(
    p_user, p_tier, -p_amount, 'poker_buyin', '', 0, 0, p_request_id
  );
  insert into public.poker_transfers (table_id, user_id, tier, delta_tokens, request_id)
  values (p_table, p_user, p_tier, p_amount, p_request_id);
  update public.poker_stacks
    set stack_tokens = stack_tokens + p_amount, updated_at = now()
    where table_id = p_table and user_id = p_user
    returning stack_tokens into v_stack;
  return v_stack;
end $$;

-- ── poker_cashout：桌 → 桶，把整个栈带走 ─────────────────────────
create or replace function public.poker_cashout(
  p_user uuid, p_table uuid, p_request_id text
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_stack bigint;
  v_tier text;
begin
  if p_request_id = '' then raise exception '离桌必须带幂等键'; end if;

  select stack_tokens, tier into v_stack, v_tier from public.poker_stacks
    where table_id = p_table and user_id = p_user for update;
  if not found then raise exception '用户 % 不在这张桌上', p_user; end if;

  if exists (select 1 from public.token_ledger where request_id = p_request_id) then
    return 0;   -- 重放：钱早就退回桶里了
  end if;

  if v_stack > 0 then
    perform public.spend_tokens(
      p_user, v_tier, v_stack, 'poker_cashout', '', 0, 0, p_request_id
    );
    insert into public.poker_transfers (table_id, user_id, tier, delta_tokens, request_id)
    values (p_table, p_user, v_tier, -v_stack, p_request_id);
    update public.poker_stacks set stack_tokens = 0, updated_at = now()
      where table_id = p_table and user_id = p_user;
  end if;
  return v_stack;
end $$;

-- ── poker_settle：记一手牌 + 按 deltas 改各家的栈 ─────────────────
-- 返回 true = 这次真的结算了，false = 重放（同一个 hand id 再来一次）
create or replace function public.poker_settle(
  p_hand_id uuid, p_table uuid, p_tier text, p_button integer,
  p_deck_hash text, p_deck jsonb, p_deck_salt text,
  p_seats jsonb, p_board jsonb, p_log jsonb, p_pots jsonb, p_deltas jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_sum bigint := 0;
  v_seat_ids uuid[];
  v_key text;
  v_delta bigint;
  v_hit integer;
begin
  -- 零和是硬约束（ADR-0022 决定二：不抽水）。引擎已经断言过一遍，
  -- 这里再断言一遍：DB 是最后一道墙，它不信任调用方
  for v_key, v_delta in select key, value::text::bigint from jsonb_each(p_deltas) loop
    v_sum := v_sum + v_delta;
  end loop;
  if v_sum <> 0 then
    raise exception '这手牌的净变动和是 %，不是 0', v_sum using errcode = 'P0004';
  end if;

  select array_agg((key)::uuid) into v_seat_ids from jsonb_each(p_deltas);

  insert into public.poker_hands (
    id, table_id, tier, button, deck_hash, deck, deck_salt,
    seats, board, log, pots, deltas, seat_ids
  ) values (
    p_hand_id, p_table, p_tier, p_button, p_deck_hash, p_deck, p_deck_salt,
    p_seats, p_board, p_log, p_pots, p_deltas, v_seat_ids
  ) on conflict (id) do nothing;
  if not found then return false; end if;

  -- 按 user_id 排序上锁：多张桌并发结算时锁序一致，不会互相死等
  perform 1 from public.poker_stacks
    where table_id = p_table and user_id = any(v_seat_ids)
    order by user_id for update;

  for v_key, v_delta in select key, value::text::bigint from jsonb_each(p_deltas) loop
    update public.poker_stacks
      set stack_tokens = stack_tokens + v_delta, updated_at = now()
      where table_id = p_table and user_id = (v_key)::uuid;
    get diagnostics v_hit = row_count;
    if v_hit = 0 then
      raise exception '用户 % 不在桌 % 上，结算不了', v_key, p_table;
    end if;
  end loop;
  return true;
end $$;

-- ── rebuild_stack：从手牌记录 + 账本重算某人在某张桌上的栈 ────────
-- 「投影可从日志推导」在牌桌这一侧的兑现
create or replace function public.rebuild_stack(p_user uuid, p_table uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_moved bigint;
  v_won bigint;
begin
  select coalesce(sum(delta_tokens), 0) into v_moved
    from public.poker_transfers
    where table_id = p_table and user_id = p_user;

  select coalesce(sum((h.deltas ->> p_user::text)::bigint), 0) into v_won
    from public.poker_hands h
    where h.table_id = p_table and p_user = any(h.seat_ids);

  update public.poker_stacks set stack_tokens = v_moved + v_won, updated_at = now()
    where table_id = p_table and user_id = p_user;
  return v_moved + v_won;
end $$;

revoke all on function public.poker_buyin(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.poker_cashout(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.poker_settle(uuid, uuid, text, integer, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.rebuild_stack(uuid, uuid) from public, anon, authenticated;
grant execute on function public.poker_buyin(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.poker_cashout(uuid, uuid, text) to service_role;
grant execute on function public.poker_settle(uuid, uuid, text, integer, text, jsonb, text, jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.rebuild_stack(uuid, uuid) to service_role;
