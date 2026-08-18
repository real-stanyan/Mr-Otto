-- 计费单位从 micro-USD 换成「按型号桶计的 token」（ADR-0021，issue #55）
-- 在 Supabase SQL editor 手动执行一次。重复执行安全。
--
-- 为什么换：额度要能直接当德州筹码。美元额度每押一注都要换算一次，
-- 而 token 本身就是整数，桶内可加可减，不需要中间单位。
--
-- 为什么按桶：token 不是等价的。同样 1 个 token，flash 输入 0.28 USD/1M、
-- pro 输出 2.19 USD/1M —— 差 7.8 倍。一个统一的 token 余额等于开着套利口子
-- （全切 pro，扣同样多，平台付 7.8 倍）。分桶之后互不流通，桶内怎么用都不亏。
--
-- 旧的 micro-USD 账本**一个字都不改**（append-only 是硬规则）。
-- 0002 建的 token_ledger 继续用，只是新增两列，从此新行写 tier/delta_tokens，
-- 旧行的 delta_micro_usd 原样躺着当历史。余额投影换成新表，按 (user_id, tier) 分行。

-- ── 账本加两列：tier + delta_tokens ───────────────────────────────
-- 空 tier = micro-USD 时代的旧行，不参与新余额的任何计算
alter table public.token_ledger add column if not exists tier text not null default '';
alter table public.token_ledger add column if not exists delta_tokens bigint not null default 0;
-- 0002 建这列时是 not null 且**没有默认值**，token 时代的新行不写它 → 23502。
-- 补默认值而不是放开 not null：token 行的美元变动确实就是 0，
-- 写成 null 等于说"不知道"，那不是事实。旧行的值一个都不动（加默认值不重写已有行）
alter table public.token_ledger alter column delta_micro_usd set default 0;
create index if not exists token_ledger_user_tier
  on public.token_ledger (user_id, tier) where tier <> '';

-- ── 余额投影：一个用户一个桶一行 ──────────────────────────────────
create table if not exists public.token_balances (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- 桶名对应 gateway 的 MODEL_BUCKETS；值域由网关守，这里不写死 check，
  -- 免得加一个型号就要改一次 DDL
  tier text not null,
  balance_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, tier)
);
alter table public.token_balances enable row level security;

drop policy if exists "token_balances_select_self" on public.token_balances;
create policy "token_balances_select_self" on public.token_balances
  for select to authenticated using (auth.uid() = user_id);

-- ── grant_tokens：开桶 + 发赠额（每个桶只发一次） ─────────────────
-- 幂等键 'grant:<tier>:<uid>'，第二次被唯一索引挡掉，所以「送 N token」
-- 对同一个人同一个桶物理上只能发生一次
create or replace function public.grant_tokens(p_user uuid, p_tier text, p_tokens bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
begin
  insert into public.token_balances (user_id, tier, balance_tokens)
  values (p_user, p_tier, 0)
  on conflict (user_id, tier) do nothing;

  if p_tokens > 0 then
    insert into public.token_ledger (user_id, delta_tokens, tier, reason, request_id)
    values (p_user, p_tokens, p_tier, 'signup_grant', 'grant:' || p_tier || ':' || p_user::text)
    -- 部分唯一索引必须重复谓词才能被推断为仲裁索引（0002 踩过，见 #45 的修复）
    on conflict (request_id) where request_id <> '' do nothing;

    if found then
      update public.token_balances
        set balance_tokens = balance_tokens + p_tokens, updated_at = now()
        where user_id = p_user and tier = p_tier;
    end if;
  end if;

  select balance_tokens into v_balance
    from public.token_balances where user_id = p_user and tier = p_tier;
  return v_balance;
end $$;

-- ── spend_tokens：原子记账 ────────────────────────────────────────
-- p_delta 正负都收（德州赢是正的）。返回记账后的余额。
-- 允许小额透支：用量只有模型答完才知道，事前拦不住最后一次超支。
-- 事前门槛在网关（该桶余额 <= 0 直接 402）。
create or replace function public.spend_tokens(
  p_user uuid,
  p_tier text,
  p_delta_tokens bigint,
  p_reason text,
  p_model text default '',
  p_prompt_tokens integer default 0,
  p_completion_tokens integer default 0,
  p_request_id text default ''
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_balance bigint;
begin
  select balance_tokens into v_balance
    from public.token_balances where user_id = p_user and tier = p_tier for update;
  if not found then
    raise exception 'no % bucket for user %', p_tier, p_user using errcode = 'P0002';
  end if;

  insert into public.token_ledger (
    user_id, delta_tokens, tier, reason, model, prompt_tokens, completion_tokens, request_id
  ) values (
    p_user, p_delta_tokens, p_tier, p_reason, p_model, p_prompt_tokens, p_completion_tokens, p_request_id
  ) on conflict (request_id) where request_id <> '' do nothing;

  -- 重放（同一个 request_id 再来一次）：账本没动，余额也不该动
  if not found then
    return v_balance;
  end if;

  update public.token_balances
    set balance_tokens = balance_tokens + p_delta_tokens, updated_at = now()
    where user_id = p_user and tier = p_tier
    returning balance_tokens into v_balance;
  return v_balance;
end $$;

-- ── rebuild_balance：从账本重算某个桶 ─────────────────────────────
-- 「投影可从日志推导」不是口号，是这个函数
create or replace function public.rebuild_balance(p_user uuid, p_tier text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_sum bigint;
begin
  select coalesce(sum(delta_tokens), 0) into v_sum
    from public.token_ledger where user_id = p_user and tier = p_tier;
  update public.token_balances
    set balance_tokens = v_sum, updated_at = now()
    where user_id = p_user and tier = p_tier;
  return v_sum;
end $$;

-- ── micro-USD 时代的三个函数退休 ──────────────────────────────────
-- 数据不动，只收掉写入口：留着它们等于留两套记账法，迟早有人调错那套
drop function if exists public.ensure_wallet(uuid, bigint);
drop function if exists public.charge_tokens(uuid, bigint, text, text, integer, integer, text);
drop function if exists public.rebuild_wallet(uuid);

-- 只给服务端（service_role）调；authenticated 有执行权 = 登录用户能自己发钱
revoke all on function public.grant_tokens(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.spend_tokens(uuid, text, bigint, text, text, integer, integer, text) from public, anon, authenticated;
revoke all on function public.rebuild_balance(uuid, text) from public, anon, authenticated;
grant execute on function public.grant_tokens(uuid, text, bigint) to service_role;
grant execute on function public.spend_tokens(uuid, text, bigint, text, text, integer, integer, text) to service_role;
grant execute on function public.rebuild_balance(uuid, text) to service_role;
