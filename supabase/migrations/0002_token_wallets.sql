-- token 额度：append-only 账本 + 余额投影 + 原子扣费（issue #45）
-- 在 Supabase SQL editor 手动执行一次。重复执行安全(if not exists / or replace)。
--
-- 这里照抄仓库的硬规则：**账本是唯一事实来源，余额是投影**。
-- token_ledger 只增不改不删；token_wallets.balance_micro_usd 是它的求和缓存，
-- 由 rebuild_wallet() 随时可从账本重算出来。两者对不上时，账本是对的。
--
-- 金额单位一律 micro-USD（1 USD = 1_000_000），bigint。
-- 不用浮点：0.1 + 0.2 != 0.3 这种事不能发生在钱上。

-- ── token_ledger：每一行 = 一次余额变动 ────────────────────────────
create table if not exists public.token_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 正 = 进账(注册赠额/充值/德州赢)，负 = 出账(API 用量/德州输)
  delta_micro_usd bigint not null,
  reason text not null,
  -- 以下四列只对 reason='api_usage' 有意义，其余留空。
  -- 留在同一张表而不是另开表：一次 API 调用是一条账，拆两处就得对账
  model text not null default '',
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  -- 幂等键：网关重试/客户端重发时认这个，避免同一次调用扣两次
  request_id text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists token_ledger_user_created
  on public.token_ledger (user_id, created_at desc);
-- 空串不参与唯一约束：只有带 request_id 的行需要防重
create unique index if not exists token_ledger_request_id_unique
  on public.token_ledger (request_id) where request_id <> '';

-- ── token_wallets：余额投影 ────────────────────────────────────────
create table if not exists public.token_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_micro_usd bigint not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.token_ledger enable row level security;
alter table public.token_wallets enable row level security;

-- 意图：本人只读自己的账本和余额。**没有任何 insert/update/delete 策略** ——
-- 客户端永远写不动钱，写入只走下面的 security definer 函数（service_role 调用，绕过 RLS）
drop policy if exists "token_ledger_select_self" on public.token_ledger;
create policy "token_ledger_select_self" on public.token_ledger
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "token_wallets_select_self" on public.token_wallets;
create policy "token_wallets_select_self" on public.token_wallets
  for select to authenticated using (auth.uid() = user_id);

-- ── ensure_wallet：首次调用自动开户 + 发注册赠额 ───────────────────
-- 幂等：request_id = 'signup_grant:<uid>'，第二次调用被唯一索引挡掉，
-- 于是「送 20 刀」这件事对同一个人物理上只能发生一次
create or replace function public.ensure_wallet(p_user uuid, p_grant_micro_usd bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
begin
  insert into public.token_wallets (user_id, balance_micro_usd)
  values (p_user, 0)
  on conflict (user_id) do nothing;

  if p_grant_micro_usd > 0 then
    insert into public.token_ledger (user_id, delta_micro_usd, reason, request_id)
    values (p_user, p_grant_micro_usd, 'signup_grant', 'signup_grant:' || p_user::text)
    on conflict (request_id) do nothing;

    -- 只有真插进去了才加余额（on conflict 什么都没插时 not found 为真）
    if found then
      update public.token_wallets
        set balance_micro_usd = balance_micro_usd + p_grant_micro_usd, updated_at = now()
        where user_id = p_user;
    end if;
  end if;

  select balance_micro_usd into v_balance from public.token_wallets where user_id = p_user;
  return v_balance;
end $$;

-- ── charge_tokens：原子记账 ────────────────────────────────────────
-- p_delta 正负都收（德州赢是正的）。返回记账后的余额。
-- 允许透支：用量只有在模型答完之后才知道，事前拦不住最后一次超支。
-- 事前门槛在网关（余额 <= 0 直接 402），这里只负责把账记对。
create or replace function public.charge_tokens(
  p_user uuid,
  p_delta_micro_usd bigint,
  p_reason text,
  p_model text default '',
  p_prompt_tokens integer default 0,
  p_completion_tokens integer default 0,
  p_request_id text default ''
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
begin
  -- 先锁住这一行，并发的两次扣费排队而不是互相覆盖
  select balance_micro_usd into v_balance
    from public.token_wallets where user_id = p_user for update;
  if not found then
    raise exception 'wallet not found for user %', p_user using errcode = 'P0002';
  end if;

  insert into public.token_ledger (
    user_id, delta_micro_usd, reason, model, prompt_tokens, completion_tokens, request_id
  ) values (
    p_user, p_delta_micro_usd, p_reason, p_model, p_prompt_tokens, p_completion_tokens, p_request_id
  ) on conflict (request_id) do nothing;

  -- 重放（同一个 request_id 再来一次）：账本没动，余额也不该动
  if not found then
    return v_balance;
  end if;

  update public.token_wallets
    set balance_micro_usd = balance_micro_usd + p_delta_micro_usd, updated_at = now()
    where user_id = p_user
    returning balance_micro_usd into v_balance;
  return v_balance;
end $$;

-- ── rebuild_wallet：从账本重算余额 ─────────────────────────────────
-- 「投影可从日志推导」不是口号，是这个函数。对账/修复用；
-- 正常情况下它的返回值应当恒等于 token_wallets.balance_micro_usd
create or replace function public.rebuild_wallet(p_user uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_sum bigint;
begin
  select coalesce(sum(delta_micro_usd), 0) into v_sum
    from public.token_ledger where user_id = p_user;
  update public.token_wallets
    set balance_micro_usd = v_sum, updated_at = now() where user_id = p_user;
  return v_sum;
end $$;

-- 这三个函数只给服务端（service_role）调；authenticated 不给执行权，
-- 否则登录用户可以自己 rpc 一句 charge_tokens 给自己发钱
revoke all on function public.ensure_wallet(uuid, bigint) from public, anon, authenticated;
revoke all on function public.charge_tokens(uuid, bigint, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.rebuild_wallet(uuid) from public, anon, authenticated;
grant execute on function public.ensure_wallet(uuid, bigint) to service_role;
grant execute on function public.charge_tokens(uuid, bigint, text, text, integer, integer, text) to service_role;
grant execute on function public.rebuild_wallet(uuid) to service_role;
