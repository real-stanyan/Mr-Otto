-- supabase/migrations/0017_subscriptions.sql
-- 订阅制计费（issue #696，ADR-0174 / 0175 / 0176，spec 2026-09-02）。
-- 在 Supabase SQL editor 或 Management API 执行一次；重复执行安全。
--
-- 旧 token_ledger / token_wallets / token_balances **不动也不认**（维护者 2026-09-02
-- 拍板）：那是赠额时代的账，订阅制另起一本。append-only 硬规则照抄 0002：
-- usage_event 是钱的唯一事实，窗口计数器（Quota DO）和加购余额都是投影。
--
-- 全部金额 micro-USD bigint（1 USD = 1_000_000），不碰浮点。

-- ── plan：档位字典。DB 行不是代码常量——改价不发版 ─────────────────
create table if not exists public.plan (
  id text primary key,                          -- 'lite' | 'pro' | 'max' | 'addon'
  price_usd_cents integer not null,
  monthly_budget_micro bigint not null default 0,  -- 售价 × 70%
  week_limit_micro bigint not null default 0,      -- ÷ 4
  window5h_limit_micro bigint not null default 0,  -- × 0.2
  -- 'addon' 那一行专用：一个单位换多少 micro credit；其余行为 0
  addon_unit_micro bigint not null default 0,
  capabilities jsonb not null default '{"image":false,"video":false}'::jsonb,
  stripe_price_id text not null default '',
  updated_at timestamptz not null default now()
);

-- ── subscription：一人一行投影，Stripe webhook 是唯一写入者 ─────────
create table if not exists public.subscription (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null references public.plan(id),
  status text not null check (status in ('active', 'past_due', 'canceled')),
  stripe_customer_id text not null default '',
  stripe_subscription_id text not null default '',
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  updated_at timestamptz not null default now()
);
create index if not exists subscription_stripe_sub on public.subscription (stripe_subscription_id);

-- ── credit_grant：加购，append-only ──────────────────────────────────
create table if not exists public.credit_grant (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  micro_usd bigint not null,
  expires_at timestamptz not null,
  -- 幂等键：同一笔支付 webhook 重投不会记两次
  stripe_payment_intent_id text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists credit_grant_user on public.credit_grant (user_id, expires_at);

-- ── usage_event：唯一事实。网关 settle 后写、只增 ────────────────────
create table if not exists public.usage_event (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null unique,
  source text not null check (source in ('desktop', 'runtime')),
  workspace_id text not null default '',
  session_id text not null default '',
  logical_model text not null,
  route_id text not null,
  prompt_tokens integer not null,
  cached_tokens integer not null default 0,
  completion_tokens integer not null,
  cost_micro bigint not null,
  charged_to text not null check (charged_to in ('window', 'addon')),
  created_at timestamptz not null default now()
);
create index if not exists usage_event_user_created on public.usage_event (user_id, created_at desc);

-- ── model_route：逻辑型号 → 平台端点 + 价（ADR-0175 第 2 节）───────
create table if not exists public.model_route (
  id text primary key,
  logical_model text not null,
  platform text not null,                     -- 'deepseek' | 'zhipu'
  base_url text not null,
  wire_model text not null,
  price_in_micro_per_m bigint not null,       -- 每百万 token，已折 USD
  price_cache_micro_per_m bigint not null,
  price_out_micro_per_m bigint not null,
  default_max_tokens integer not null default 8192,
  quantization text not null default 'none',
  priority integer not null default 100,
  enabled boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to timestamptz
);
create index if not exists model_route_logical on public.model_route (logical_model, enabled, priority);

-- ── RLS：本人只读自己的行；plan / model_route 全员可读；全部无写策略 ──
alter table public.plan enable row level security;
alter table public.subscription enable row level security;
alter table public.credit_grant enable row level security;
alter table public.usage_event enable row level security;
alter table public.model_route enable row level security;

drop policy if exists plan_select_all on public.plan;
create policy plan_select_all on public.plan for select to authenticated using (true);
drop policy if exists model_route_select_all on public.model_route;
create policy model_route_select_all on public.model_route for select to authenticated using (true);
drop policy if exists subscription_select_self on public.subscription;
create policy subscription_select_self on public.subscription for select to authenticated using (user_id = auth.uid());
drop policy if exists credit_grant_select_self on public.credit_grant;
create policy credit_grant_select_self on public.credit_grant for select to authenticated using (user_id = auth.uid());
drop policy if exists usage_event_select_self on public.usage_event;
create policy usage_event_select_self on public.usage_event for select to authenticated using (user_id = auth.uid());
-- 故意不建任何 insert/update/delete 策略：authenticated 全拒，只有 service key（Worker）可写。
