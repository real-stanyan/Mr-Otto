# 订阅制计费 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户订阅（Lite/Pro/Max）后，桌面端与云 runtime 的模型调用走平台网关、用平台 key，额度按 5 小时 + 一周两个固定窗口计量，Stripe 入账。

**Architecture:** 网关是现有 Cloudflare edge Worker 上的一组新路由（`/llm/v1/*`、`/billing/v1/*`）+ 一户一个 `Quota` Durable Object（双窗计数、hold/settle）；`usage_event` 表是钱的唯一事实，DO 是投影。桌面端 `routeModel` 多一种 `hosted` 出路（订阅优先于自带 key），耗尽时改道自带 key；runtime 以平台身份代表 turn 发起人调网关。Stripe 走裸 REST + 手写 webhook 验签。

**Tech Stack:** TypeScript strict / vitest（根门禁 `npm test` = 三条 tsc + vitest）/ Cloudflare Workers + Durable Objects（wrangler）/ Supabase Postgres（PostgREST，service key）/ Stripe REST / Electron 主进程 + React/Zustand 渲染层。

**Spec:** `docs/superpowers/specs/2026-09-02-subscription-billing-design.md`（读它，本计划只写「怎么做」）。上游决定 ADR-0174 / 0175 / 0176。

## Global Constraints

- 档位三档：Lite \$19 / Pro \$59 / Max \$89；折算：月成本预算 = 售价 × 70%，周窗 = 月预算 ÷ 4，5h 窗 = 周窗 × 0.2。全部 micro-USD 整数（1 USD = 1_000_000）。
- 窗口固定不滑动、不滚存；5h 窗第一次 hold 时开，周窗锚定 `subscription.current_period_start`。
- 加购 credit 不进时间窗、12 个月有效、只在两窗任一耗尽时动用。
- 上游模型 key 只在 Worker env（`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY`），永不下发；runtime 仍不持有任何模型 key。
- 自带 key 不走网关（ADR-0176 决定一）；付费订阅下托管优先于自带 key（决定二）。
- 硬规则：SessionEvent 新字段全部可选；渲染层只经 `ShellBridge`；`services/edge/src/worker.ts` 是唯一依赖 Workers 运行时的文件，其余 edge 源码必须是纯的（根门禁跑）。
- 测试放 `tests/`，镜像源码路径：`services/edge/src/x.ts` ↔ `tests/edge/x.test.ts`，`services/runtime/src/x.ts` ↔ `tests/runtime/x.test.ts`。
- 错误信封统一 `{ error: { message, type: "otto_edge", code } }`（edge.ts 的 `apiError`）。
- 不装新 npm 依赖（Stripe 裸 fetch，JWT 已手写）。
- 提交信息写**为什么**；每个 Task 至少一个提交；提交尾部固定：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012hQSQAoYeiBAMKL5Yki1rh
  ```
- 工作目录：`/Users/stanyan/Github/Mr_Otto/.claude/worktrees/subscription-billing-69ce03`（分支 `claude/subscription-billing-69ce03`）。别碰主 checkout。
- 内循环 `npx vitest run <文件>`；每个 Task 结束前跑一次 `npm run typecheck`。

---

## File Structure

| 文件 | 职责 | Task |
|---|---|---|
| `src/shared/billing.ts` | 三端共用的线上约定：`/me` 响应形状、响应头名、错误码、on-behalf-of 头名、credit 显示换算 | 1 |
| `supabase/migrations/0017_subscriptions.sql` | 五张新表 + RLS | 2 |
| `supabase/seed/0017_plans_routes.sql` | `plan` 三档 + addon 行、`model_route` 首批三条 | 2 |
| `services/edge/src/quota.ts` | 纯逻辑：双窗状态机、hold/settle/release、加购垫底、从事件重建 | 3 |
| `services/edge/src/llmGateway.ts` | 纯逻辑：body 解析、选路、估算、转发、SSE usage 旁路、结算、响应头 | 4 |
| `services/edge/src/billing.ts` | 纯逻辑：Stripe 验签、事件 → 动作、Checkout/Portal 请求体 | 5 |
| `services/edge/src/edge.ts` | 路由：`/llm/v1/chat/completions`、`/billing/v1/{me,checkout,portal,webhook,done}`；身份两种 + on-behalf-of | 6 |
| `services/edge/src/worker.ts` | `Quota` DO + Supabase/Stripe 装配 + Env 增项 | 7 |
| `services/edge/wrangler.jsonc` / `README.md` / `checks/llm.mjs` | binding、migration v3、部署清单、真 workerd 自检 | 7 |
| `src/model/errorClass.ts` / `src/model/openaiCompatible.ts` / `src/model/adapter.ts` | 新错误类 `reroute`；响应头回调；429 quota 体解析；`ModelReply.route` | 8 |
| `src/main/hostedQuota.ts` | 主进程：额度快照 + `/me` / checkout / portal 客户端 | 9 |
| `src/main/modelRoute.ts` / `src/main/agent.ts` / `src/session/events.ts` / `src/loop/engine.ts` | `hosted` 出路 + 改道 + `route_changed` 事件 + `assistant_message.route` | 10 |
| `src/shared/shellBridge.ts` / `src/preload/index.ts` / `src/main/index.ts` / `src/renderer/src/store.ts` / `src/renderer/src/components/BillingSettings.tsx` / `App.tsx` | IPC 三件 + 订阅页 | 11 |
| `src/renderer/src/components/CostPanel.tsx` / `src/session/deriveUsage.ts` | hosted 段显示 credit、direct 段显示 \$ | 12 |
| `services/runtime/src/hostedRoute.ts` / `daemon.ts` / `config.ts` | runtime 代表发起人走网关 | 13 |
| `docs/adr/0203-*.md` / `AGENTS.md` 索引 / `CONTEXT.md` / `supabase/README.md` | 记录与索引 | 14 |

---

### Task 1: 三端共用的计费约定 `src/shared/billing.ts`

**Files:**
- Create: `src/shared/billing.ts`
- Test: `tests/shared/billing.test.ts`

**Interfaces:**
- Produces（后面所有 Task 都 import 这些名字）：
  - `type PlanId = "lite" | "pro" | "max"`
  - `interface WindowState { usedMicro: number; limitMicro: number; resetAt: number }`
  - `interface BillingMe { plan: PlanId | null; status: "active" | "past_due" | "canceled" | "none"; windows: { h5: WindowState; week: WindowState } | null; addon: { remainingMicro: number; expiresAt: number | null }; periodEnd: number | null; models: string[] }`
  - `const BILLING_HEADERS = { h5, week, addon, plan }`（响应头名）
  - `const ON_BEHALF_HEADER / WORKSPACE_HEADER / SESSION_HEADER`
  - `type BillingErrorCode`、`interface BillingError { code; message; window?; resetAt? }`
  - `parseBillingError(status: number, payload: unknown): BillingError | null`
  - `parseBillingMe(payload: unknown): BillingMe | null`
  - `creditOf(micro: number): number`（1 credit = 1 美分 = 10_000 micro）、`fmtCredit(micro): string`
  - `remainingFromHeaders(h: Headers): { h5?: number; week?: number; addon?: number; plan?: string }`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/shared/billing.test.ts
import { describe, expect, it } from "vitest";
import {
  BILLING_HEADERS, creditOf, fmtCredit, parseBillingError, parseBillingMe, remainingFromHeaders,
} from "../../src/shared/billing.js";

describe("billing 约定", () => {
  it("credit = 美分：10_000 micro = 1 credit，显示一位小数", () => {
    expect(creditOf(10_000)).toBe(1);
    expect(fmtCredit(123_456)).toBe("12.3 credit");
    expect(fmtCredit(0)).toBe("0 credit");
  });

  it("parseBillingError 只认 otto_edge 信封；quota_exhausted 带 window/resetAt", () => {
    const e = parseBillingError(429, {
      error: { type: "otto_edge", code: "quota_exhausted", message: "x", window: "5h", resetAt: 1000 },
    });
    expect(e).toEqual({ code: "quota_exhausted", message: "x", window: "5h", resetAt: 1000 });
    expect(parseBillingError(429, { error: { message: "rate limited" } })).toBeNull();
    expect(parseBillingError(500, "boom")).toBeNull();
  });

  it("parseBillingMe：无订阅时 windows=null、plan=null；形状不对回 null", () => {
    const me = parseBillingMe({
      plan: null, status: "none", windows: null,
      addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [],
    });
    expect(me?.plan).toBeNull();
    expect(parseBillingMe({ plan: "lite" })).toBeNull();
  });

  it("remainingFromHeaders：缺的头不出现在结果里，不是 0", () => {
    const h = new Headers({ [BILLING_HEADERS.h5]: "5000", [BILLING_HEADERS.plan]: "pro" });
    expect(remainingFromHeaders(h)).toEqual({ h5: 5000, plan: "pro" });
    expect(remainingFromHeaders(new Headers({ [BILLING_HEADERS.week]: "abc" }))).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/shared/billing.test.ts`
Expected: FAIL，`Cannot find module '../../src/shared/billing.js'`

- [ ] **Step 3: 写实现**

```ts
// src/shared/billing.ts
// 订阅计费的线上约定——edge Worker / 桌面主进程 / 云 runtime **三端共用一份**
// （纪律同 src/shared/remote/wire.ts：改这里 = 三端一起改）。
// 数字全是 micro-USD 整数（1 USD = 1_000_000），显示层才换成 credit。
// 1 credit = 1 美分 = 10_000 micro。用户看到的额度不是钱数，是 credit：
// 托管模式的花费和 BYOK 的「$X」不能长得一样（ADR-0176 决定五）。

export type PlanId = "lite" | "pro" | "max";
export type SubscriptionStatus = "active" | "past_due" | "canceled" | "none";

export interface WindowState {
  usedMicro: number;
  limitMicro: number;
  /** 这个窗口什么时候清零（epoch ms）。倒计时从这里来 */
  resetAt: number;
}

export interface BillingMe {
  plan: PlanId | null;
  status: SubscriptionStatus;
  /** null = 没有活跃订阅（没窗口可言） */
  windows: { h5: WindowState; week: WindowState } | null;
  addon: { remainingMicro: number; expiresAt: number | null };
  periodEnd: number | null;
  /** 网关此刻供的逻辑型号 id（model_route 里 enabled 的） */
  models: string[];
}

export const BILLING_HEADERS = {
  h5: "x-otto-window-5h-remaining",
  week: "x-otto-window-week-remaining",
  addon: "x-otto-addon-remaining",
  plan: "x-otto-plan",
} as const;

/** 平台身份（runtime）代表哪个真用户；桌面 JWT 带这个头一律 400 */
export const ON_BEHALF_HEADER = "x-otto-on-behalf-of";
export const WORKSPACE_HEADER = "x-otto-workspace";
export const SESSION_HEADER = "x-otto-session";

export type BillingErrorCode =
  | "bad_token"
  | "no_subscription"
  | "quota_exhausted"
  | "unknown_model"
  | "upstream"
  | "too_many_inflight"
  | "bad_request";

export interface BillingError {
  code: BillingErrorCode;
  message: string;
  window?: "5h" | "week";
  resetAt?: number;
}

const CODES: ReadonlySet<string> = new Set([
  "bad_token", "no_subscription", "quota_exhausted", "unknown_model", "upstream", "too_many_inflight", "bad_request",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 只认 edge 的信封（type: "otto_edge" + 认识的 code）。上游原样透传回来的错误不是它 */
export function parseBillingError(status: number, payload: unknown): BillingError | null {
  if (status < 400 || !isObj(payload) || !isObj(payload.error)) return null;
  const e = payload.error;
  if (e.type !== "otto_edge" || typeof e.code !== "string" || !CODES.has(e.code)) return null;
  const out: BillingError = {
    code: e.code as BillingErrorCode,
    message: typeof e.message === "string" ? e.message : "",
  };
  if (e.window === "5h" || e.window === "week") out.window = e.window;
  if (typeof e.resetAt === "number") out.resetAt = e.resetAt;
  return out;
}

function parseWindow(v: unknown): WindowState | null {
  if (!isObj(v)) return null;
  const { usedMicro, limitMicro, resetAt } = v;
  if (typeof usedMicro !== "number" || typeof limitMicro !== "number" || typeof resetAt !== "number") return null;
  return { usedMicro, limitMicro, resetAt };
}

export function parseBillingMe(payload: unknown): BillingMe | null {
  if (!isObj(payload)) return null;
  const plan = payload.plan === "lite" || payload.plan === "pro" || payload.plan === "max" ? payload.plan : null;
  const status = payload.status;
  if (status !== "active" && status !== "past_due" && status !== "canceled" && status !== "none") return null;
  let windows: BillingMe["windows"] = null;
  if (payload.windows !== null) {
    if (!isObj(payload.windows)) return null;
    const h5 = parseWindow(payload.windows.h5);
    const week = parseWindow(payload.windows.week);
    if (!h5 || !week) return null;
    windows = { h5, week };
  }
  if (!isObj(payload.addon) || typeof payload.addon.remainingMicro !== "number") return null;
  const expiresAt = typeof payload.addon.expiresAt === "number" ? payload.addon.expiresAt : null;
  const periodEnd = typeof payload.periodEnd === "number" ? payload.periodEnd : null;
  const models = Array.isArray(payload.models) ? payload.models.filter((m): m is string => typeof m === "string") : [];
  return { plan, status, windows, addon: { remainingMicro: payload.addon.remainingMicro, expiresAt }, periodEnd, models };
}

export const MICRO_PER_CREDIT = 10_000;

export function creditOf(micro: number): number {
  return micro / MICRO_PER_CREDIT;
}

/** "12.3 credit"。整数不带小数点：0 credit 比 0.0 credit 读得顺 */
export function fmtCredit(micro: number): string {
  const c = creditOf(micro);
  return `${Number.isInteger(c) ? c : c.toFixed(1)} credit`;
}

/** 响应头里的剩余额度。缺的头不进结果——「没报」≠「剩 0」 */
export function remainingFromHeaders(h: Headers): { h5?: number; week?: number; addon?: number; plan?: string } {
  const out: { h5?: number; week?: number; addon?: number; plan?: string } = {};
  const num = (name: string): number | undefined => {
    const raw = h.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const h5 = num(BILLING_HEADERS.h5);
  const week = num(BILLING_HEADERS.week);
  const addon = num(BILLING_HEADERS.addon);
  const plan = h.get(BILLING_HEADERS.plan);
  if (h5 !== undefined) out.h5 = h5;
  if (week !== undefined) out.week = week;
  if (addon !== undefined) out.addon = addon;
  if (plan) out.plan = plan;
  return out;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/shared/billing.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/shared/billing.ts tests/shared/billing.test.ts
git commit -m "feat(billing): 三端共用的计费线上约定（#696）

/me 形状、响应头名、错误码、on-behalf-of 头名放一份，edge/桌面/runtime 一起 import——
同 wire.ts 的纪律：改约定 = 三端同一次改，不会出现网关加了字段客户端不认的分叉。
credit = 美分：托管花费不能和 BYOK 的 \$X 长得一样（ADR-0176 决定五）。"
```

---

### Task 2: 数据模型 `0017_subscriptions.sql` + seed

**Files:**
- Create: `supabase/migrations/0017_subscriptions.sql`
- Create: `supabase/seed/0017_plans_routes.sql`
- Create: `supabase/checks/0017_subscriptions.check.sql`
- Modify: `supabase/README.md`（表格加一行 + 执行状态段加一句「0017 未跑」）

**Interfaces:**
- Produces：表名与列名如下，Task 7 的 PostgREST 查询逐字引用它们。

- [ ] **Step 1: 写 migration**

```sql
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
```

- [ ] **Step 2: 写 seed**

```sql
-- supabase/seed/0017_plans_routes.sql
-- 档位与首批路由。**价格是抄的**（2026-09-02，DeepSeek 官网 CNY 价 + ADR-0175 表；
-- GLM-5.3 按 GLM-5.1 价抄，待核），汇率按 1 USD = 7.2 CNY 折。
-- 抄表日期比价格本身重要——改价直接 update 这几行，不发版。
-- stripe_price_id 由维护者在 Stripe 后台建完 Product/Price 后填。
--
-- 换算：CNY X /M → micro-USD/M = round(X / 7.2 * 1_000_000)

insert into public.plan (id, price_usd_cents, monthly_budget_micro, week_limit_micro, window5h_limit_micro, addon_unit_micro, capabilities)
values
  ('lite', 1900, 13300000, 3325000, 665000, 0, '{"image":false,"video":false}'),
  ('pro',  5900, 41300000, 10325000, 2065000, 0, '{"image":false,"video":false}'),
  ('max',  8900, 62300000, 15575000, 3115000, 0, '{"image":false,"video":false}'),
  -- 加购：一个单位 $10，折 70% = 7 USD credit
  ('addon', 1000, 0, 0, 0, 7000000, '{}')
on conflict (id) do update set
  price_usd_cents = excluded.price_usd_cents,
  monthly_budget_micro = excluded.monthly_budget_micro,
  week_limit_micro = excluded.week_limit_micro,
  window5h_limit_micro = excluded.window5h_limit_micro,
  addon_unit_micro = excluded.addon_unit_micro,
  updated_at = now();

insert into public.model_route (id, logical_model, platform, base_url, wire_model, price_in_micro_per_m, price_cache_micro_per_m, price_out_micro_per_m, default_max_tokens, priority)
values
  -- DeepSeek V4 Flash：¥1.00 / ¥0.02 / ¥2.00
  ('deepseek-v4-flash@deepseek', 'deepseek-v4-flash', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash', 138889, 2778, 277778, 8192, 10),
  -- DeepSeek V4 Pro：¥3.00 / ¥0.025 / ¥6.00（cache 价是异常值，ADR-0174「会被推翻的前提」——核实后改这一行）
  ('deepseek-v4-pro@deepseek', 'deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', 416667, 3472, 833333, 8192, 10),
  -- GLM-5.3：按 GLM-5.1 ¥6.00 / ¥1.30 / ¥24.00 抄，待核
  ('glm-5.3@zhipu', 'glm-5.3', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 833333, 180556, 3333333, 8192, 10)
on conflict (id) do update set
  price_in_micro_per_m = excluded.price_in_micro_per_m,
  price_cache_micro_per_m = excluded.price_cache_micro_per_m,
  price_out_micro_per_m = excluded.price_out_micro_per_m,
  default_max_tokens = excluded.default_max_tokens;
```

- [ ] **Step 3: 写 check 脚本**

```sql
-- supabase/checks/0017_subscriptions.check.sql
-- 跑完 0017 + seed 后在 SQL editor 执行；每行期望 PASS
select 'plan rows' as check, case when count(*) = 4 then 'PASS' else 'FAIL' end from public.plan;
select 'lite limits' as check, case when window5h_limit_micro = 665000 and week_limit_micro = 3325000 then 'PASS' else 'FAIL' end
  from public.plan where id = 'lite';
select 'routes enabled' as check, case when count(*) >= 3 then 'PASS' else 'FAIL' end from public.model_route where enabled;
select 'usage_event rls' as check, case when relrowsecurity then 'PASS' else 'FAIL' end
  from pg_class where oid = 'public.usage_event'::regclass;
select 'no write policy' as check, case when count(*) = 0 then 'PASS' else 'FAIL' end
  from pg_policies where schemaname = 'public'
   and tablename in ('plan','subscription','credit_grant','usage_event','model_route')
   and cmd <> 'SELECT';
```

- [ ] **Step 4: README 加行**

在 `supabase/README.md` 的「各文件要点」表末尾加：

```
| `0017_subscriptions.sql` | 订阅制五张表（`plan` / `subscription` / `credit_grant` / `usage_event` / `model_route`）+ RLS；seed 在 `seed/0017_plans_routes.sql`（档位数字与首批价表，**价格待核**） | ADR-0174 起三篇 + spec 2026-09-02；旧 `token_*` 三张不动不认（#696）。**尚未在 Cloud 上执行** |
```

- [ ] **Step 5: 提交**

```bash
git add supabase/migrations/0017_subscriptions.sql supabase/seed/0017_plans_routes.sql supabase/checks/0017_subscriptions.check.sql supabase/README.md
git commit -m "feat(db): 订阅制五张表 + RLS + 档位/路由 seed（#696）

usage_event 是钱的唯一事实，窗口与加购余额都是投影（ADR-0174 第 7 条）；
旧 token_* 三张不动不认——赠额时代的账不转换（维护者 2026-09-02 拍板）。
档位算好落行而不是让 Worker 现算：改价只动 DB 行，不发版。
seed 里的价是抄的，抄表日期在文件头。"
```

---

### Task 3: 双窗计量纯逻辑 `services/edge/src/quota.ts`

**Files:**
- Create: `services/edge/src/quota.ts`
- Test: `tests/edge/quota.test.ts`

**Interfaces:**
- Produces（Task 4 的 `QuotaPort` 与 Task 7 的 DO 都建在这些函数上）：
  - `interface PlanSnapshot { planId: string; status: "active" | "past_due" | "canceled"; window5hLimitMicro: number; weekLimitMicro: number; periodStartMs: number; periodEndMs: number }`
  - `interface QuotaState { open5hAt: number | null; used5hMicro: number; weekStartAt: number | null; usedWeekMicro: number; holds: Record<string, Hold>; addonMicro: number; addonExpiresAt: number | null }`
  - `interface Hold { micro: number; at: number; chargedTo: "window" | "addon" }`
  - `emptyState(): QuotaState`
  - `roll(state, now, plan): QuotaState`（惰性推进：过期窗清零、过期 hold 释放、过期加购归零）
  - `hold(state, plan, requestId, estimateMicro, now): HoldResult`
  - `settle(state, requestId, costMicro): { state: QuotaState; hold: Hold } | null`
  - `release(state, requestId): QuotaState`
  - `view(state, plan, now): { h5: WindowState; week: WindowState } | null` 与 `remaining(state, plan, now): { h5: number; week: number; addon: number }`
  - `rebuild(input: { events: { at: number; costMicro: number; chargedTo: "window" | "addon" }[]; grants: { micro: number; expiresAt: number }[]; addonConsumedMicro: number }, plan, now): QuotaState`
  - 常量 `WINDOW_5H_MS`、`WEEK_MS`、`HOLD_TTL_MS = 10 min`、`MAX_INFLIGHT = 4`

> 设计说明：ADR-0174 写的是「环形桶」。固定窗口 + 到点整窗清零，一个累计数就够（清零 = 归零），环形桶是滑动窗才需要的结构。这里选累计数，理由写进文件头；周窗跨段时同样整段归零。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/quota.test.ts
import { describe, expect, it } from "vitest";
import {
  emptyState, hold, HOLD_TTL_MS, MAX_INFLIGHT, rebuild, release, remaining, roll, settle, view,
  WEEK_MS, WINDOW_5H_MS, type PlanSnapshot,
} from "../../services/edge/src/quota.js";

const T0 = 1_800_000_000_000;
const plan: PlanSnapshot = {
  planId: "lite", status: "active",
  window5hLimitMicro: 665_000, weekLimitMicro: 3_325_000,
  periodStartMs: T0, periodEndMs: T0 + 30 * 86_400_000,
};

describe("hold / settle / release", () => {
  it("第一次 hold 开 5h 窗；settle 后 used 记的是实际成本不是估算", () => {
    const r = hold(emptyState(), plan, "r1", 100_000, T0 + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.open5hAt).toBe(T0 + 1000);
    expect(r.chargedTo).toBe("window");
    const s = settle(r.state, "r1", 40_000)!;
    expect(s.state.used5hMicro).toBe(40_000);
    expect(s.state.usedWeekMicro).toBe(40_000);
    expect(Object.keys(s.state.holds)).toEqual([]);
  });

  it("settle 一个不存在的 requestId 回 null（已结算/已释放，幂等）", () => {
    expect(settle(emptyState(), "nope", 1)).toBeNull();
  });

  it("release 退掉 hold，什么都不记", () => {
    const r = hold(emptyState(), plan, "r1", 100_000, T0);
    if (!r.ok) throw new Error();
    const s = release(r.state, "r1");
    expect(s.holds).toEqual({});
    expect(s.used5hMicro).toBe(0);
  });

  it("hold 计入准入：已用 + 未结算 hold + 本次估算 > 5h 上限 → quota_exhausted(5h) 带 resetAt", () => {
    let st = emptyState();
    const a = hold(st, plan, "a", 600_000, T0); if (!a.ok) throw new Error(); st = a.state;
    const b = hold(st, plan, "b", 100_000, T0 + 1);
    expect(b).toMatchObject({ ok: false, code: "quota_exhausted", window: "5h", resetAt: T0 + WINDOW_5H_MS });
  });

  it("周窗耗尽但 5h 窗没耗尽 → window: 'week'，resetAt 是下一段周窗起点", () => {
    let st = emptyState();
    st = { ...st, weekStartAt: T0, usedWeekMicro: 3_300_000, open5hAt: T0, used5hMicro: 0 };
    const r = hold(st, plan, "x", 100_000, T0 + 1000);
    expect(r).toMatchObject({ ok: false, code: "quota_exhausted", window: "week", resetAt: T0 + WEEK_MS });
  });

  it("窗口耗尽但有加购 → hold 记到 addon，不进窗", () => {
    let st = { ...emptyState(), addonMicro: 500_000, addonExpiresAt: T0 + 365 * 86_400_000 };
    st = { ...st, open5hAt: T0, used5hMicro: 660_000, weekStartAt: T0, usedWeekMicro: 660_000 };
    const r = hold(st, plan, "x", 100_000, T0 + 1000);
    expect(r.ok && r.chargedTo).toBe("addon");
    if (!r.ok) return;
    const s = settle(r.state, "x", 30_000)!;
    expect(s.state.addonMicro).toBe(470_000);
    expect(s.state.used5hMicro).toBe(660_000); // 窗口一分没动
  });

  it("加购余额不够本次估算 → 仍然 quota_exhausted", () => {
    const st = { ...emptyState(), addonMicro: 10, addonExpiresAt: T0 + 1e9, open5hAt: T0, used5hMicro: 665_000, weekStartAt: T0 };
    expect(hold(st, plan, "x", 100_000, T0 + 1).ok).toBe(false);
  });

  it("无订阅 / past_due → no_subscription", () => {
    expect(hold(emptyState(), null, "x", 1, T0)).toMatchObject({ ok: false, code: "no_subscription" });
    expect(hold(emptyState(), { ...plan, status: "past_due" }, "x", 1, T0)).toMatchObject({ ok: false, code: "no_subscription" });
  });

  it("并发 hold 超过 MAX_INFLIGHT → too_many_inflight，且这条判断在额度判断之前", () => {
    let st = emptyState();
    for (let i = 0; i < MAX_INFLIGHT; i += 1) {
      const r = hold(st, plan, `r${i}`, 1, T0 + i); if (!r.ok) throw new Error(); st = r.state;
    }
    expect(hold(st, plan, "over", 1, T0 + 99)).toMatchObject({ ok: false, code: "too_many_inflight" });
  });
});

describe("roll：惰性推进", () => {
  it("5h 窗到点整窗清零、open5hAt 归 null；周窗跨段同样清零", () => {
    const st = { ...emptyState(), open5hAt: T0, used5hMicro: 500, weekStartAt: T0, usedWeekMicro: 900 };
    const r1 = roll(st, T0 + WINDOW_5H_MS - 1, plan);
    expect(r1.used5hMicro).toBe(500);
    const r2 = roll(st, T0 + WINDOW_5H_MS, plan);
    expect(r2.used5hMicro).toBe(0);
    expect(r2.open5hAt).toBeNull();
    expect(r2.usedWeekMicro).toBe(900);
    const r3 = roll(st, T0 + WEEK_MS + 5, plan);
    expect(r3.usedWeekMicro).toBe(0);
    expect(r3.weekStartAt).toBe(T0 + WEEK_MS);
  });

  it("周窗锚定 periodStart：now 落在第 n 段就从 periodStart + n×7d 起算", () => {
    const st = roll(emptyState(), T0 + 2 * WEEK_MS + 100, plan);
    expect(st.weekStartAt).toBe(T0 + 2 * WEEK_MS);
  });

  it("hold 超过 HOLD_TTL_MS 没结算 → 自动释放", () => {
    const r = hold(emptyState(), plan, "stale", 1000, T0); if (!r.ok) throw new Error();
    const st = roll(r.state, T0 + HOLD_TTL_MS + 1, plan);
    expect(st.holds).toEqual({});
  });

  it("加购过期 → 余额归零", () => {
    const st = roll({ ...emptyState(), addonMicro: 5, addonExpiresAt: T0 }, T0 + 1, plan);
    expect(st.addonMicro).toBe(0);
  });

  it("换了订阅周期（periodStart 变）→ 周窗重开", () => {
    const st = { ...emptyState(), weekStartAt: T0, usedWeekMicro: 100 };
    const r = roll(st, T0 + 10, { ...plan, periodStartMs: T0 + 5 });
    expect(r.usedWeekMicro).toBe(0);
    expect(r.weekStartAt).toBe(T0 + 5);
  });
});

describe("view / remaining / rebuild", () => {
  it("view：没开 5h 窗时 resetAt = now（没东西可等）", () => {
    const v = view(emptyState(), plan, T0)!;
    expect(v.h5).toEqual({ usedMicro: 0, limitMicro: 665_000, resetAt: T0 });
    expect(v.week.resetAt).toBe(T0 + WEEK_MS);
    expect(view(emptyState(), null, T0)).toBeNull();
  });

  it("remaining 扣掉未结算 hold", () => {
    const r = hold(emptyState(), plan, "a", 100, T0); if (!r.ok) throw new Error();
    expect(remaining(r.state, plan, T0)).toEqual({ h5: 664_900, week: 3_324_900, addon: 0 });
  });

  it("rebuild：只算当前 5h 窗 / 当前周段内的事件；加购 = 未过期 grant 之和 − 已消耗", () => {
    const now = T0 + WEEK_MS + 8 * 3_600_000; // 第二周段，8 小时处（6 小时前的那条在周段内、不在 5h 窗内）
    const st = rebuild({
      events: [
        { at: T0 + 1000, costMicro: 999, chargedTo: "window" },                    // 上一周段，不算
        { at: now - 2 * 3_600_000, costMicro: 10, chargedTo: "window" },           // 本周段 + 本 5h 窗内
        { at: now - 6 * 3_600_000, costMicro: 20, chargedTo: "window" },           // 本周段，但不在本 5h 窗
        { at: now - 100, costMicro: 5, chargedTo: "addon" },                       // 加购不进窗
      ],
      grants: [{ micro: 1000, expiresAt: now + 1 }, { micro: 999, expiresAt: now - 1 }],
      addonConsumedMicro: 300,
    }, plan, now);
    expect(st.usedWeekMicro).toBe(30);
    expect(st.used5hMicro).toBe(10);
    expect(st.open5hAt).toBe(now - 2 * 3_600_000);
    expect(st.addonMicro).toBe(700);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/edge/quota.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

```ts
// services/edge/src/quota.ts
// 双固定窗计量的纯逻辑（ADR-0174 第 2/3/4/5/9 条）。跑在 Quota DO 里，也跑在根门禁里。
//
// 为什么是累计数不是环形桶：ADR-0174 第 7 条写的「环形桶」是滑动窗的数据结构；
// 第 3 条又定了窗口是**固定**的、到点整窗清零。固定窗一个累计数就够
// （清零 = 归零），桶只会多出一层没人读的精度。周窗跨段同样整段归零。
//
// 全部惰性：没有 alarm、没有定时器。每次操作前先 roll(now) 把过期的东西清掉。
// DO 单线程，state 的读改写在一次 fetch 里完成，天然无竞态。

export const WINDOW_5H_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;
/** 一个 hold 最多挂多久：流式响应最长也就几分钟，10 分钟没 settle = 那次调用没回来 */
export const HOLD_TTL_MS = 10 * 60_000;
/** 单用户并发上限（ADR-0174 第 5 条「加购无视限速」的兜底） */
export const MAX_INFLIGHT = 4;

export interface PlanSnapshot {
  planId: string;
  status: "active" | "past_due" | "canceled";
  window5hLimitMicro: number;
  weekLimitMicro: number;
  /** 周窗锚定日：subscription.current_period_start */
  periodStartMs: number;
  periodEndMs: number;
}

export interface Hold {
  micro: number;
  at: number;
  chargedTo: "window" | "addon";
}

export interface QuotaState {
  /** 本 5h 窗第一次 hold 的时刻；null = 没开着的窗 */
  open5hAt: number | null;
  used5hMicro: number;
  /** 当前周段起点（periodStart + n × 7d）；null = 还没算过 */
  weekStartAt: number | null;
  usedWeekMicro: number;
  holds: Record<string, Hold>;
  addonMicro: number;
  addonExpiresAt: number | null;
}

export interface WindowState {
  usedMicro: number;
  limitMicro: number;
  resetAt: number;
}

export type HoldResult =
  | { ok: true; state: QuotaState; chargedTo: "window" | "addon" }
  | { ok: false; code: "no_subscription" }
  | { ok: false; code: "too_many_inflight" }
  | { ok: false; code: "quota_exhausted"; window: "5h" | "week"; resetAt: number };

export function emptyState(): QuotaState {
  return {
    open5hAt: null, used5hMicro: 0, weekStartAt: null, usedWeekMicro: 0,
    holds: {}, addonMicro: 0, addonExpiresAt: null,
  };
}

/** now 落在哪一段周窗 */
function weekStartFor(now: number, periodStartMs: number): number {
  const n = Math.max(0, Math.floor((now - periodStartMs) / WEEK_MS));
  return periodStartMs + n * WEEK_MS;
}

/** 惰性推进：过期 5h 窗清零、周窗跨段清零、过期 hold 释放、过期加购归零 */
export function roll(state: QuotaState, now: number, plan: PlanSnapshot | null): QuotaState {
  let s = state;
  if (s.open5hAt !== null && now >= s.open5hAt + WINDOW_5H_MS) {
    s = { ...s, open5hAt: null, used5hMicro: 0 };
  }
  if (plan) {
    const ws = weekStartFor(now, plan.periodStartMs);
    if (s.weekStartAt !== ws) s = { ...s, weekStartAt: ws, usedWeekMicro: 0 };
  }
  const holds: Record<string, Hold> = {};
  let dropped = false;
  for (const [id, h] of Object.entries(s.holds)) {
    if (now - h.at > HOLD_TTL_MS) dropped = true;
    else holds[id] = h;
  }
  if (dropped) s = { ...s, holds };
  if (s.addonExpiresAt !== null && now >= s.addonExpiresAt && s.addonMicro !== 0) {
    s = { ...s, addonMicro: 0 };
  }
  return s;
}

function heldMicro(state: QuotaState, chargedTo: "window" | "addon"): number {
  let sum = 0;
  for (const h of Object.values(state.holds)) if (h.chargedTo === chargedTo) sum += h.micro;
  return sum;
}

function reset5hAt(state: QuotaState, now: number): number {
  return state.open5hAt === null ? now : state.open5hAt + WINDOW_5H_MS;
}

function resetWeekAt(state: QuotaState, plan: PlanSnapshot, now: number): number {
  return (state.weekStartAt ?? weekStartFor(now, plan.periodStartMs)) + WEEK_MS;
}

/** 准入 + 预扣。顺序固定：订阅 → 并发 → 窗口 → 加购垫底 */
export function hold(
  state: QuotaState, plan: PlanSnapshot | null, requestId: string, estimateMicro: number, now: number
): HoldResult {
  if (!plan || plan.status !== "active") return { ok: false, code: "no_subscription" };
  const s = roll(state, now, plan);
  if (Object.keys(s.holds).length >= MAX_INFLIGHT) return { ok: false, code: "too_many_inflight" };

  const heldW = heldMicro(s, "window");
  const over5h = s.used5hMicro + heldW + estimateMicro > plan.window5hLimitMicro;
  const overWk = s.usedWeekMicro + heldW + estimateMicro > plan.weekLimitMicro;
  if (!over5h && !overWk) {
    const open5hAt = s.open5hAt ?? now;
    return {
      ok: true, chargedTo: "window",
      state: { ...s, open5hAt, holds: { ...s.holds, [requestId]: { micro: estimateMicro, at: now, chargedTo: "window" } } },
    };
  }
  // 窗口不够 → 加购垫底（不进窗）。加购也不够 → 说清是哪个窗、何时恢复
  if (s.addonMicro - heldMicro(s, "addon") >= estimateMicro) {
    return {
      ok: true, chargedTo: "addon",
      state: { ...s, holds: { ...s.holds, [requestId]: { micro: estimateMicro, at: now, chargedTo: "addon" } } },
    };
  }
  return over5h
    ? { ok: false, code: "quota_exhausted", window: "5h", resetAt: reset5hAt(s, now) }
    : { ok: false, code: "quota_exhausted", window: "week", resetAt: resetWeekAt(s, plan, now) };
}

/** 结算：按实际成本记账，退掉 hold。null = 这个 requestId 没有挂着的 hold（已结算/已释放/超时被清）——
    调用方据此不写 usage_event，幂等 */
export function settle(state: QuotaState, requestId: string, costMicro: number): { state: QuotaState; hold: Hold } | null {
  const h = state.holds[requestId];
  if (!h) return null;
  const { [requestId]: _dropped, ...holds } = state.holds;
  const base = { ...state, holds };
  if (h.chargedTo === "addon") return { state: { ...base, addonMicro: Math.max(0, base.addonMicro - costMicro) }, hold: h };
  return {
    state: { ...base, used5hMicro: base.used5hMicro + costMicro, usedWeekMicro: base.usedWeekMicro + costMicro },
    hold: h,
  };
}

export function release(state: QuotaState, requestId: string): QuotaState {
  if (!(requestId in state.holds)) return state;
  const { [requestId]: _dropped, ...holds } = state.holds;
  return { ...state, holds };
}

export function view(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: WindowState; week: WindowState } | null {
  if (!plan) return null;
  const s = roll(state, now, plan);
  return {
    h5: { usedMicro: s.used5hMicro, limitMicro: plan.window5hLimitMicro, resetAt: reset5hAt(s, now) },
    week: { usedMicro: s.usedWeekMicro, limitMicro: plan.weekLimitMicro, resetAt: resetWeekAt(s, plan, now) },
  };
}

/** 响应头用：扣掉未结算 hold 之后还剩多少 */
export function remaining(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: number; week: number; addon: number } {
  const s = roll(state, now, plan);
  const heldW = heldMicro(s, "window");
  return {
    h5: plan ? Math.max(0, plan.window5hLimitMicro - s.used5hMicro - heldW) : 0,
    week: plan ? Math.max(0, plan.weekLimitMicro - s.usedWeekMicro - heldW) : 0,
    addon: Math.max(0, s.addonMicro - heldMicro(s, "addon")),
  };
}

export interface RebuildInput {
  /** usage_event 里本周段起（含）之后的行 */
  events: { at: number; costMicro: number; chargedTo: "window" | "addon" }[];
  grants: { micro: number; expiresAt: number }[];
  /** usage_event 里 charged_to='addon' 的全部 cost 之和（不限周段） */
  addonConsumedMicro: number;
}

/** DO 冷启动 / 对不上时从事实重建投影。5h 窗的起点 = 最近 5 小时内最早那条 window 事件 */
export function rebuild(input: RebuildInput, plan: PlanSnapshot | null, now: number): QuotaState {
  let st = emptyState();
  if (plan) {
    const ws = weekStartFor(now, plan.periodStartMs);
    let usedWeek = 0, used5h = 0, open5hAt: number | null = null;
    const windowEvents = input.events
      .filter((e) => e.chargedTo === "window" && e.at >= ws)
      .sort((a, b) => a.at - b.at);
    for (const e of windowEvents) {
      usedWeek += e.costMicro;
      if (e.at > now - WINDOW_5H_MS) {
        if (open5hAt === null) open5hAt = e.at;
        used5h += e.costMicro;
      }
    }
    st = { ...st, weekStartAt: ws, usedWeekMicro: usedWeek, open5hAt, used5hMicro: used5h };
  }
  let granted = 0;
  let expiresAt: number | null = null;
  for (const g of input.grants) {
    if (g.expiresAt <= now) continue;
    granted += g.micro;
    expiresAt = expiresAt === null ? g.expiresAt : Math.min(expiresAt, g.expiresAt);
  }
  return { ...st, addonMicro: Math.max(0, granted - input.addonConsumedMicro), addonExpiresAt: expiresAt };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/edge/quota.test.ts`
Expected: PASS（全部）。若「窗口耗尽但有加购」那条失败，检查 `hold` 里 `over5h` 判断用的是 `heldW`（window 的 hold），不是全部 hold。

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/quota.ts tests/edge/quota.test.ts
git commit -m "feat(edge): 双固定窗计量纯逻辑——hold/settle/release + 加购垫底 + 从事实重建（#696）

固定窗用累计数不用环形桶：到点整窗清零，桶只会多一层没人读的精度（ADR-0174 第 3 条）。
全部惰性推进，DO 睡着不花钱。hold 计入准入是为了堵并发打穿窗口（第 9 条）。"
```

---

### Task 4: 网关请求流纯逻辑 `services/edge/src/llmGateway.ts`

**Files:**
- Create: `services/edge/src/llmGateway.ts`
- Test: `tests/edge/llmGateway.test.ts`

**Interfaces:**
- Consumes：`HoldResult` 的错误分支形状（Task 3），`BILLING_HEADERS`（Task 1）
- Produces（Task 6 装配、Task 7 实现 `QuotaPort`）：
  ```ts
  export interface RouteRow { id: string; logicalModel: string; platform: string; baseUrl: string; wireModel: string;
    priceInMicroPerM: number; priceCacheMicroPerM: number; priceOutMicroPerM: number; defaultMaxTokens: number }
  export interface Caller { uid: string; source: "desktop" | "runtime"; workspaceId: string; sessionId: string }
  export interface UsageCounts { promptTokens: number; cachedTokens: number; completionTokens: number }
  export type HoldOutcome = { ok: true; chargedTo: "window" | "addon" } | { ok: false; code: "no_subscription" | "too_many_inflight" }
    | { ok: false; code: "quota_exhausted"; window: "5h" | "week"; resetAt: number }
  export interface SettleMeta { caller: Caller; route: RouteRow; usage: UsageCounts; costMicro: number }
  export interface QuotaPort {
    hold(uid: string, requestId: string, estimateMicro: number): Promise<HoldOutcome>;
    settle(uid: string, requestId: string, meta: SettleMeta): Promise<void>;
    release(uid: string, requestId: string): Promise<void>;
    remaining(uid: string): Promise<{ h5: number; week: number; addon: number; plan: string | null }>;
  }
  export interface LlmGatewayDeps { routes: () => Promise<RouteRow[]>; quota: QuotaPort;
    upstreamKey: (platform: string) => string | undefined; fetchImpl?: typeof fetch; newRequestId?: () => string }
  export function pickRoute(routes: RouteRow[], logicalModel: string): RouteRow | null
  export function estimateMicro(bodyBytes: number, maxTokens: number, route: RouteRow): number
  export function costMicro(u: UsageCounts, route: RouteRow): number
  export function parseUsage(v: unknown): UsageCounts | null
  export function tapSseUsage(body: ReadableStream<Uint8Array>, onDone: (u: UsageCounts | null) => void): ReadableStream<Uint8Array>
  export function createLlmGateway(deps: LlmGatewayDeps): (req: Request, caller: Caller) => Promise<Response>
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/llmGateway.test.ts
import { describe, expect, it } from "vitest";
import {
  costMicro, createLlmGateway, estimateMicro, parseUsage, pickRoute, tapSseUsage,
  type Caller, type HoldOutcome, type QuotaPort, type RouteRow, type SettleMeta,
} from "../../services/edge/src/llmGateway.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";

const flash: RouteRow = {
  id: "deepseek-v4-flash@deepseek", logicalModel: "deepseek-v4-flash", platform: "deepseek",
  baseUrl: "https://up/v1", wireModel: "deepseek-v4-flash",
  priceInMicroPerM: 1_000_000, priceCacheMicroPerM: 100_000, priceOutMicroPerM: 2_000_000, defaultMaxTokens: 1000,
};
const caller: Caller = { uid: "u1", source: "desktop", workspaceId: "", sessionId: "" };

function quotaStub(outcome: HoldOutcome = { ok: true, chargedTo: "window" }) {
  const calls: { hold: string[]; settle: SettleMeta[]; release: string[] } = { hold: [], settle: [], release: [] };
  const quota: QuotaPort = {
    hold: async (_uid, rid) => { calls.hold.push(rid); return outcome; },
    settle: async (_uid, _rid, meta) => { calls.settle.push(meta); },
    release: async (_uid, rid) => { calls.release.push(rid); },
    remaining: async () => ({ h5: 100, week: 200, addon: 0, plan: "lite" }),
  };
  return { quota, calls };
}

const sse = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
  });

function upstream(res: () => Response) {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return res();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const chatReq = (body: unknown) =>
  new Request("https://edge/llm/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

describe("纯函数", () => {
  it("pickRoute：按 logicalModel 取第一条；不认识回 null", () => {
    expect(pickRoute([flash], "deepseek-v4-flash")).toBe(flash);
    expect(pickRoute([flash], "gpt-9")).toBeNull();
  });

  it("estimateMicro：body 字节 ÷ 3 当 prompt token，加 max_tokens × 输出价", () => {
    // 3000 字节 → 1000 token × 1 micro + 1000 × 2 micro = 3000
    expect(estimateMicro(3000, 1000, flash)).toBe(3000);
  });

  it("costMicro：cached 从 prompt 里扣，按 cache 价算", () => {
    // prompt 1000（其中 cached 400）：600×1 + 400×0.1 = 640；out 100×2 = 200
    expect(costMicro({ promptTokens: 1000, cachedTokens: 400, completionTokens: 100 }, flash)).toBe(840);
  });

  it("parseUsage：DeepSeek 与 OpenAI 两种 cache 方言都认；没 usage 回 null", () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }))
      .toEqual({ promptTokens: 10, cachedTokens: 4, completionTokens: 2 });
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }))
      .toEqual({ promptTokens: 10, cachedTokens: 3, completionTokens: 2 });
    expect(parseUsage(null)).toBeNull();
  });

  it("tapSseUsage：原样透传字节，结束时把最后一个带 usage 的块交出去", async () => {
    let got: unknown = "unset";
    const tapped = tapSseUsage(sse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    ]), (u) => { got = u; });
    const text = await new Response(tapped).text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
    expect(got).toEqual({ promptTokens: 5, cachedTokens: 0, completionTokens: 1 });
  });

  it("tapSseUsage：流里没有 usage → onDone(null)", async () => {
    let got: unknown = "unset";
    await new Response(tapSseUsage(sse(["data: {}\n\n"]), (u) => { got = u; })).text();
    expect(got).toBeNull();
  });
});

describe("createLlmGateway", () => {
  it("不认识的逻辑 id → 400 unknown_model，不 hold", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k" });
    const res = await gw(chatReq({ model: "nope", messages: [] }), caller);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unknown_model");
    expect(calls.hold).toEqual([]);
  });

  it("hold 被拒 → 原样映射：quota_exhausted 429 带 window/resetAt；no_subscription 402；too_many_inflight 429", async () => {
    const mk = (o: HoldOutcome) =>
      createLlmGateway({ routes: async () => [flash], quota: quotaStub(o).quota, upstreamKey: () => "k" });
    const r1 = await mk({ ok: false, code: "quota_exhausted", window: "week", resetAt: 42 })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ error: { type: "otto_edge", code: "quota_exhausted", window: "week", resetAt: 42 } });
    expect((await mk({ ok: false, code: "no_subscription" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(402);
    expect((await mk({ ok: false, code: "too_many_inflight" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(429);
  });

  it("流式：换 wire_model、加平台 key、强制 include_usage；透传 SSE；结束后 settle 且带剩余额度头", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":50}}\n\ndata: [DONE]\n\n',
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: (p) => (p === "deepseek" ? "sk-up" : undefined), fetchImpl: up.fetchImpl, newRequestId: () => "rid-1" });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true }), caller);
    expect(res.status).toBe(200);
    expect(res.headers.get(BILLING_HEADERS.h5)).toBe("100");
    expect(res.headers.get(BILLING_HEADERS.plan)).toBe("lite");
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://up/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-up");
    const sentBody = JSON.parse(await sent.text());
    expect(sentBody.model).toBe("deepseek-v4-flash");
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(calls.hold).toEqual(["rid-1"]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual({ promptTokens: 100, cachedTokens: 50, completionTokens: 10 });
    // 50×1 + 50×0.1 + 10×2 = 75
    expect(calls.settle[0]!.costMicro).toBe(75);
    expect(calls.release).toEqual([]);
  });

  it("非流式：JSON 回来直接结算", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("ok");
    expect(calls.settle[0]!.costMicro).toBe(12);
  });

  it("上游 5xx → release，回 502 upstream，带上游状态码与正文片段", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("boom", { status: 503 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "upstream", upstreamStatus: 503 });
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("上游 4xx（比如我们的 key 错）→ 也是 release + 502：客户端不该看到上游 401 然后去怀疑自己的 key", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("bad key", { status: 401 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    expect((await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(502);
    expect(calls.release).toHaveLength(1);
  });

  it("流里没有 usage → release 不 settle（没账可记）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse(["data: {}\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    await (await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: true }), caller)).text();
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("平台没配 key → 502 upstream（code 一样，message 说清是服务端没配），不 hold", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => undefined });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect(calls.hold).toEqual([]);
  });

  it("body 不是 JSON / 没 model → 400 bad_request", async () => {
    const gw = createLlmGateway({ routes: async () => [flash], quota: quotaStub().quota, upstreamKey: () => "k" });
    const res = await gw(new Request("https://edge/llm/v1/chat/completions", { method: "POST", body: "{" }), caller);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/edge/llmGateway.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

```ts
// services/edge/src/llmGateway.ts
// 托管模式的模型网关（ADR-0174 / 0175 / 0176，spec 2026-09-02 第 2 节）。
// 纯 Web Request/Response，运行时无关：tests/edge/llmGateway.test.ts 直接打它。
// 身份已经在 edge.ts 验完，这里拿到的是 Caller；DO 与 Supabase 都藏在 QuotaPort 后面。
//
// 一次调用：解析 → 选路 → hold（预扣估算）→ 转发 → 旁路挑 usage → settle（退差额）。
// 上游任何失败 / 流里没 usage → release，不记账。**先花后扣要有 hold**（ADR-0174 第 9 条），
// 否则并发请求能把窗口打穿。
//
// 上游的 4xx 也翻成 502：那是我们和上游之间的事（key 错、账户欠费），
// 让客户端看到上游 401 会让用户去怀疑自己的 key——而他根本没用自己的 key。

import { BILLING_HEADERS } from "../../../src/shared/billing.js";

export interface RouteRow {
  id: string;
  logicalModel: string;
  platform: string;
  baseUrl: string;
  wireModel: string;
  priceInMicroPerM: number;
  priceCacheMicroPerM: number;
  priceOutMicroPerM: number;
  defaultMaxTokens: number;
}

export interface Caller {
  uid: string;
  source: "desktop" | "runtime";
  workspaceId: string;
  sessionId: string;
}

export interface UsageCounts {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export type HoldOutcome =
  | { ok: true; chargedTo: "window" | "addon" }
  | { ok: false; code: "no_subscription" | "too_many_inflight" }
  | { ok: false; code: "quota_exhausted"; window: "5h" | "week"; resetAt: number };

export interface SettleMeta {
  caller: Caller;
  route: RouteRow;
  usage: UsageCounts;
  costMicro: number;
}

export interface QuotaPort {
  hold(uid: string, requestId: string, estimateMicro: number): Promise<HoldOutcome>;
  settle(uid: string, requestId: string, meta: SettleMeta): Promise<void>;
  release(uid: string, requestId: string): Promise<void>;
  remaining(uid: string): Promise<{ h5: number; week: number; addon: number; plan: string | null }>;
}

export interface LlmGatewayDeps {
  routes: () => Promise<RouteRow[]>;
  quota: QuotaPort;
  /** 平台 → 上游 key（Worker env）。undefined = 这个平台没配 */
  upstreamKey: (platform: string) => string | undefined;
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
}

const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const apiError = (status: number, message: string, code: string, extra: Record<string, unknown> = {}): Response =>
  json(status, { error: { message, type: "otto_edge", code, ...extra } });

/** 选路（ADR-0175 第 3 节）。本片只做第 1 步的一半（enabled 已在 SQL 里过滤）+ 按 priority 取第一条；
    粘性 / 比价 / failover 是后续切片——签名留在这里，实现时只改这一个函数 */
export function pickRoute(routes: RouteRow[], logicalModel: string): RouteRow | null {
  return routes.find((r) => r.logicalModel === logicalModel) ?? null;
}

/** 预扣估算：宁高勿低，结算退差。prompt 按 body 字节 ÷ 3 粗估（中英混排 1 token ≈ 3 字节） */
export function estimateMicro(bodyBytes: number, maxTokens: number, route: RouteRow): number {
  const promptTokens = Math.ceil(bodyBytes / 3);
  return Math.ceil((promptTokens * route.priceInMicroPerM + maxTokens * route.priceOutMicroPerM) / 1_000_000);
}

/** 实际成本：cached 从 prompt 里扣，按 cache 价；其余按 in 价；out 按 out 价 */
export function costMicro(u: UsageCounts, route: RouteRow): number {
  const cached = Math.min(u.cachedTokens, u.promptTokens);
  const fresh = u.promptTokens - cached;
  return Math.ceil(
    (fresh * route.priceInMicroPerM + cached * route.priceCacheMicroPerM + u.completionTokens * route.priceOutMicroPerM) / 1_000_000
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 线上 usage → 计数。两种 cache 方言都收（同 src/model/openaiCompatible.ts 的 toTokenUsage） */
export function parseUsage(v: unknown): UsageCounts | null {
  if (!isObj(v) || typeof v.prompt_tokens !== "number" || typeof v.completion_tokens !== "number") return null;
  const details = isObj(v.prompt_tokens_details) ? v.prompt_tokens_details : null;
  const cached =
    typeof v.prompt_cache_hit_tokens === "number" ? v.prompt_cache_hit_tokens
    : details && typeof details.cached_tokens === "number" ? details.cached_tokens
    : 0;
  return { promptTokens: v.prompt_tokens, cachedTokens: cached, completionTokens: v.completion_tokens };
}

/** SSE 旁路：字节原样过，同时按行找 `data: {...}` 里最后一个 usage。流结束时 onDone 一次（没见到就 null） */
export function tapSseUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (u: UsageCounts | null) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let usage: UsageCounts | null = null;
  const scan = (text: string) => {
    buf += text;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed: unknown = JSON.parse(payload);
            if (isObj(parsed) && parsed.usage) usage = parseUsage(parsed.usage) ?? usage;
          } catch { /* 半截 JSON 或非 JSON 行：不是我们的事，透传 */ }
        }
      }
      nl = buf.indexOf("\n");
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scan(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        scan(decoder.decode());
        onDone(usage);
      },
    })
  );
}

export function createLlmGateway(deps: LlmGatewayDeps): (req: Request, caller: Caller) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const newId = deps.newRequestId ?? (() => crypto.randomUUID());

  async function remainingHeaders(uid: string): Promise<Record<string, string>> {
    const r = await deps.quota.remaining(uid);
    return {
      [BILLING_HEADERS.h5]: String(r.h5),
      [BILLING_HEADERS.week]: String(r.week),
      [BILLING_HEADERS.addon]: String(r.addon),
      ...(r.plan ? { [BILLING_HEADERS.plan]: r.plan } : {}),
    };
  }

  return async function handle(req: Request, caller: Caller): Promise<Response> {
    const raw = await req.text();
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed) || typeof parsed.model !== "string") return apiError(400, "请求体要有 model", "bad_request");
      body = parsed;
    } catch {
      return apiError(400, "请求体不是 JSON", "bad_request");
    }

    const route = pickRoute(await deps.routes(), body.model as string);
    if (!route) return apiError(400, `网关不供这款型号：${String(body.model)}`, "unknown_model");
    const key = deps.upstreamKey(route.platform);
    if (!key) return apiError(502, `服务端没配 ${route.platform} 的 key`, "upstream");

    const stream = body.stream === true;
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : route.defaultMaxTokens;
    const requestId = newId();
    const held = await deps.quota.hold(caller.uid, requestId, estimateMicro(raw.length, maxTokens, route));
    if (!held.ok) {
      if (held.code === "no_subscription") return apiError(402, "没有活跃订阅", "no_subscription");
      if (held.code === "too_many_inflight") return apiError(429, "同时进行的请求太多，稍后再试", "too_many_inflight");
      return apiError(429, held.window === "5h" ? "5 小时额度已用完" : "本周额度已用完", "quota_exhausted", {
        window: held.window, resetAt: held.resetAt,
      });
    }

    const upstreamBody = JSON.stringify({
      ...body,
      model: route.wireModel,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });

    let res: Response;
    try {
      res = await doFetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: upstreamBody,
        signal: req.signal,
      });
    } catch (err) {
      await deps.quota.release(caller.uid, requestId);
      return apiError(502, `上游连不上：${err instanceof Error ? err.message : String(err)}`, "upstream");
    }

    if (!res.ok) {
      await deps.quota.release(caller.uid, requestId);
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return apiError(502, `上游 ${res.status}：${snippet}`, "upstream", { upstreamStatus: res.status });
    }

    const settleWith = async (usage: UsageCounts | null) => {
      if (!usage) { await deps.quota.release(caller.uid, requestId); return; }
      await deps.quota.settle(caller.uid, requestId, { caller, route, usage, costMicro: costMicro(usage, route) });
    };

    const headers = await remainingHeaders(caller.uid);

    if (stream && res.body) {
      // 旁路挑 usage，字节原样透传。settle 在流结束那一刻发生——
      // 客户端此时已经拿到全部内容，晚一拍记账不影响它
      const tapped = tapSseUsage(res.body, (u) => { void settleWith(u); });
      return new Response(tapped, {
        status: 200,
        headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream", ...headers },
      });
    }

    const text = await res.text();
    let usage: UsageCounts | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      usage = isObj(parsed) ? parseUsage(parsed.usage) : null;
    } catch { /* 上游回了非 JSON 的 200：按没 usage 处理 */ }
    await settleWith(usage);
    return new Response(text, {
      status: 200,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...headers },
    });
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/edge/llmGateway.test.ts`
Expected: PASS。注意流式那条测试里 settle 是在流被读完（`res.text()`）之后才发生的，断言顺序不能提前。

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/llmGateway.ts tests/edge/llmGateway.test.ts
git commit -m "feat(edge): 托管模型网关纯逻辑——选路/预扣/透传/旁路挑 usage/结算（#696）

SSE 原样透传、旁路只看 usage：客户端 adapter 一字不改。上游任何失败与流里没 usage
都 release 不记账；上游 4xx 也翻成 502——用户没用自己的 key，不该看到一个会让他
去改 key 的 401。响应头带剩余额度，客户端不用再问一次。"
```

---

### Task 5: Stripe 纯逻辑 `services/edge/src/billing.ts`

**Files:**
- Create: `services/edge/src/billing.ts`
- Test: `tests/edge/billing.test.ts`

**Interfaces:**
- Produces（Task 6/7 用）：
  ```ts
  export async function verifyStripeSignature(payload: string, header: string, secret: string, nowSeconds: number, toleranceSeconds?: number): Promise<boolean>
  export type BillingAction =
    | { kind: "subscription_upsert"; uid: string; priceId: string; customerId: string; subscriptionId: string;
        status: "active" | "past_due" | "canceled"; periodStartMs: number; periodEndMs: number }
    | { kind: "subscription_status"; subscriptionId: string; status: "past_due" | "canceled" }
    | { kind: "grant"; uid: string; paymentIntentId: string; quantity: number }
    | { kind: "ignore"; eventType: string }
  export function actionFromEvent(event: unknown): BillingAction
  export function checkoutParams(o: { mode: "subscription" | "payment"; priceId: string; quantity: number; uid: string; customerId?: string; successUrl: string; cancelUrl: string }): URLSearchParams
  export function portalParams(customerId: string, returnUrl: string): URLSearchParams
  ```

设计点：
- `checkout.session.completed` 不带订阅的 period；订阅的 period 从随后的 `customer.subscription.updated`（或创建时的 `customer.subscription.created`）来。所以 **`checkout.session.completed`（subscription 模式）本身产出 `ignore`**——真正 upsert 的是 `customer.subscription.created|updated`，uid 从 `subscription.metadata.uid` 取（checkoutParams 里通过 `subscription_data[metadata][uid]` 种进去）。这比 spec 表里写的少一次 upsert，语义一样，且不用再打一次 Stripe API 查 period。
- `customer.subscription.deleted` → `subscription_status: canceled`；`invoice.payment_failed` → `subscription_status: past_due`（按 `subscription` id 定位）。
- `checkout.session.completed`（payment 模式）→ `grant`，uid 从 `client_reference_id`，数量从 `metadata.quantity`（checkoutParams 种进去）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/billing.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionFromEvent, checkoutParams, portalParams, verifyStripeSignature } from "../../services/edge/src/billing.js";

const SECRET = "whsec_test";
const NOW = 1_800_000_000;
const sign = (payload: string, t = NOW, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("verifyStripeSignature", () => {
  it("正确签名通过", async () => {
    expect(await verifyStripeSignature("{}", sign("{}"), SECRET, NOW)).toBe(true);
  });
  it("坑一：时间戳超过容差 → 拒（重放）", async () => {
    expect(await verifyStripeSignature("{}", sign("{}", NOW - 301), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", sign("{}", NOW - 299), SECRET, NOW)).toBe(true);
  });
  it("坑二：v1 不匹配（换 secret / 改正文）→ 拒", async () => {
    expect(await verifyStripeSignature("{}", sign("{}", NOW, "other"), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{x}", sign("{}"), SECRET, NOW)).toBe(false);
  });
  it("坑三：头格式不对 / 缺 v1 / 长度不同 → 拒，不抛", async () => {
    expect(await verifyStripeSignature("{}", "", SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", `t=${NOW}`, SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", `t=${NOW},v1=abc`, SECRET, NOW)).toBe(false);
  });
  it("多个 v1（密钥轮换期）任一匹配即可", async () => {
    const good = sign("{}").split(",")[1];
    expect(await verifyStripeSignature("{}", `t=${NOW},v1=deadbeef,${good}`, SECRET, NOW)).toBe(true);
  });
});

describe("actionFromEvent", () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    id: "sub_1", customer: "cus_1", status: "active",
    current_period_start: 1_700_000_000, current_period_end: 1_702_592_000,
    metadata: { uid: "u1" }, items: { data: [{ price: { id: "price_pro" } }] }, ...over,
  });

  it("customer.subscription.created/updated → subscription_upsert，period 秒转毫秒", () => {
    for (const type of ["customer.subscription.created", "customer.subscription.updated"]) {
      expect(actionFromEvent({ type, data: { object: sub() } })).toEqual({
        kind: "subscription_upsert", uid: "u1", priceId: "price_pro", customerId: "cus_1", subscriptionId: "sub_1",
        status: "active", periodStartMs: 1_700_000_000_000, periodEndMs: 1_702_592_000_000,
      });
    }
  });

  it("Stripe 状态归三档：trialing→active，unpaid/past_due→past_due，其余→canceled", () => {
    const st = (s: string) => (actionFromEvent({ type: "customer.subscription.updated", data: { object: sub({ status: s }) } }) as { status: string }).status;
    expect(st("trialing")).toBe("active");
    expect(st("unpaid")).toBe("past_due");
    expect(st("incomplete_expired")).toBe("canceled");
  });

  it("没有 metadata.uid 的订阅 → ignore（不是我们建的）", () => {
    expect(actionFromEvent({ type: "customer.subscription.updated", data: { object: sub({ metadata: {} }) } })).toMatchObject({ kind: "ignore" });
  });

  it("customer.subscription.deleted → subscription_status canceled；invoice.payment_failed → past_due", () => {
    expect(actionFromEvent({ type: "customer.subscription.deleted", data: { object: sub() } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "canceled" });
    expect(actionFromEvent({ type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "past_due" });
  });

  it("checkout.session.completed 的 payment 模式 → grant；subscription 模式 → ignore（等 subscription.* 事件）", () => {
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: {
      mode: "payment", client_reference_id: "u1", payment_intent: "pi_1", metadata: { quantity: "3" },
    } } })).toEqual({ kind: "grant", uid: "u1", paymentIntentId: "pi_1", quantity: 3 });
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "u1" } } }))
      .toMatchObject({ kind: "ignore" });
  });

  it("不认识的事件 / 形状不对 → ignore 带 eventType", () => {
    expect(actionFromEvent({ type: "charge.refunded", data: { object: {} } })).toEqual({ kind: "ignore", eventType: "charge.refunded" });
    expect(actionFromEvent(null)).toEqual({ kind: "ignore", eventType: "?" });
  });
});

describe("请求体", () => {
  it("checkoutParams：订阅模式把 uid 种进 subscription_data.metadata，复用 customer", () => {
    const p = checkoutParams({ mode: "subscription", priceId: "price_pro", quantity: 1, uid: "u1", customerId: "cus_1", successUrl: "https://e/done", cancelUrl: "https://e/cancel" });
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("line_items[0][price]")).toBe("price_pro");
    expect(p.get("client_reference_id")).toBe("u1");
    expect(p.get("subscription_data[metadata][uid]")).toBe("u1");
    expect(p.get("customer")).toBe("cus_1");
  });
  it("checkoutParams：payment 模式带 quantity 进 metadata，没 customer 就不带", () => {
    const p = checkoutParams({ mode: "payment", priceId: "price_addon", quantity: 3, uid: "u1", successUrl: "s", cancelUrl: "c" });
    expect(p.get("line_items[0][quantity]")).toBe("3");
    expect(p.get("metadata[quantity]")).toBe("3");
    expect(p.get("customer")).toBeNull();
  });
  it("portalParams", () => {
    expect(portalParams("cus_1", "https://e/done").get("customer")).toBe("cus_1");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/edge/billing.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

```ts
// services/edge/src/billing.ts
// Stripe 那一侧的纯逻辑：webhook 验签、事件 → 我们要做的动作、Checkout/Portal 请求体。
// 不装 stripe SDK（理由同 ADR-0019 决定四：一次 HMAC 换不来更少的代码，且它在
// Workers 上要 shim）。WebCrypto 而不是 node:crypto（同 jwt.ts 的理由）。
//
// Stripe 是订阅状态的事实来源，subscription 表是投影：每个事件都把 Stripe 那份当真。

export type BillingAction =
  | {
      kind: "subscription_upsert";
      uid: string; priceId: string; customerId: string; subscriptionId: string;
      status: "active" | "past_due" | "canceled";
      periodStartMs: number; periodEndMs: number;
    }
  | { kind: "subscription_status"; subscriptionId: string; status: "past_due" | "canceled" }
  | { kind: "grant"; uid: string; paymentIntentId: string; quantity: number }
  | { kind: "ignore"; eventType: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 恒时比较（同 edge.ts 的 timingSafeEqual；长度不等直接 false 是允许的短路） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stripe-Signature: `t=<秒>,v1=<hex>[,v1=<hex>...]`；签名内容 = `${t}.${payload}`。
 * 三个坑各有一条测试钉住：时间戳容差（重放）、v1 不匹配、头格式坏掉不抛。
 */
export async function verifyStripeSignature(
  payload: string, header: string, secret: string, nowSeconds: number, toleranceSeconds = 300
): Promise<boolean> {
  if (!secret || !header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  const ts = Number(t);
  if (!Number.isFinite(ts) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

function normalizeStatus(s: unknown): "active" | "past_due" | "canceled" {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  return "canceled";
}

export function actionFromEvent(event: unknown): BillingAction {
  if (!isObj(event) || typeof event.type !== "string" || !isObj(event.data) || !isObj(event.data.object)) {
    return { kind: "ignore", eventType: isObj(event) && typeof event.type === "string" ? event.type : "?" };
  }
  const type = event.type;
  const o = event.data.object;

  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const uid = isObj(o.metadata) && typeof o.metadata.uid === "string" ? o.metadata.uid : "";
    const items = isObj(o.items) && Array.isArray(o.items.data) ? o.items.data : [];
    const first = items[0];
    const priceId = isObj(first) && isObj(first.price) && typeof first.price.id === "string" ? first.price.id : "";
    if (!uid || !priceId || typeof o.id !== "string" || typeof o.customer !== "string"
      || typeof o.current_period_start !== "number" || typeof o.current_period_end !== "number") {
      return { kind: "ignore", eventType: type };
    }
    return {
      kind: "subscription_upsert", uid, priceId, customerId: o.customer, subscriptionId: o.id,
      status: normalizeStatus(o.status),
      periodStartMs: o.current_period_start * 1000, periodEndMs: o.current_period_end * 1000,
    };
  }
  if (type === "customer.subscription.deleted") {
    return typeof o.id === "string" ? { kind: "subscription_status", subscriptionId: o.id, status: "canceled" } : { kind: "ignore", eventType: type };
  }
  if (type === "invoice.payment_failed") {
    return typeof o.subscription === "string" ? { kind: "subscription_status", subscriptionId: o.subscription, status: "past_due" } : { kind: "ignore", eventType: type };
  }
  if (type === "checkout.session.completed") {
    if (o.mode !== "payment") return { kind: "ignore", eventType: type }; // 订阅那份靠 customer.subscription.* 来
    const uid = typeof o.client_reference_id === "string" ? o.client_reference_id : "";
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : "";
    const q = isObj(o.metadata) ? Number(o.metadata.quantity) : NaN;
    if (!uid || !pi || !Number.isInteger(q) || q <= 0) return { kind: "ignore", eventType: type };
    return { kind: "grant", uid, paymentIntentId: pi, quantity: q };
  }
  return { kind: "ignore", eventType: type };
}

export function checkoutParams(o: {
  mode: "subscription" | "payment"; priceId: string; quantity: number; uid: string;
  customerId?: string; successUrl: string; cancelUrl: string;
}): URLSearchParams {
  const p = new URLSearchParams();
  p.set("mode", o.mode);
  p.set("line_items[0][price]", o.priceId);
  p.set("line_items[0][quantity]", String(o.quantity));
  p.set("client_reference_id", o.uid);
  p.set("success_url", o.successUrl);
  p.set("cancel_url", o.cancelUrl);
  if (o.customerId) p.set("customer", o.customerId);
  if (o.mode === "subscription") p.set("subscription_data[metadata][uid]", o.uid);
  else {
    p.set("metadata[quantity]", String(o.quantity));
    p.set("metadata[uid]", o.uid);
  }
  return p;
}

export function portalParams(customerId: string, returnUrl: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set("customer", customerId);
  p.set("return_url", returnUrl);
  return p;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/edge/billing.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/billing.ts tests/edge/billing.test.ts
git commit -m "feat(edge): Stripe 验签 + 事件→动作 + Checkout/Portal 请求体，裸 REST 不装 SDK（#696）

Stripe 是订阅状态的事实来源、subscription 表是投影，所以 upsert 认 customer.subscription.*
而不是 checkout.session.completed——后者没有 period，而周窗锚定日正是 period 起点。
验签三个坑各钉一条测试（重放窗口 / v1 不匹配 / 坏头不抛）。"
```

---

### Task 6: 路由接进 `edge.ts`（身份、on-behalf-of、`/llm/v1`、`/billing/v1`）

**Files:**
- Modify: `services/edge/src/edge.ts`（`EdgeDeps` 加两个可选注入；`handle` 加五条路由；新增 `httpIdentify`）
- Test: `tests/edge/billingRoutes.test.ts`（新文件，仿 `tests/edge/pxRoutes.test.ts` 的造 Request 打 `createEdge` 写法）

**Interfaces:**
- Consumes：`createLlmGateway` 的返回类型 `(req, caller) => Promise<Response>`、`Caller`（Task 4）；`BillingMe`、`PlanId`、`ON_BEHALF_HEADER`、`WORKSPACE_HEADER`、`SESSION_HEADER`（Task 1）
- Produces（Task 7 实现 `BillingPort`）：
  ```ts
  export type CheckoutTarget = { planId: PlanId } | { addon: true; quantity: number };
  export interface BillingPort {
    me(uid: string): Promise<BillingMe>;
    /** origin = 请求的 origin（拼 success/cancel/return url） */
    checkout(uid: string, target: CheckoutTarget, origin: string): Promise<{ url: string } | { error: string }>;
    portal(uid: string, origin: string): Promise<{ url: string } | { error: string }>;
    /** 验签 + 落库都在里面；回 HTTP 状态与 body */
    webhook(payload: string, signatureHeader: string): Promise<{ status: number; body: unknown }>;
  }
  // EdgeDeps 增：
  //   llm?: (req: Request, caller: Caller) => Promise<Response>;
  //   billing?: BillingPort;
  ```
- 平台身份的头沿用仓库既有约定 **`x-runtime-secret`**（px 路由已经这么用，`services/runtime/src/pxTools.ts` 也这么发），不用 spec 里写的 `Bearer RUNTIME_SECRET`——两套写法只会让 runtime 侧多一个分支。runtime 代表谁走 `x-otto-on-behalf-of`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/edge/billingRoutes.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEdge, type BillingPort, type EdgeConfig } from "../../services/edge/src/edge.js";
import type { Caller } from "../../services/edge/src/llmGateway.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe } from "../../src/shared/billing.js";

const SECRET = "jwt-secret";
const RUNTIME = "runtime-secret";
const NOW_MS = 1_800_000_000_000;
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(sub = "u1"): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, email: "a@b.c", exp: Math.floor(NOW_MS / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const config: EdgeConfig = { jwtSecret: SECRET, runtimeSecret: RUNTIME };

const me: BillingMe = { plan: "lite", status: "active", windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [] };

function harness() {
  const llmCalls: Caller[] = [];
  const billingCalls: string[] = [];
  const billing: BillingPort = {
    me: async (uid) => { billingCalls.push(`me:${uid}`); return me; },
    checkout: async (uid, target) => { billingCalls.push(`checkout:${uid}:${JSON.stringify(target)}`); return { url: "https://stripe/x" }; },
    portal: async (uid) => { billingCalls.push(`portal:${uid}`); return { url: "https://stripe/p" }; },
    webhook: async (payload, sig) => { billingCalls.push(`webhook:${payload}:${sig}`); return { status: 200, body: { ok: true } }; },
  };
  const handle = createEdge({
    config, now: () => NOW_MS,
    llm: async (_req, caller) => { llmCalls.push(caller); return new Response("llm-ok"); },
    billing,
  });
  return { handle, llmCalls, billingCalls };
}

const post = (path: string, headers: Record<string, string>, body = "{}") =>
  new Request(`https://edge${path}`, { method: "POST", headers, body });

describe("/llm/v1/chat/completions 身份", () => {
  it("桌面 JWT → caller.source=desktop，uid 是 sub；workspace/session 头透进 caller", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token("u9")}`, [WORKSPACE_HEADER]: "w1", [SESSION_HEADER]: "s1" }));
    expect(res.status).toBe(200);
    expect(h.llmCalls).toEqual([{ uid: "u9", source: "desktop", workspaceId: "w1", sessionId: "s1" }]);
  });

  it("没令牌 401 no_token；坏令牌 401 bad_token", async () => {
    const h = harness();
    expect((await h.handle(post("/llm/v1/chat/completions", {}))).status).toBe(401);
    const bad = await h.handle(post("/llm/v1/chat/completions", { authorization: "Bearer nope" }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("bad_token");
  });

  it("平台身份 + on-behalf-of → caller.source=runtime，uid 是被代表的人", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: "u7" }));
    expect(res.status).toBe(200);
    expect(h.llmCalls[0]).toMatchObject({ uid: "u7", source: "runtime" });
  });

  it("平台身份没带 on-behalf-of → 400；桌面 JWT 带了 on-behalf-of → 400（只有平台能代表别人）", async () => {
    const h = harness();
    expect((await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": RUNTIME }))).status).toBe(400);
    expect((await h.handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token()}`, [ON_BEHALF_HEADER]: "u2" }))).status).toBe(400);
    expect(h.llmCalls).toEqual([]);
  });

  it("错的 runtime secret 落进普通 JWT 校验：401 bad_token，形状和烂 token 一样（不泄露 secret 存在）", async () => {
    const h = harness();
    const res = await h.handle(post("/llm/v1/chat/completions", { "x-runtime-secret": "wrong", [ON_BEHALF_HEADER]: "u7" }));
    expect(res.status).toBe(401);
  });

  it("没注入 llm → 404 llm_disabled", async () => {
    const handle = createEdge({ config, now: () => NOW_MS });
    expect((await handle(post("/llm/v1/chat/completions", { authorization: `Bearer ${token()}` }))).status).toBe(404);
  });
});

describe("/billing/v1/*", () => {
  it("GET /me 回 BillingPort.me 的结果；平台身份也能代表人查", async () => {
    const h = harness();
    const res = await h.handle(new Request("https://edge/billing/v1/me", { headers: { authorization: `Bearer ${token("u1")}` } }));
    expect(await res.json()).toEqual(me);
    await h.handle(new Request("https://edge/billing/v1/me", { headers: { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: "u3" } }));
    expect(h.billingCalls).toEqual(["me:u1", "me:u3"]);
  });

  it("POST /checkout {planId} 与 {addon,quantity} 都回 url；planId 不合法 400；平台身份不许买（402 那条路是人的事）", async () => {
    const h = harness();
    const r1 = await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}`, "content-type": "application/json" }, JSON.stringify({ planId: "pro" })));
    expect(await r1.json()).toEqual({ url: "https://stripe/x" });
    const r2 = await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ addon: true, quantity: 2 })));
    expect(r2.status).toBe(200);
    expect(h.billingCalls).toEqual(['checkout:u1:{"planId":"pro"}', 'checkout:u1:{"addon":true,"quantity":2}']);
    expect((await h.handle(post("/billing/v1/checkout", { authorization: `Bearer ${token()}` }, JSON.stringify({ planId: "gold" })))).status).toBe(400);
    expect((await h.handle(post("/billing/v1/checkout", { "x-runtime-secret": RUNTIME, [ON_BEHALF_HEADER]: "u1" }, JSON.stringify({ planId: "pro" })))).status).toBe(403);
  });

  it("POST /portal 回 url", async () => {
    const h = harness();
    expect(await (await h.handle(post("/billing/v1/portal", { authorization: `Bearer ${token()}` }))).json()).toEqual({ url: "https://stripe/p" });
  });

  it("POST /webhook 不验 JWT：原文 + Stripe-Signature 头原样交给 BillingPort", async () => {
    const h = harness();
    const res = await h.handle(post("/billing/v1/webhook", { "stripe-signature": "t=1,v1=abc" }, '{"type":"x"}'));
    expect(res.status).toBe(200);
    expect(h.billingCalls).toEqual(['webhook:{"type":"x"}:t=1,v1=abc']);
  });

  it("GET /billing/v1/done 是给浏览器看的 HTML，不要令牌", async () => {
    const res = await harness().handle(new Request("https://edge/billing/v1/done"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("没注入 billing → 404 billing_disabled", async () => {
    const handle = createEdge({ config, now: () => NOW_MS });
    expect((await handle(new Request("https://edge/billing/v1/me", { headers: { authorization: `Bearer ${token()}` } }))).status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run tests/edge/billingRoutes.test.ts`
Expected: FAIL（`BillingPort` 不存在 / 路由 404）

- [ ] **Step 3: 改 `edge.ts`**

在 import 区加：

```ts
import type { Caller } from "./llmGateway.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, type BillingMe, type PlanId } from "../../../src/shared/billing.js";
```

在 `EdgeDeps` 前加类型，`EdgeDeps` 加两个可选字段：

```ts
export type CheckoutTarget = { planId: PlanId } | { addon: true; quantity: number };

/** 计费面（spec 2026-09-02 第 3 节）。生产上是 worker.ts 里握 Stripe + Supabase 的实现，测试里是假货 */
export interface BillingPort {
  me(uid: string): Promise<BillingMe>;
  checkout(uid: string, target: CheckoutTarget, origin: string): Promise<{ url: string } | { error: string }>;
  portal(uid: string, origin: string): Promise<{ url: string } | { error: string }>;
  webhook(payload: string, signatureHeader: string): Promise<{ status: number; body: unknown }>;
}

export interface EdgeDeps {
  // ...既有字段不动...
  /** 托管模型网关（Task 4 的 createLlmGateway）。不注入就没有 /llm/v1/* */
  llm?: (req: Request, caller: Caller) => Promise<Response>;
  /** 计费面。不注入就没有 /billing/v1/*（webhook 也没有） */
  billing?: BillingPort;
}
```

在 `pxIdentify` 后面加 HTTP 身份 + on-behalf-of：

```ts
  /** llm / billing 路由的身份：pxIdentify 那一套 + on-behalf-of。
      平台身份**必须**带 x-otto-on-behalf-of（它没有自己的 sub，代表谁要说清楚）；
      真人**不许**带（能代表别人的只有平台）。两条都是 400 而不是静默忽略——
      一个带着这个头却被当成本人处理的请求，正是「以为在替 A 扣、其实扣了自己」那种账 */
  async function callerOf(req: Request): Promise<Caller | Response> {
    const who = await pxIdentify(req);
    if (who instanceof Response) return who;
    const onBehalf = req.headers.get(ON_BEHALF_HEADER);
    let uid = who.userId;
    let source: Caller["source"] = "desktop";
    if (who.userId === RUNTIME_SERVICE_UID) {
      if (!onBehalf) return apiError(400, `平台身份必须声明 ${ON_BEHALF_HEADER}`, "bad_request");
      uid = onBehalf;
      source = "runtime";
    } else if (onBehalf !== null) {
      return apiError(400, `只有平台身份能带 ${ON_BEHALF_HEADER}`, "bad_request");
    }
    return {
      uid, source,
      workspaceId: req.headers.get(WORKSPACE_HEADER) ?? "",
      sessionId: req.headers.get(SESSION_HEADER) ?? "",
    };
  }

  async function billingRoute(req: Request, pathname: string): Promise<Response> {
    if (!deps.billing) return apiError(404, "这个服务没开计费面", "billing_disabled");
    const origin = new URL(req.url).origin;

    // 付款完成/取消后浏览器落的页：给人看的一句话，不要令牌（同 /auth/landing 的理由）
    if (pathname === "/billing/v1/done") {
      const ok = new URL(req.url).searchParams.get("ok") !== "0";
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Mr Otto</title>` +
        `<body style="font-family:system-ui;padding:3rem;text-align:center">` +
        `<h1>${ok ? "付款完成" : "已取消"}</h1><p>${ok ? "回到 Mr Otto，额度已经生效。" : "什么都没发生，回到 Mr Otto 即可。"}</p></body>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    // Stripe → 我们。不验 JWT（Stripe 不带），验签在 BillingPort 里做
    if (pathname === "/billing/v1/webhook") {
      if (req.method !== "POST") return apiError(405, "只收 POST", "method_not_allowed");
      const r = await deps.billing.webhook(await req.text(), req.headers.get("stripe-signature") ?? "");
      return json(r.status, r.body);
    }

    const caller = await callerOf(req);
    if (caller instanceof Response) return caller;

    if (pathname === "/billing/v1/me" && req.method === "GET") return json(200, await deps.billing.me(caller.uid));

    // 下面两条是人的动作：平台身份替人买东西没有意义（钱是人付的）
    if (caller.source === "runtime") return apiError(403, "平台身份不能发起购买", "forbidden");

    if (pathname === "/billing/v1/checkout" && req.method === "POST") {
      const b: unknown = await req.json().catch(() => null);
      const o = b as { planId?: unknown; addon?: unknown; quantity?: unknown } | null;
      let target: CheckoutTarget | null = null;
      if (o && (o.planId === "lite" || o.planId === "pro" || o.planId === "max")) target = { planId: o.planId };
      else if (o && o.addon === true) {
        const q = typeof o.quantity === "number" && Number.isInteger(o.quantity) && o.quantity > 0 ? o.quantity : 1;
        target = { addon: true, quantity: q };
      }
      if (!target) return apiError(400, "checkout 要 {planId: lite|pro|max} 或 {addon:true, quantity}", "bad_request");
      const r = await deps.billing.checkout(caller.uid, target, origin);
      return "url" in r ? json(200, r) : apiError(502, r.error, "upstream");
    }
    if (pathname === "/billing/v1/portal" && req.method === "POST") {
      const r = await deps.billing.portal(caller.uid, origin);
      return "url" in r ? json(200, r) : apiError(502, r.error, "upstream");
    }
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  }
```

`handle` 里加两条（放在 `/px/v1/` 那行后面）：

```ts
    if (pathname === "/llm/v1/chat/completions") {
      if (!deps.llm) return apiError(404, "这个服务没开托管网关", "llm_disabled");
      if (req.method !== "POST") return apiError(405, "只收 POST", "method_not_allowed");
      const caller = await callerOf(req);
      if (caller instanceof Response) return caller;
      return deps.llm(req, caller);
    }
    if (pathname.startsWith("/billing/v1/")) return billingRoute(req, pathname);
```

同时把文件头注释里「曾经还有第三件 —— 拿官方 DeepSeek key 代理模型调用」那段改成：

```ts
//   3. 托管模型网关 + 计费面(订阅制,ADR-0174 起三篇 + spec 2026-09-02):
//      验人 → 交给 llmGateway(hold/转发/settle 都在那边)。ADR-0085 关掉、
//      ADR-0129 删掉的那一版是赠额形态;这一版是订阅形态,机制层复活。
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run tests/edge/billingRoutes.test.ts tests/edge/edge.test.ts tests/edge/pxRoutes.test.ts`
Expected: 全 PASS（旧路由测试不受影响）

- [ ] **Step 5: 提交**

```bash
git add services/edge/src/edge.ts tests/edge/billingRoutes.test.ts
git commit -m "feat(edge): /llm/v1 与 /billing/v1 路由 + on-behalf-of 身份（#696）

平台身份必须声明代表谁、真人不许声明——两边都是 400 而不是静默忽略：
一个带着这个头却被当成本人处理的请求，正是「以为在替 A 扣、其实扣了自己」那种账。
平台身份沿用 x-runtime-secret（px 路由与 runtime 已在用），不另开 Bearer 一套。"
```

---

### Task 7: `Quota` DO + Supabase/Stripe 装配（`worker.ts`）+ 部署文件

**Files:**
- Create: `services/edge/src/billingQueries.ts`（纯：PostgREST 查询串与行解析、Stripe 响应解析）
- Test: `tests/edge/billingQueries.test.ts`
- Modify: `services/edge/src/worker.ts`（`Env` 增项、`Quota` DO、`QuotaPort` / `BillingPort` 实现、装配）
- Modify: `services/edge/wrangler.jsonc`（`QUOTA` binding、migration `v3`、secret 清单注释）
- Create: `services/edge/checks/llm.mjs`
- Modify: `services/edge/README.md`（端点表 + 部署 + 手验清单）

**Interfaces:**
- Consumes：`quota.ts` 全部导出（Task 3）；`QuotaPort`、`RouteRow`、`SettleMeta`、`createLlmGateway`（Task 4）；`billing.ts`（Task 5）；`BillingPort`、`CheckoutTarget`（Task 6）；`BillingMe`（Task 1）
- Produces（`billingQueries.ts`）：
  ```ts
  export interface PlanRow { id: string; week_limit_micro: number; window5h_limit_micro: number; addon_unit_micro: number; stripe_price_id: string }
  export interface SubscriptionRow { user_id: string; plan_id: string; status: "active"|"past_due"|"canceled"; stripe_customer_id: string; stripe_subscription_id: string; current_period_start: string; current_period_end: string }
  export function subscriptionQuery(uid: string): string            // "subscription?user_id=eq.<uid>&select=..."
  export function parseSubscriptionRows(v: unknown): SubscriptionRow | null
  export function plansQuery(): string                              // "plan?select=..."
  export function parsePlanRows(v: unknown): PlanRow[]
  export function planSnapshotOf(sub: SubscriptionRow | null, plans: PlanRow[]): PlanSnapshot | null
  export function routesQuery(): string
  export function parseRouteRows(v: unknown): RouteRow[]
  export function usageEventInsert(requestId: string, meta: SettleMeta, chargedTo: "window"|"addon"): Record<string, unknown>
  export function rebuildQueries(uid: string, sinceMs: number): { events: string; grants: string; addonConsumed: string }
  export function parseRebuildRows(events: unknown, grants: unknown, addonConsumed: unknown): RebuildInput
  export function subscriptionUpsertBody(a: Extract<BillingAction,{kind:"subscription_upsert"}>, planId: string): Record<string, unknown>
  export function planIdForPrice(plans: PlanRow[], priceId: string): string | null
  export function grantInsertBody(a: Extract<BillingAction,{kind:"grant"}>, unitMicro: number, nowMs: number): Record<string, unknown>
  export function meFromParts(sub: SubscriptionRow | null, windows: {h5: WindowState; week: WindowState} | null, addon: {remainingMicro: number; expiresAt: number|null}, models: string[]): BillingMe
  ```

- [ ] **Step 1: 写 billingQueries 的失败测试**

```ts
// tests/edge/billingQueries.test.ts
import { describe, expect, it } from "vitest";
import {
  grantInsertBody, parsePlanRows, parseRebuildRows, parseRouteRows, parseSubscriptionRows, planIdForPrice, planSnapshotOf,
  plansQuery, rebuildQueries, routesQuery, subscriptionQuery, subscriptionUpsertBody, usageEventInsert,
} from "../../services/edge/src/billingQueries.js";

const plans = [
  { id: "lite", week_limit_micro: 3_325_000, window5h_limit_micro: 665_000, addon_unit_micro: 0, stripe_price_id: "price_lite" },
  { id: "addon", week_limit_micro: 0, window5h_limit_micro: 0, addon_unit_micro: 7_000_000, stripe_price_id: "price_addon" },
];
const sub = {
  user_id: "u1", plan_id: "lite", status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
  current_period_start: "2026-09-01T00:00:00+00:00", current_period_end: "2026-10-01T00:00:00+00:00",
};

describe("查询串", () => {
  it("subscriptionQuery 按 user_id 过滤且只取一行", () => {
    expect(subscriptionQuery("u1")).toBe("subscription?user_id=eq.u1&select=user_id,plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end&limit=1");
  });
  it("routesQuery 只取 enabled 且未量化、按 priority 升序", () => {
    expect(routesQuery()).toContain("enabled=eq.true");
    expect(routesQuery()).toContain("quantization=eq.none");
    expect(routesQuery()).toContain("order=priority.asc");
  });
  it("rebuildQueries：events 按 user + created_at >= since；grants 未过期；addonConsumed 只取 addon 行", () => {
    const q = rebuildQueries("u1", Date.UTC(2026, 8, 1));
    expect(q.events).toContain("user_id=eq.u1");
    expect(q.events).toContain("created_at=gte.2026-09-01T00:00:00.000Z");
    expect(q.grants).toContain("expires_at=gt.");
    expect(q.addonConsumed).toContain("charged_to=eq.addon");
  });
  it("plansQuery 取 plan 表", () => {
    expect(plansQuery()).toContain("plan?select=");
  });
});

describe("行解析", () => {
  it("parseSubscriptionRows：空数组回 null；形状对回一行", () => {
    expect(parseSubscriptionRows([])).toBeNull();
    expect(parseSubscriptionRows([sub])).toEqual(sub);
    expect(parseSubscriptionRows([{ ...sub, status: "weird" }])).toBeNull();
  });
  it("parsePlanRows / parseRouteRows 丢掉坏行", () => {
    expect(parsePlanRows([...plans, { id: 1 }])).toHaveLength(2);
    const rows = parseRouteRows([{
      id: "r", logical_model: "deepseek-v4-flash", platform: "deepseek", base_url: "https://u", wire_model: "w",
      price_in_micro_per_m: 1, price_cache_micro_per_m: 2, price_out_micro_per_m: 3, default_max_tokens: 100,
    }, { id: "bad" }]);
    expect(rows).toEqual([{ id: "r", logicalModel: "deepseek-v4-flash", platform: "deepseek", baseUrl: "https://u", wireModel: "w", priceInMicroPerM: 1, priceCacheMicroPerM: 2, priceOutMicroPerM: 3, defaultMaxTokens: 100 }]);
  });
  it("planSnapshotOf：订阅 + 档位 → 快照（period 转毫秒）；缺任一回 null", () => {
    const s = planSnapshotOf(sub as never, plans)!;
    expect(s).toMatchObject({ planId: "lite", status: "active", window5hLimitMicro: 665_000, weekLimitMicro: 3_325_000 });
    expect(s.periodStartMs).toBe(Date.UTC(2026, 8, 1));
    expect(planSnapshotOf(null, plans)).toBeNull();
    expect(planSnapshotOf({ ...sub, plan_id: "gone" } as never, plans)).toBeNull();
  });
  it("parseRebuildRows：把三段查询结果并成 RebuildInput", () => {
    const r = parseRebuildRows(
      [{ created_at: "2026-09-01T01:00:00Z", cost_micro: 5, charged_to: "window" }],
      [{ micro_usd: 100, expires_at: "2027-09-01T00:00:00Z" }],
      [{ sum: 30 }]
    );
    expect(r.events).toEqual([{ at: Date.UTC(2026, 8, 1, 1), costMicro: 5, chargedTo: "window" }]);
    expect(r.grants[0]!.micro).toBe(100);
    expect(r.addonConsumedMicro).toBe(30);
    expect(parseRebuildRows(null, null, null)).toEqual({ events: [], grants: [], addonConsumedMicro: 0 });
  });
});

describe("写入体", () => {
  it("usageEventInsert 列名与 0017 一致", () => {
    const body = usageEventInsert("rid", {
      caller: { uid: "u1", source: "runtime", workspaceId: "w", sessionId: "s" },
      route: { id: "r", logicalModel: "m", platform: "p", baseUrl: "", wireModel: "", priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 0, defaultMaxTokens: 0 },
      usage: { promptTokens: 10, cachedTokens: 2, completionTokens: 3 }, costMicro: 42,
    }, "addon");
    expect(body).toEqual({
      user_id: "u1", request_id: "rid", source: "runtime", workspace_id: "w", session_id: "s", logical_model: "m", route_id: "r",
      prompt_tokens: 10, cached_tokens: 2, completion_tokens: 3, cost_micro: 42, charged_to: "addon",
    });
  });
  it("subscriptionUpsertBody：period 毫秒转 ISO；planIdForPrice 反查档位", () => {
    expect(planIdForPrice(plans, "price_lite")).toBe("lite");
    expect(planIdForPrice(plans, "price_x")).toBeNull();
    const b = subscriptionUpsertBody({ kind: "subscription_upsert", uid: "u1", priceId: "price_lite", customerId: "c", subscriptionId: "s", status: "active", periodStartMs: Date.UTC(2026, 8, 1), periodEndMs: Date.UTC(2026, 9, 1) }, "lite");
    expect(b).toMatchObject({ user_id: "u1", plan_id: "lite", status: "active", current_period_start: "2026-09-01T00:00:00.000Z" });
  });
  it("grantInsertBody：quantity × 单位额，12 个月后过期", () => {
    const now = Date.UTC(2026, 8, 2);
    const b = grantInsertBody({ kind: "grant", uid: "u1", paymentIntentId: "pi", quantity: 2 }, 7_000_000, now);
    expect(b).toMatchObject({ user_id: "u1", micro_usd: 14_000_000, stripe_payment_intent_id: "pi" });
    expect(new Date(b.expires_at as string).getUTCFullYear()).toBe(2027);
  });
});
```

- [ ] **Step 2: 跑测试确认失败，然后写 `billingQueries.ts`**

```ts
// services/edge/src/billingQueries.ts
// Supabase PostgREST 的查询串与行解析、写入体——全是纯字符串/对象，跑在根门禁里；
// 真正发请求的是 worker.ts。列名与 supabase/migrations/0017_subscriptions.sql 一一对应。

import type { PlanSnapshot, RebuildInput, WindowState } from "./quota.js";
import type { RouteRow, SettleMeta } from "./llmGateway.js";
import type { BillingAction } from "./billing.js";
import type { BillingMe } from "../../../src/shared/billing.js";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface PlanRow {
  id: string; week_limit_micro: number; window5h_limit_micro: number; addon_unit_micro: number; stripe_price_id: string;
}
export interface SubscriptionRow {
  user_id: string; plan_id: string; status: "active" | "past_due" | "canceled";
  stripe_customer_id: string; stripe_subscription_id: string;
  current_period_start: string; current_period_end: string;
}

export function subscriptionQuery(uid: string): string {
  return `subscription?user_id=eq.${encodeURIComponent(uid)}&select=user_id,plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end&limit=1`;
}
export function subscriptionByStripeIdQuery(subscriptionId: string): string {
  return `subscription?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id&limit=1`;
}
export function parseSubscriptionRows(v: unknown): SubscriptionRow | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  const r = v[0];
  const status = r.status;
  if (status !== "active" && status !== "past_due" && status !== "canceled") return null;
  const user_id = str(r.user_id), plan_id = str(r.plan_id), cps = str(r.current_period_start), cpe = str(r.current_period_end);
  if (!user_id || !plan_id || !cps || !cpe) return null;
  return {
    user_id, plan_id, status, current_period_start: cps, current_period_end: cpe,
    stripe_customer_id: str(r.stripe_customer_id) ?? "", stripe_subscription_id: str(r.stripe_subscription_id) ?? "",
  };
}

export function plansQuery(): string {
  return "plan?select=id,week_limit_micro,window5h_limit_micro,addon_unit_micro,stripe_price_id";
}
export function parsePlanRows(v: unknown): PlanRow[] {
  if (!Array.isArray(v)) return [];
  const out: PlanRow[] = [];
  for (const r of v) {
    if (!isObj(r)) continue;
    const id = str(r.id), w = num(r.week_limit_micro), h = num(r.window5h_limit_micro), a = num(r.addon_unit_micro);
    if (id === null || w === null || h === null || a === null) continue;
    out.push({ id, week_limit_micro: w, window5h_limit_micro: h, addon_unit_micro: a, stripe_price_id: str(r.stripe_price_id) ?? "" });
  }
  return out;
}
export function planSnapshotOf(sub: SubscriptionRow | null, plans: PlanRow[]): PlanSnapshot | null {
  if (!sub) return null;
  const p = plans.find((x) => x.id === sub.plan_id);
  if (!p) return null;
  return {
    planId: p.id, status: sub.status, window5hLimitMicro: p.window5h_limit_micro, weekLimitMicro: p.week_limit_micro,
    periodStartMs: Date.parse(sub.current_period_start), periodEndMs: Date.parse(sub.current_period_end),
  };
}
export function planIdForPrice(plans: PlanRow[], priceId: string): string | null {
  return plans.find((p) => p.stripe_price_id === priceId && p.id !== "addon")?.id ?? null;
}

export function routesQuery(): string {
  return "model_route?enabled=eq.true&quantization=eq.none&select=id,logical_model,platform,base_url,wire_model,price_in_micro_per_m,price_cache_micro_per_m,price_out_micro_per_m,default_max_tokens&order=priority.asc";
}
export function parseRouteRows(v: unknown): RouteRow[] {
  if (!Array.isArray(v)) return [];
  const out: RouteRow[] = [];
  for (const r of v) {
    if (!isObj(r)) continue;
    const id = str(r.id), lm = str(r.logical_model), pf = str(r.platform), bu = str(r.base_url), wm = str(r.wire_model);
    const pi = num(r.price_in_micro_per_m), pc = num(r.price_cache_micro_per_m), po = num(r.price_out_micro_per_m), mt = num(r.default_max_tokens);
    if (!id || !lm || !pf || !bu || !wm || pi === null || pc === null || po === null || mt === null) continue;
    out.push({ id, logicalModel: lm, platform: pf, baseUrl: bu, wireModel: wm, priceInMicroPerM: pi, priceCacheMicroPerM: pc, priceOutMicroPerM: po, defaultMaxTokens: mt });
  }
  return out;
}

export function usageEventInsert(requestId: string, meta: SettleMeta, chargedTo: "window" | "addon"): Record<string, unknown> {
  return {
    user_id: meta.caller.uid, request_id: requestId, source: meta.caller.source,
    workspace_id: meta.caller.workspaceId, session_id: meta.caller.sessionId,
    logical_model: meta.route.logicalModel, route_id: meta.route.id,
    prompt_tokens: meta.usage.promptTokens, cached_tokens: meta.usage.cachedTokens, completion_tokens: meta.usage.completionTokens,
    cost_micro: meta.costMicro, charged_to: chargedTo,
  };
}

export function rebuildQueries(uid: string, sinceMs: number): { events: string; grants: string; addonConsumed: string } {
  const u = encodeURIComponent(uid);
  const since = new Date(sinceMs).toISOString();
  return {
    events: `usage_event?user_id=eq.${u}&created_at=gte.${since}&select=created_at,cost_micro,charged_to`,
    grants: `credit_grant?user_id=eq.${u}&expires_at=gt.${new Date().toISOString()}&select=micro_usd,expires_at`,
    addonConsumed: `usage_event?user_id=eq.${u}&charged_to=eq.addon&select=sum:cost_micro.sum()`,
  };
}
export function parseRebuildRows(events: unknown, grants: unknown, addonConsumed: unknown): RebuildInput {
  const ev: RebuildInput["events"] = [];
  if (Array.isArray(events)) for (const r of events) {
    if (!isObj(r)) continue;
    const at = str(r.created_at), c = num(r.cost_micro);
    if (!at || c === null || (r.charged_to !== "window" && r.charged_to !== "addon")) continue;
    ev.push({ at: Date.parse(at), costMicro: c, chargedTo: r.charged_to });
  }
  const gr: RebuildInput["grants"] = [];
  if (Array.isArray(grants)) for (const r of grants) {
    if (!isObj(r)) continue;
    const m = num(r.micro_usd), e = str(r.expires_at);
    if (m === null || !e) continue;
    gr.push({ micro: m, expiresAt: Date.parse(e) });
  }
  const consumed = Array.isArray(addonConsumed) && isObj(addonConsumed[0]) ? num(addonConsumed[0].sum) ?? 0 : 0;
  return { events: ev, grants: gr, addonConsumedMicro: consumed };
}

export function subscriptionUpsertBody(a: Extract<BillingAction, { kind: "subscription_upsert" }>, planId: string): Record<string, unknown> {
  return {
    user_id: a.uid, plan_id: planId, status: a.status,
    stripe_customer_id: a.customerId, stripe_subscription_id: a.subscriptionId,
    current_period_start: new Date(a.periodStartMs).toISOString(), current_period_end: new Date(a.periodEndMs).toISOString(),
    updated_at: new Date().toISOString(),
  };
}
export function grantInsertBody(a: Extract<BillingAction, { kind: "grant" }>, unitMicro: number, nowMs: number): Record<string, unknown> {
  const exp = new Date(nowMs);
  exp.setUTCFullYear(exp.getUTCFullYear() + 1);
  return { user_id: a.uid, micro_usd: a.quantity * unitMicro, expires_at: exp.toISOString(), stripe_payment_intent_id: a.paymentIntentId };
}

export function meFromParts(
  sub: SubscriptionRow | null,
  windows: { h5: WindowState; week: WindowState } | null,
  addon: { remainingMicro: number; expiresAt: number | null },
  models: string[]
): BillingMe {
  const plan = sub && (sub.plan_id === "lite" || sub.plan_id === "pro" || sub.plan_id === "max") ? sub.plan_id : null;
  return {
    plan, status: sub ? sub.status : "none",
    windows: sub && sub.status === "active" ? windows : null,
    addon, periodEnd: sub ? Date.parse(sub.current_period_end) : null, models,
  };
}
```

Run: `npx vitest run tests/edge/billingQueries.test.ts` → PASS

- [ ] **Step 3: 改 `worker.ts`**

`Env` 加：

```ts
  /** 托管网关的上游 key（spec 第 2 节）。`wrangler secret put DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` */
  DEEPSEEK_API_KEY?: string;
  ZHIPU_API_KEY?: string;
  /** Stripe。`wrangler secret put STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  QUOTA: DurableObjectNamespace<Quota>;
```

import 区加：

```ts
import { createLlmGateway, type QuotaPort, type RouteRow, type SettleMeta } from "./llmGateway.js";
import {
  emptyState, hold as quotaHold, rebuild, release as quotaRelease, remaining as quotaRemaining, roll,
  settle as quotaSettle, view as quotaView, type PlanSnapshot, type QuotaState,
} from "./quota.js";
import { actionFromEvent, checkoutParams, portalParams, verifyStripeSignature } from "./billing.js";
import {
  grantInsertBody, meFromParts, parsePlanRows, parseRebuildRows, parseRouteRows, parseSubscriptionRows, planIdForPrice,
  planSnapshotOf, plansQuery, rebuildQueries, routesQuery, subscriptionByStripeIdQuery, subscriptionQuery,
  subscriptionUpsertBody, usageEventInsert, type PlanRow, type SubscriptionRow,
} from "./billingQueries.js";
import type { BillingPort, CheckoutTarget } from "./edge.js";
```

Supabase 小工具（放在 `friendChecker` 前面）：

```ts
/** PostgREST：读走 service key，写用 Prefer 头拿回执。失败抛，调用方决定要不要吞 */
function supa(env: Env) {
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  return {
    async get(query: string): Promise<unknown> {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, { headers });
      if (!res.ok) throw new Error(`supabase GET ${query.split("?")[0]} ${res.status}`);
      return res.json();
    },
    async insert(table: string, body: unknown, opts: { ignoreDuplicates?: boolean } = {}): Promise<void> {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", prefer: opts.ignoreDuplicates ? "resolution=ignore-duplicates,return=minimal" : "return=minimal" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`supabase INSERT ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async upsert(table: string, body: unknown): Promise<void> {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`supabase UPSERT ${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    async patch(query: string, body: unknown): Promise<void> {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, {
        method: "PATCH", headers: { ...headers, "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`supabase PATCH ${res.status}`);
    },
  };
}
```

`Quota` DO（放在 `Escrow` 后面）：

```ts
/**
 * 一户一个额度实例（spec 第 2 节）。storage：`state`（QuotaState）。
 * plan 快照在内存里带 60s TTL——DO 睡醒即失，回 DB 读一次（不是每请求读）。
 * 冷启动没有 state 时从 usage_event / credit_grant 重建（一次范围查询）。
 * 所有 op 走 fetch（同 Escrow 的写法）；DO 单线程，读改写在一次 fetch 里完成。
 */
export class Quota extends DurableObject<Env> {
  private planCache: { v: PlanSnapshot | null; sub: SubscriptionRow | null; exp: number } | null = null;

  private async plan(force = false): Promise<{ plan: PlanSnapshot | null; sub: SubscriptionRow | null }> {
    if (!force && this.planCache && this.planCache.exp > Date.now()) return { plan: this.planCache.v, sub: this.planCache.sub };
    const db = supa(this.env);
    const uid = this.ctx.id.name ?? "";
    const [subRows, planRows] = await Promise.all([db.get(subscriptionQuery(uid)), db.get(plansQuery())]);
    const sub = parseSubscriptionRows(subRows);
    const v = planSnapshotOf(sub, parsePlanRows(planRows));
    this.planCache = { v, sub, exp: Date.now() + 60_000 };
    return { plan: v, sub };
  }

  private async state(plan: PlanSnapshot | null): Promise<QuotaState> {
    const stored = await this.ctx.storage.get<QuotaState>("state");
    if (stored) return stored;
    // 冷启动：从事实重建。没订阅也要建（加购余额不依赖订阅）
    const uid = this.ctx.id.name ?? "";
    const db = supa(this.env);
    const since = plan ? plan.periodStartMs : Date.now() - 7 * 86_400_000;
    const q = rebuildQueries(uid, since);
    let rebuilt = emptyState();
    try {
      const [ev, gr, ac] = await Promise.all([db.get(q.events), db.get(q.grants), db.get(q.addonConsumed)]);
      rebuilt = rebuild(parseRebuildRows(ev, gr, ac), plan, Date.now());
    } catch (err) {
      console.error(`quota rebuild 失败（${uid}）：${err instanceof Error ? err.message : String(err)}`);
    }
    await this.ctx.storage.put("state", rebuilt);
    return rebuilt;
  }

  override async fetch(req: Request): Promise<Response> {
    const op = new URL(req.url).pathname.slice(1);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const json = (payload: unknown): Response => Response.json(payload);
    const now = Date.now();

    if (op === "hold") {
      const { plan } = await this.plan();
      const r = quotaHold(await this.state(plan), plan, String(b.requestId), Number(b.estimateMicro), now);
      if (r.ok) await this.ctx.storage.put("state", r.state);
      return json(r.ok ? { ok: true, chargedTo: r.chargedTo } : r);
    }
    if (op === "settle") {
      const { plan } = await this.plan();
      const st = roll(await this.state(plan), now, plan);
      const r = quotaSettle(st, String(b.requestId), Number(b.costMicro));
      if (!r) { await this.ctx.storage.put("state", st); return json({ ok: false, reason: "no_hold" }); }
      await this.ctx.storage.put("state", r.state);
      return json({ ok: true, chargedTo: r.hold.chargedTo });
    }
    if (op === "release") {
      const { plan } = await this.plan();
      await this.ctx.storage.put("state", quotaRelease(await this.state(plan), String(b.requestId)));
      return json({ ok: true });
    }
    if (op === "remaining") {
      const { plan } = await this.plan();
      const st = await this.state(plan);
      return json({ ...quotaRemaining(st, plan, now), plan: plan?.planId ?? null });
    }
    if (op === "view") {
      const { plan, sub } = await this.plan();
      const st = roll(await this.state(plan), now, plan);
      await this.ctx.storage.put("state", st);
      return json({ sub, windows: quotaView(st, plan, now), addon: { remainingMicro: st.addonMicro, expiresAt: st.addonExpiresAt } });
    }
    if (op === "planChanged") {
      // webhook 刚改了订阅：丢缓存，且周窗锚定日可能变了——state 里的 weekStartAt 由下一次 roll 自动对齐
      const { plan } = await this.plan(true);
      await this.ctx.storage.put("state", roll(await this.state(plan), now, plan));
      return json({ ok: true });
    }
    if (op === "addonGranted") {
      // 加购入账：直接把投影往上加；expiresAt 取更早的那个（rebuild 的口径一致）
      const { plan } = await this.plan();
      const st = await this.state(plan);
      const exp = typeof b.expiresAt === "number" ? b.expiresAt : null;
      await this.ctx.storage.put("state", {
        ...st, addonMicro: st.addonMicro + Number(b.micro),
        addonExpiresAt: st.addonExpiresAt === null || exp === null ? (st.addonExpiresAt ?? exp) : Math.min(st.addonExpiresAt, exp),
      });
      return json({ ok: true });
    }
    return json({ error: { message: `没有这个内部操作:${op}`, type: "otto_edge", code: "not_found" } });
  }
}
```

`QuotaPort` 与 `BillingPort` 的实现 + 路由表缓存（放在 `friendChecker` 后面）：

```ts
function quotaPort(env: Env): QuotaPort {
  const call = async (uid: string, op: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await env.QUOTA.getByName(uid).fetch(new Request(`https://quota/${op}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return (await res.json()) as Record<string, unknown>;
  };
  const db = supa(env);
  return {
    async hold(uid, requestId, estimateMicro) {
      return (await call(uid, "hold", { requestId, estimateMicro })) as never;
    },
    async settle(uid, requestId, meta: SettleMeta) {
      const r = await call(uid, "settle", { requestId, costMicro: meta.costMicro });
      if (r.ok !== true) return; // 没有挂着的 hold（超时被清/重复 settle）：不记账，幂等
      const chargedTo = r.chargedTo === "addon" ? "addon" : "window";
      try {
        await db.insert("usage_event", usageEventInsert(requestId, meta, chargedTo), { ignoreDuplicates: true });
      } catch (err) {
        // 投影已经扣了、事实没落——下次 DO 冷启动会少算这一笔。记日志，不回滚投影：
        // 少扣对用户有利，回滚才会把「已经给用户的内容」变成没扣钱又没记录
        console.error(`usage_event 落库失败（${uid}/${requestId}）：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    async release(uid, requestId) { await call(uid, "release", { requestId }); },
    async remaining(uid) {
      const r = await call(uid, "remaining", {});
      return { h5: Number(r.h5), week: Number(r.week), addon: Number(r.addon), plan: typeof r.plan === "string" ? r.plan : null };
    },
  };
}

/** model_route 60s 缓存（Worker isolate 级，best-effort） */
let routesCache: { v: RouteRow[]; exp: number } | null = null;
async function routesOf(env: Env): Promise<RouteRow[]> {
  if (routesCache && routesCache.exp > Date.now()) return routesCache.v;
  const v = parseRouteRows(await supa(env).get(routesQuery()));
  routesCache = { v, exp: Date.now() + 60_000 };
  return v;
}

function billingPort(env: Env): BillingPort {
  const db = supa(env);
  const stripe = async (path: string, params: URLSearchParams): Promise<Record<string, unknown>> => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY ?? ""}`, "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = body.error as { message?: string } | undefined;
      throw new Error(`stripe ${path} ${res.status}: ${e?.message ?? "?"}`);
    }
    return body;
  };
  const quotaCall = (uid: string, op: string, body: unknown) =>
    env.QUOTA.getByName(uid).fetch(new Request(`https://quota/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  return {
    async me(uid) {
      const r = (await (await quotaCall(uid, "view", {})).json()) as { sub: SubscriptionRow | null; windows: never; addon: never };
      const models = [...new Set((await routesOf(env)).map((x) => x.logicalModel))];
      return meFromParts(r.sub, r.windows, r.addon, models);
    },
    async checkout(uid, target: CheckoutTarget, origin) {
      if (!env.STRIPE_SECRET_KEY) return { error: "服务端没配 Stripe" };
      try {
        const plans = parsePlanRows(await db.get(plansQuery()));
        const sub = parseSubscriptionRows(await db.get(subscriptionQuery(uid)));
        const row = plans.find((p) => p.id === ("planId" in target ? target.planId : "addon"));
        if (!row || !row.stripe_price_id) return { error: "这个档位还没配 Stripe price" };
        const params = checkoutParams({
          mode: "planId" in target ? "subscription" : "payment",
          priceId: row.stripe_price_id, quantity: "planId" in target ? 1 : target.quantity, uid,
          ...(sub?.stripe_customer_id ? { customerId: sub.stripe_customer_id } : {}),
          successUrl: `${origin}/billing/v1/done?ok=1`, cancelUrl: `${origin}/billing/v1/done?ok=0`,
        });
        const s = await stripe("checkout/sessions", params);
        return typeof s.url === "string" ? { url: s.url } : { error: "Stripe 没回 url" };
      } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },
    async portal(uid, origin) {
      if (!env.STRIPE_SECRET_KEY) return { error: "服务端没配 Stripe" };
      try {
        const sub = parseSubscriptionRows(await db.get(subscriptionQuery(uid)));
        if (!sub?.stripe_customer_id) return { error: "还没有订阅记录" };
        const s = await stripe("billing_portal/sessions", portalParams(sub.stripe_customer_id, `${origin}/billing/v1/done?ok=1`));
        return typeof s.url === "string" ? { url: s.url } : { error: "Stripe 没回 url" };
      } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
    },
    async webhook(payload, signatureHeader) {
      const ok = await verifyStripeSignature(payload, signatureHeader, env.STRIPE_WEBHOOK_SECRET ?? "", Math.floor(Date.now() / 1000));
      if (!ok) return { status: 400, body: { error: { message: "签名不对", type: "otto_edge", code: "bad_signature" } } };
      let event: unknown;
      try { event = JSON.parse(payload); } catch { return { status: 400, body: { error: { message: "不是 JSON", type: "otto_edge", code: "bad_request" } } }; }
      const a = actionFromEvent(event);
      try {
        if (a.kind === "subscription_upsert") {
          const plans = parsePlanRows(await db.get(plansQuery()));
          const planId = planIdForPrice(plans, a.priceId);
          if (!planId) return { status: 200, body: { ignored: `unknown price ${a.priceId}` } };
          await db.upsert("subscription", subscriptionUpsertBody(a, planId));
          await quotaCall(a.uid, "planChanged", {});
        } else if (a.kind === "subscription_status") {
          const rows = await db.get(subscriptionByStripeIdQuery(a.subscriptionId));
          const uid = Array.isArray(rows) && rows[0] && typeof (rows[0] as { user_id?: unknown }).user_id === "string" ? (rows[0] as { user_id: string }).user_id : null;
          if (!uid) return { status: 200, body: { ignored: `unknown subscription ${a.subscriptionId}` } };
          await db.patch(`subscription?user_id=eq.${encodeURIComponent(uid)}`, { status: a.status, updated_at: new Date().toISOString() });
          await quotaCall(uid, "planChanged", {});
        } else if (a.kind === "grant") {
          const plans = parsePlanRows(await db.get(plansQuery()));
          const unit = plans.find((p) => p.id === "addon")?.addon_unit_micro ?? 0;
          if (unit <= 0) return { status: 200, body: { ignored: "addon unit not configured" } };
          const body = grantInsertBody(a, unit, Date.now());
          // 幂等键是 payment_intent；重投的 webhook 在这里被 ignore-duplicates 吞掉，且**不**再通知 DO
          // （否则重投一次就多发一次额度）。判断是否新插入：先查一次
          const dup = await db.get(`credit_grant?stripe_payment_intent_id=eq.${encodeURIComponent(a.paymentIntentId)}&select=id`);
          if (Array.isArray(dup) && dup.length > 0) return { status: 200, body: { ignored: "duplicate" } };
          await db.insert("credit_grant", body, { ignoreDuplicates: true });
          await quotaCall(a.uid, "addonGranted", { micro: body.micro_usd, expiresAt: Date.parse(body.expires_at as string) });
        }
        return { status: 200, body: { ok: true, kind: a.kind } };
      } catch (err) {
        // 5xx 让 Stripe 重投（它会按退避重试三天）
        return { status: 500, body: { error: { message: err instanceof Error ? err.message : String(err), type: "otto_edge", code: "upstream" } } };
      }
    },
  };
}
```

`handler.fetch` 的 `createEdge({...})` 加两项：

```ts
      llm: createLlmGateway({
        routes: () => routesOf(env),
        quota: quotaPort(env),
        upstreamKey: (platform) => (platform === "deepseek" ? env.DEEPSEEK_API_KEY : platform === "zhipu" ? env.ZHIPU_API_KEY : undefined),
      }),
      billing: billingPort(env),
```

- [ ] **Step 4: `wrangler.jsonc`**

`bindings` 加 `{ "name": "QUOTA", "class_name": "Quota" }`，`migrations` 加 `{ "tag": "v3", "new_sqlite_classes": ["Quota"] }`，末尾注释加四行 secret：

```jsonc
  // 托管网关 + 计费（spec 2026-09-02）四个 secret：
  //   npx wrangler secret put DEEPSEEK_API_KEY
  //   npx wrangler secret put ZHIPU_API_KEY
  //   npx wrangler secret put STRIPE_SECRET_KEY
  //   npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

- [ ] **Step 5: 跑 edge 的 tsc**

Run: `npx tsc --noEmit -p services/edge`
Expected: 0 errors。常见错：`this.ctx.id.name` 可能为 `string | undefined`（已用 `?? ""`）；`Response.json` 在 workers-types 里存在。

- [ ] **Step 6: `checks/llm.mjs`**

```js
// services/edge/checks/llm.mjs
// 托管网关的真机自检：签一个短命 JWT，打 /billing/v1/me 与一次非流式 chat。
//   node checks/llm.mjs                        # 打生产
//   node checks/llm.mjs http://127.0.0.1:8799  # 打本地 wrangler dev
// 需要 SUPABASE_JWT_SECRET（env 或 .dev.vars）。**这一笔会真扣被签用户的额度**——
// 用 OTTO_CHECK_UID 指定一个测试账号（默认随机 uuid，那样会拿到 402，也算通了身份这一层）。
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://edge.mrotto.agency").replace(/\/+$/, "");
function secret() {
  if (process.env.SUPABASE_JWT_SECRET) return process.env.SUPABASE_JWT_SECRET;
  try {
    const m = /SUPABASE_JWT_SECRET\s*=\s*"?([^"\n]+)"?/.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
    if (m) return m[1];
  } catch {}
  throw new Error("缺 SUPABASE_JWT_SECRET");
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const uid = process.env.OTTO_CHECK_UID ?? randomUUID();
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({ sub: uid, email: "check@otto", exp: Math.floor(Date.now() / 1000) + 300 });
const token = `${head}.${body}.${createHmac("sha256", secret()).update(`${head}.${body}`).digest("base64url")}`;

const me = await fetch(`${BASE}/billing/v1/me`, { headers: { authorization: `Bearer ${token}` } });
console.log("me", me.status, await me.text());

const chat = await fetch(`${BASE}/llm/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "回复一个字：好" }], max_tokens: 5 }),
});
console.log("chat", chat.status, [...chat.headers.entries()].filter(([k]) => k.startsWith("x-otto-")), (await chat.text()).slice(0, 300));
if (!process.env.OTTO_CHECK_UID && chat.status !== 402) throw new Error(`随机 uid 应得 402，实得 ${chat.status}`);
```

`services/edge/package.json` 的 scripts 加 `"check:llm": "node checks/llm.mjs"`。

- [ ] **Step 7: README**

`services/edge/README.md`：标题下那句「两件事」改成三件；端点表加五行（`/llm/v1/chat/completions`、`/billing/v1/me|checkout|portal|webhook|done`，各自的状态码写上：402 no_subscription、429 quota_exhausted/too_many_inflight、502 upstream）；新增「## 托管网关与计费」一节写：身份两种（`x-runtime-secret` + `x-otto-on-behalf-of`）、hold/settle 一段、DO 冷启动重建、四个 secret；新增「## 部署与手验（订阅制）」照 spec 第 8 节四步 + 手验六条：① 随机 uid 打 `/me` 得 `status:none`；② 手工在 DB 插一行 `subscription` 后 `/me` 出窗口；③ `check:llm` 带 `OTTO_CHECK_UID` 扣到账、`usage_event` 多一行、响应头剩余额度减少；④ `stripe listen --forward-to http://127.0.0.1:8799/billing/v1/webhook` + `stripe trigger customer.subscription.created` 落库；⑤ 把 `plan.window5h_limit_micro` 临时改成 1 → 429 quota_exhausted 带 resetAt；⑥ 删掉 DO storage（`wrangler` 里没有直接命令，改成：换一个 uid 重来）验冷启动重建。

- [ ] **Step 8: 提交**

```bash
git add services/edge/src/billingQueries.ts tests/edge/billingQueries.test.ts services/edge/src/worker.ts services/edge/wrangler.jsonc services/edge/checks/llm.mjs services/edge/package.json services/edge/README.md
git commit -m "feat(edge): Quota DO + Supabase/Stripe 装配 + 部署清单（#696）

DO 只握投影，usage_event 才是钱的事实；冷启动从事实重建而不是从零开始——
从零开始 = 睡一觉醒来额度全满。usage_event 落库失败不回滚投影：少扣对用户有利，
回滚才会把「已经给出去的内容」变成没扣也没记。加购 webhook 先查再插，
重投不会多发一次额度。"
```

---

### Task 8: adapter 侧——`reroute` 错误类、响应头回调、`ModelReply.route`

**Files:**
- Modify: `src/model/errorClass.ts`（`ModelErrorClass` 加 `"reroute"`）
- Modify: `src/model/adapter.ts`（`ModelReply` 加 `route?: "hosted" | "direct"`）
- Modify: `src/model/openaiCompatible.ts`（`ResolvedEndpoint` 加 `route?`、`onResponse?`；非 2xx 时解析 edge 信封；重试环里 `reroute` 立刻重来一次）
- Modify: `src/session/events.ts:294`（`errorClass` 字段联合加 `"reroute"`）
- Test: `tests/model/errorClass.test.ts`（加一条）、`tests/model/openaiCompatibleHosted.test.ts`（新）

**Interfaces:**
- Consumes：`parseBillingError`、`remainingFromHeaders`（Task 1）
- Produces：
  ```ts
  // errorClass.ts
  export type ModelErrorClass = "rate-limit" | "retryable" | "fatal" | "reroute";
  export interface RerouteInfo { window?: "5h" | "week"; resetAt?: number }
  export function markReroute<T extends Error>(err: T, info: RerouteInfo): T
  export function rerouteInfoOf(err: unknown): RerouteInfo | undefined
  // openaiCompatible.ts
  export interface ResolvedEndpoint { baseUrl; apiKey; headers?; route?: "hosted" | "direct" }
  // OpenAICompatibleOptions 增：
  //   onResponse?: (info: { route: "hosted" | "direct"; headers: Headers }) => void   // 每次 2xx 响应头
  //   onReroute?: (info: RerouteInfo) => void                                          // 收到 quota_exhausted 那一刻
  ```

行为：
- 上游非 2xx 时，先 `parseBillingError(status, JSON.parse(body))`：`quota_exhausted` → `markErrorClass(err, "reroute")` + `markReroute(err, {window, resetAt})` + 调 `opts.onReroute?.(info)` + `markRetryable`（首 token 前）；其余 edge 错误码（`no_subscription` / `unknown_model` / `too_many_inflight` / `upstream`）→ 原有 `classifyStatus` 逻辑不变（`too_many_inflight` 是 429 → rate-limit 退避，正是想要的）。
- 重试环：`errorClassOf(err) === "reroute"` 时**不睡退避**，立即下一轮（`resolveEndpoint` 会因为快照已标 exhausted 而给出 direct 或抛 blocked）。为防死循环，reroute 只允许一次：第二次 reroute 直接抛。
- 2xx 时调 `opts.onResponse?.({ route: endpoint.route ?? "direct", headers: res.headers })`。
- `ModelReply` 带 `route: endpoint.route ?? "direct"`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/model/openaiCompatibleHosted.test.ts
import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../src/model/openaiCompatible.js";
import { errorClassOf, rerouteInfoOf } from "../../src/model/errorClass.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";

const quotaBody = JSON.stringify({ error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时额度已用完", window: "5h", resetAt: 123 } });
const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

function adapter(endpoints: ResolvedEndpoint[], hooks: { onResponse?: (i: unknown) => void; onReroute?: (i: unknown) => void } = {}) {
  let i = 0;
  return createOpenAICompatibleAdapter({
    baseUrl: "x", apiKey: "x", model: "deepseek-v4-flash",
    resolveEndpoint: async () => endpoints[Math.min(i++, endpoints.length - 1)]!,
    timing: { maxAttempts: 3, backoffMs: [0] },
    ...hooks,
  });
}

describe("托管路由的 adapter 行为", () => {
  it("quota_exhausted → 标 reroute 类 + 带 window/resetAt + 调 onReroute，然后立刻重解析端点重来", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(quotaBody, { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    const onReroute = vi.fn();
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }, { baseUrl: "https://up/v1", apiKey: "sk", route: "direct" }], { onReroute });
    const reply = await a.chat([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("hi");
    expect(reply.route).toBe("direct");
    expect(onReroute).toHaveBeenCalledWith({ window: "5h", resetAt: 123 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![0] as string)).toContain("https://up/v1");
    fetchMock.mockRestore();
  });

  it("第二次 reroute 直接抛（不死循环），错误带 reroute 类与 info", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(quotaBody, { status: 429 }));
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    await expect(a.chat([{ role: "user", content: "hi" }])).rejects.toSatisfy((e: unknown) =>
      errorClassOf(e) === "reroute" && rerouteInfoOf(e)?.window === "5h");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it("2xx 时 onResponse 拿到 route 与响应头（剩余额度从这儿刷）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(okBody, { status: 200, headers: { [BILLING_HEADERS.h5]: "9" } }));
    const onResponse = vi.fn();
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }], { onResponse });
    const reply = await a.chat([{ role: "user", content: "hi" }]);
    expect(reply.route).toBe("hosted");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]![0].route).toBe("hosted");
    expect(onResponse.mock.calls[0]![0].headers.get(BILLING_HEADERS.h5)).toBe("9");
    fetchMock.mockRestore();
  });

  it("非 edge 信封的 429 照旧是 rate-limit（退避重试），不是 reroute", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    const onReroute = vi.fn();
    const a = adapter([{ baseUrl: "https://up/v1", apiKey: "sk" }], { onReroute });
    await a.chat([{ role: "user", content: "hi" }]);
    expect(onReroute).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
```

`tests/model/errorClass.test.ts` 加：

```ts
  it("markReroute / rerouteInfoOf：info 贴在错误上，跨 try 边界原样上抛", () => {
    const e = markReroute(markErrorClass(new Error("x"), "reroute"), { window: "week", resetAt: 5 });
    expect(errorClassOf(e)).toBe("reroute");
    expect(rerouteInfoOf(e)).toEqual({ window: "week", resetAt: 5 });
    expect(rerouteInfoOf(new Error("plain"))).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/model/openaiCompatibleHosted.test.ts tests/model/errorClass.test.ts`

- [ ] **Step 3: 改 `errorClass.ts`**

```ts
export type ModelErrorClass = "rate-limit" | "retryable" | "fatal" | "reroute";

/** 网关说额度用完了（429 quota_exhausted）。种类单列：它既不该退避（等上游没用，等的是窗口）
    也不是致命（配了自己的 key 换条路就能走）——adapter 收到立刻重解析端点重来一次 */
export interface RerouteInfo { window?: "5h" | "week"; resetAt?: number }

export function markReroute<T extends Error>(err: T, info: RerouteInfo): T {
  (err as T & { reroute?: RerouteInfo }).reroute = info;
  return err;
}
export function rerouteInfoOf(err: unknown): RerouteInfo | undefined {
  if (!(err instanceof Error)) return undefined;
  const r = (err as { reroute?: unknown }).reroute;
  return r !== null && typeof r === "object" ? (r as RerouteInfo) : undefined;
}
```

`errorClassOf` 的判断加上 `|| cls === "reroute"`。`src/session/events.ts:294` 的 `errorClass?: "rate-limit" | "retryable" | "fatal"` 改成 `ModelErrorClass`（import type from `../model/errorClass.js`——检查 `tests/architecture.test.ts` 是否允许 session → model 的 import；若不允许，把联合类型字面量写成四个值）。

- [ ] **Step 4: 改 `adapter.ts` 与 `openaiCompatible.ts`**

`ModelReply` 加：

```ts
  /** 这次调用走的哪条路（ADR-0176）。缺省 = direct（老 adapter / 测试假货） */
  route?: "hosted" | "direct";
```

`openaiCompatible.ts`：

```ts
import { parseBillingError } from "../shared/billing.js";
import { classifyStatus, errorClassOf, markErrorClass, markReroute, type RerouteInfo } from "./errorClass.js";

export interface ResolvedEndpoint {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** 走的哪条路；缺省 direct */
  route?: "hosted" | "direct";
}
// OpenAICompatibleOptions 增两项：
  /** 每次 2xx 响应的头（托管模式的剩余额度从这里刷，见 main/hostedQuota.ts） */
  onResponse?: (info: { route: "hosted" | "direct"; headers: Headers }) => void;
  /** 网关说额度用完那一刻（改道之前）。调用方据此把快照标成 exhausted，
      让紧接着的 resolveEndpoint 给出另一条路 */
  onReroute?: (info: RerouteInfo) => void;
```

`attemptChat` 里 `if (!res.ok)` 那段改成：

```ts
      if (!res.ok) {
        const errBody = await res.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(errBody); } catch { /* 非 JSON：不是 edge 信封 */ }
        const billing = parseBillingError(res.status, parsed);
        if (billing?.code === "quota_exhausted") {
          const info: RerouteInfo = { ...(billing.window ? { window: billing.window } : {}), ...(billing.resetAt !== undefined ? { resetAt: billing.resetAt } : {}) };
          opts.onReroute?.(info);
          throw markRetryable(markReroute(markErrorClass(new Error(`model API 429: ${billing.message}`), "reroute"), info));
        }
        const err = markErrorClass(
          new Error(`model API ${res.status}: ${errBody.slice(0, 500)}`),
          classifyStatus(res.status)
        );
        throw errorClassOf(err) === "fatal" ? err : markRetryable(err);
      }
      opts.onResponse?.({ route: endpoint.route ?? "direct", headers: res.headers });
```

两个 return 的 `ModelReply` 都加 `route: endpoint.route ?? "direct",`。

`chat` 的重试环改成：

```ts
      let rerouted = false;
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        try {
          return await attemptChat(body, onDelta, signal);
        } catch (err) {
          if (errorClassOf(err) === "reroute") {
            // 改道只给一次机会：第二次还是额度用完 = 另一条路也没有，抛给 engine
            if (rerouted || signal?.aborted) throw err;
            rerouted = true;
            continue; // 不睡退避——等的是窗口不是上游
          }
          if (!isRetryable(err) || attempt >= timing.maxAttempts || signal?.aborted) throw err;
          await sleep(timing.backoffMs[Math.min(attempt - 1, timing.backoffMs.length - 1)] ?? 0, signal);
        }
      }
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/model/ && npx tsc --noEmit`
Expected: PASS；`tests/model/openaiCompatible.test.ts` 旧用例不变。

- [ ] **Step 6: 提交**

```bash
git add src/model/errorClass.ts src/model/adapter.ts src/model/openaiCompatible.ts src/session/events.ts tests/model/
git commit -m "feat(model): 网关 quota_exhausted 单列 reroute 类，立刻换路重来一次（#696）

它既不该退避（等上游没用，等的是窗口）也不致命（配了自己的 key 换条路就能走），
所以不进 #283 那套退避重试，而是重解析端点立即重来；只给一次机会防死循环。
2xx 响应头回调给主进程刷剩余额度，ModelReply 带 route 让日志记下钱从谁账上出。"
```

---

### Task 9: 主进程额度快照 + 计费客户端 `src/main/hostedQuota.ts`

**Files:**
- Create: `src/main/hostedQuota.ts`
- Test: `tests/main/hostedQuota.test.ts`

**Interfaces:**
- Consumes：`BillingMe`、`parseBillingMe`、`remainingFromHeaders`、`PlanId`（Task 1）；`RerouteInfo`（Task 8）
- Produces：
  ```ts
  export interface HostedQuotaDeps { baseUrl: () => string; accessToken: () => Promise<string | null>; fetchImpl?: typeof fetch; now?: () => number; log?: (m: string) => void }
  export interface HostedSnapshot { me: BillingMe | null; fetchedAt: number; exhausted: { window: "5h" | "week"; resetAt: number } | null }
  export interface HostedQuota {
    snapshot(): HostedSnapshot;
    /** 路由判断用的三元组 */
    routeInput(model: string): { subscribed: boolean; exhausted: boolean; supportsModel: boolean; resetAt?: number };
    refresh(): Promise<BillingMe | null>;          // GET /billing/v1/me；失败保留旧快照
    noteHeaders(h: Headers): void;                  // 每次网关响应头
    noteExhausted(info: RerouteInfo): void;         // 429 那一刻
    checkout(target: { planId: PlanId } | { addon: true; quantity: number }): Promise<string>;  // 回 url，失败抛
    portal(): Promise<string>;
    onChange(cb: (s: HostedSnapshot) => void): () => void;
  }
  export function createHostedQuota(deps: HostedQuotaDeps): HostedQuota
  ```
- 规则：`exhausted` 到 `resetAt` 自动失效（`routeInput` 现算）；`noteHeaders` 把 h5/week 剩余为 0 视为 exhausted（resetAt 取快照里对应窗的 resetAt）；`refresh` 成功清掉 exhausted（以服务端为准）；没登录（token null）→ `me: null`，`subscribed=false`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/main/hostedQuota.test.ts
import { describe, expect, it, vi } from "vitest";
import { createHostedQuota } from "../../src/main/hostedQuota.js";
import { BILLING_HEADERS, type BillingMe } from "../../src/shared/billing.js";

const T0 = 1_800_000_000_000;
const me: BillingMe = {
  plan: "pro", status: "active",
  windows: { h5: { usedMicro: 0, limitMicro: 100, resetAt: T0 + 5000 }, week: { usedMicro: 0, limitMicro: 1000, resetAt: T0 + 9000 } },
  addon: { remainingMicro: 0, expiresAt: null }, periodEnd: T0 + 99_999, models: ["deepseek-v4-flash"],
};

function make(responses: Array<() => Response>, token: string | null = "jwt") {
  let now = T0;
  const fetchImpl = vi.fn(async () => (responses.shift() ?? (() => new Response("{}", { status: 500 })))()) as unknown as typeof fetch;
  const q = createHostedQuota({ baseUrl: () => "https://edge", accessToken: async () => token, fetchImpl, now: () => now });
  return { q, fetchImpl, tick: (ms: number) => { now += ms; } };
}

describe("hostedQuota", () => {
  it("refresh：带 JWT 打 /billing/v1/me，快照更新；routeInput 认订阅与型号", async () => {
    const { q, fetchImpl } = make([() => Response.json(me)]);
    expect(await q.refresh()).toEqual(me);
    const req = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(req[0]).toBe("https://edge/billing/v1/me");
    expect((req[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer jwt" });
    expect(q.routeInput("deepseek-v4-flash")).toEqual({ subscribed: true, exhausted: false, supportsModel: true });
    expect(q.routeInput("gpt-9").supportsModel).toBe(false);
  });

  it("没登录 → me=null、subscribed=false，不打网络", async () => {
    const { q, fetchImpl } = make([], null);
    expect(await q.refresh()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(q.routeInput("deepseek-v4-flash").subscribed).toBe(false);
  });

  it("refresh 失败保留旧快照（「拿不到」≠「没订阅」）", async () => {
    const { q } = make([() => Response.json(me), () => new Response("x", { status: 500 })]);
    await q.refresh();
    expect(await q.refresh()).toEqual(me);
    expect(q.routeInput("deepseek-v4-flash").subscribed).toBe(true);
  });

  it("noteExhausted → exhausted 直到 resetAt；过点自动恢复；refresh 成功也清掉", async () => {
    const { q, tick } = make([() => Response.json(me), () => Response.json(me)]);
    await q.refresh();
    q.noteExhausted({ window: "5h", resetAt: T0 + 5000 });
    expect(q.routeInput("deepseek-v4-flash")).toMatchObject({ exhausted: true, resetAt: T0 + 5000 });
    tick(5001);
    expect(q.routeInput("deepseek-v4-flash").exhausted).toBe(false);
    q.noteExhausted({ window: "week", resetAt: T0 + 9000 });
    await q.refresh();
    expect(q.routeInput("deepseek-v4-flash").exhausted).toBe(false);
  });

  it("noteHeaders：剩余为 0 视为耗尽（resetAt 取快照里那个窗），非 0 更新 used", async () => {
    const { q } = make([() => Response.json(me)]);
    await q.refresh();
    q.noteHeaders(new Headers({ [BILLING_HEADERS.h5]: "40" }));
    expect(q.snapshot().me?.windows?.h5.usedMicro).toBe(60);
    q.noteHeaders(new Headers({ [BILLING_HEADERS.week]: "0" }));
    expect(q.routeInput("deepseek-v4-flash")).toMatchObject({ exhausted: true, resetAt: T0 + 9000 });
  });

  it("checkout / portal 回 url；服务端报错抛 message", async () => {
    const { q, fetchImpl } = make([() => Response.json({ url: "https://s/1" }), () => Response.json({ error: { message: "没配", type: "otto_edge", code: "upstream" } }, { status: 502 })]);
    expect(await q.checkout({ planId: "pro" })).toBe("https://s/1");
    const body = JSON.parse(((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ planId: "pro" });
    await expect(q.portal()).rejects.toThrow("没配");
  });

  it("onChange 在 refresh / noteExhausted / noteHeaders 后各触发一次", async () => {
    const { q } = make([() => Response.json(me)]);
    const cb = vi.fn();
    q.onChange(cb);
    await q.refresh();
    q.noteExhausted({ window: "5h", resetAt: T0 + 1 });
    q.noteHeaders(new Headers({ [BILLING_HEADERS.h5]: "1" }));
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败，写实现**

```ts
// src/main/hostedQuota.ts
// 托管额度的主进程快照（spec 第 4 节）。三个更新源：启动/设置页 refresh、每次网关响应头、
// 429 那一刻。routeModel 的 hosted 输入从这里来；渲染层的订阅页也从这里读（经 IPC）。
//
// 「拿不到」≠「没订阅」：refresh 失败保留旧快照（同 pxCloudClient 的 fetchGrants 纪律）。
// exhausted 是带过期的记号：到 resetAt 自动失效，不用定时器——routeInput 现算。

import type { RerouteInfo } from "../model/errorClass.js";
import { parseBillingError, parseBillingMe, remainingFromHeaders, type BillingMe, type PlanId } from "../shared/billing.js";

export interface HostedQuotaDeps {
  baseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export interface HostedSnapshot {
  me: BillingMe | null;
  fetchedAt: number;
  exhausted: { window: "5h" | "week"; resetAt: number } | null;
}

export type CheckoutTarget = { planId: PlanId } | { addon: true; quantity: number };

export interface HostedQuota {
  snapshot(): HostedSnapshot;
  routeInput(model: string): { subscribed: boolean; exhausted: boolean; supportsModel: boolean; resetAt?: number };
  refresh(): Promise<BillingMe | null>;
  noteHeaders(h: Headers): void;
  noteExhausted(info: RerouteInfo): void;
  checkout(target: CheckoutTarget): Promise<string>;
  portal(): Promise<string>;
  onChange(cb: (s: HostedSnapshot) => void): () => void;
}

export function createHostedQuota(deps: HostedQuotaDeps): HostedQuota {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let snap: HostedSnapshot = { me: null, fetchedAt: 0, exhausted: null };
  const listeners = new Set<(s: HostedSnapshot) => void>();
  const emit = () => { for (const cb of listeners) cb(snap); };

  const liveExhausted = (): HostedSnapshot["exhausted"] =>
    snap.exhausted && snap.exhausted.resetAt > now() ? snap.exhausted : null;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await deps.accessToken();
    if (!token) throw new Error("还没登录");
    const res = await doFetch(`${deps.baseUrl()}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = parseBillingError(res.status, payload);
      throw new Error(e?.message ?? `HTTP ${res.status}`);
    }
    return (payload ?? {}) as Record<string, unknown>;
  }

  return {
    snapshot: () => ({ ...snap, exhausted: liveExhausted() }),

    routeInput(model) {
      const me = snap.me;
      const subscribed = me !== null && me.status === "active" && me.plan !== null;
      const ex = liveExhausted();
      return {
        subscribed, exhausted: ex !== null, supportsModel: me?.models.includes(model) ?? false,
        ...(ex ? { resetAt: ex.resetAt } : {}),
      };
    },

    async refresh() {
      const token = await deps.accessToken();
      if (!token) { snap = { me: null, fetchedAt: now(), exhausted: null }; emit(); return null; }
      try {
        const res = await doFetch(`${deps.baseUrl()}/billing/v1/me`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const me = parseBillingMe(await res.json());
        if (!me) throw new Error("/me 形状不对");
        snap = { me, fetchedAt: now(), exhausted: null }; // 服务端说了算：拿到新快照就清 exhausted
        emit();
        return me;
      } catch (err) {
        log(`billing /me 失败：${err instanceof Error ? err.message : String(err)}，保留旧快照`);
        return snap.me;
      }
    },

    noteHeaders(h) {
      const r = remainingFromHeaders(h);
      const me = snap.me;
      if (!me || !me.windows) return;
      const windows = {
        h5: r.h5 === undefined ? me.windows.h5 : { ...me.windows.h5, usedMicro: Math.max(0, me.windows.h5.limitMicro - r.h5) },
        week: r.week === undefined ? me.windows.week : { ...me.windows.week, usedMicro: Math.max(0, me.windows.week.limitMicro - r.week) },
      };
      const addon = r.addon === undefined ? me.addon : { ...me.addon, remainingMicro: r.addon };
      let exhausted = liveExhausted();
      if (r.h5 === 0 && (r.addon ?? addon.remainingMicro) === 0) exhausted = { window: "5h", resetAt: windows.h5.resetAt };
      else if (r.week === 0 && (r.addon ?? addon.remainingMicro) === 0) exhausted = { window: "week", resetAt: windows.week.resetAt };
      snap = { ...snap, me: { ...me, windows, addon }, exhausted };
      emit();
    },

    noteExhausted(info) {
      const window = info.window ?? "5h";
      const fallback = snap.me?.windows ? (window === "5h" ? snap.me.windows.h5.resetAt : snap.me.windows.week.resetAt) : now() + 5 * 60_000;
      snap = { ...snap, exhausted: { window, resetAt: info.resetAt ?? fallback } };
      emit();
    },

    async checkout(target) {
      const r = await post("/billing/v1/checkout", target);
      if (typeof r.url !== "string") throw new Error("服务端没回 url");
      return r.url;
    },
    async portal() {
      const r = await post("/billing/v1/portal", {});
      if (typeof r.url !== "string") throw new Error("服务端没回 url");
      return r.url;
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/main/hostedQuota.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/main/hostedQuota.ts tests/main/hostedQuota.test.ts
git commit -m "feat(main): 托管额度快照 + /me、checkout、portal 客户端（#696）

三个更新源汇成一份快照：启动 refresh、每次响应头、429 那一刻。exhausted 是带过期的记号，
到 resetAt 自动失效不用定时器；refresh 失败保留旧快照——「拿不到」≠「没订阅」，
把前者当后者会让付了钱的人被路由去烧自己的 key。"
```

---

### Task 10: 桌面路由——`hosted` 出路、改道事件、`assistant_message.route`

**Files:**
- Modify: `src/main/modelRoute.ts`
- Modify: `src/session/events.ts`（新事件 `route_changed`；`AssistantMessageEvent.route?`；`KNOWN_EVENT_TYPES_MAP`）
- Modify: `src/loop/engine.ts:674-686`（append 时带 `route`）
- Modify: `src/main/agent.ts:184`（opts 加 `hosted?`）与 `:502`（`resolveEndpoint`）与 `makeAdapter`（`onResponse` / `onReroute`）
- Modify: `src/main/index.ts:1863` 附近与 `:2120`（createAgent 注入 `hosted`）；装配 `createHostedQuota`
- Test: `tests/main/modelRoute.test.ts`（扩）、`tests/session/events.test.ts`（若存在则加 route_changed 可重放一条；否则加到 `tests/main/agent.test.ts`）

**Interfaces:**
- Consumes：`HostedQuota`（Task 9）、`RerouteInfo`（Task 8）
- Produces：
  ```ts
  // modelRoute.ts
  export type ModelRoute =
    | { kind: "hosted"; baseUrl: string; apiKey: string }
    | { kind: "direct"; baseUrl: string; apiKey: string }
    | { kind: "blocked"; reason: string };
  export interface HostedInput { subscribed: boolean; exhausted: boolean; supportsModel: boolean; resetAt?: number }
  // RouteInput 增：hosted?: HostedInput; hostedBaseUrl?: string; hostedToken?: string
  // events.ts
  export interface RouteChangedEvent extends SessionEventBase { type: "route_changed"; from: "hosted" | "direct"; to: "hosted" | "direct"; reason: "quota_exhausted"; resetAt?: number; ignorable: true }
  // AssistantMessageEvent 增：route?: "hosted" | "direct"
  // agent.ts createAgent opts 增：
  //   hosted?: { quota: HostedQuota; edgeBaseUrl: () => string; accessToken: () => Promise<string | null> }
  ```

- [ ] **Step 1: 扩 `tests/main/modelRoute.test.ts`**

```ts
describe("routeModel：托管优先（ADR-0176 决定二）", () => {
  const hosted = { subscribed: true, exhausted: false, supportsModel: true };
  const hostedArgs = { hosted, hostedBaseUrl: "https://edge/llm/v1", hostedToken: "jwt" };

  it("有订阅 + 未耗尽 + 网关供这款 → hosted，哪怕配了自己的 key", () => {
    expect(route({ ownKey: "sk-mine", ...hostedArgs })).toEqual({ kind: "hosted", baseUrl: "https://edge/llm/v1", apiKey: "jwt" });
  });
  it("耗尽 + 有自己的 key → direct（耗尽处置第二条出路）", () => {
    expect(route({ ownKey: "sk-mine", ...hostedArgs, hosted: { ...hosted, exhausted: true, resetAt: 5 } }).kind).toBe("direct");
  });
  it("耗尽 + 没 key → blocked，措辞带恢复时间", () => {
    const r = route({ ...hostedArgs, hosted: { ...hosted, exhausted: true, resetAt: Date.UTC(2026, 8, 2, 10) } });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toMatch(/额度.*恢复/);
  });
  it("网关不供这款 + 没 key → blocked，措辞说清是型号不在网关", () => {
    const r = route({ ...hostedArgs, hosted: { ...hosted, supportsModel: false } });
    expect(r.kind === "blocked" && r.reason).toContain("网关");
  });
  it("无订阅 + 没 key → blocked，措辞把两条出路都说出来", () => {
    const r = route({ hosted: { subscribed: false, exhausted: false, supportsModel: true } });
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).toContain(deepseek.apiKeyEnv);
  });
  it("有订阅但没拿到 JWT（token 过期）→ 退回 direct/blocked，不发一个空 Bearer", () => {
    expect(route({ ownKey: "sk", hosted, hostedBaseUrl: "https://edge/llm/v1" }).kind).toBe("direct");
  });
});
```

- [ ] **Step 2: 改 `modelRoute.ts`**

```ts
export type ModelRoute =
  /** 托管：官方 key + 用户订阅额度（ADR-0176 决定二） */
  | { kind: "hosted"; baseUrl: string; apiKey: string }
  | { kind: "direct"; baseUrl: string; apiKey: string }
  | { kind: "blocked"; reason: string };

export interface HostedInput {
  subscribed: boolean;
  exhausted: boolean;
  supportsModel: boolean;
  resetAt?: number;
}

export interface RouteInput {
  choice: ModelChoice;
  ownKey: string;
  ownBaseUrl?: string | undefined;
  lane?: ModelLane;
  /** 托管额度快照（main/hostedQuota.ts 的 routeInput）。缺席 = 没装配托管（测试/子会话） */
  hosted?: HostedInput;
  /** 网关 /llm/v1 前缀 */
  hostedBaseUrl?: string;
  /** 当前 Supabase JWT；缺 = 没登录或拿不到，托管这条路走不了 */
  hostedToken?: string;
}

const fmtReset = (ms: number): string =>
  new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function routeModel(input: RouteInput): ModelRoute {
  const { choice, ownKey, ownBaseUrl, lane, hosted } = input;

  // 1. 有活跃订阅、额度没耗尽、网关供这款、拿得到 JWT → 走网关（付费订阅下托管优先，ADR-0176 决定二）
  if (hosted?.subscribed && !hosted.exhausted && hosted.supportsModel && input.hostedBaseUrl && input.hostedToken) {
    return { kind: "hosted", baseUrl: input.hostedBaseUrl, apiKey: input.hostedToken };
  }
  // 2/3. 自带 key → 直连（耗尽处置的第二条出路，或压根没订阅）
  if (ownKey) return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: ownKey };
  if (choice.keyless) return { kind: "direct", baseUrl: ownBaseUrl ?? choice.baseUrl, apiKey: "ollama" };

  // 4. blocked：措辞分三种，得说清缺的是哪一样
  if (hosted?.subscribed && hosted.exhausted) {
    const when = hosted.resetAt ? `${fmtReset(hosted.resetAt)} 恢复` : "窗口重置后恢复";
    return { kind: "blocked", reason: `订阅额度已用完，${when}。等不及可以加购，或在设置里填自己的 ${choice.apiKeyEnv}。` };
  }
  if (hosted?.subscribed && !hosted.supportsModel) {
    return { kind: "blocked", reason: `网关暂不供 ${choice.label}，换一款网关供的型号，或在设置里填自己的 ${choice.apiKeyEnv}。` };
  }
  const grantGone = lane === "grant" ? "官方赠额已停止提供，" : "";
  return {
    kind: "blocked",
    reason: `${grantGone}用 ${choice.label} 有两条路：订阅 Mr Otto（设置 → 订阅），或在设置里填自己的 ${choice.apiKeyEnv}。`,
  };
}
```

文件头那段「现在只剩两种结局」的注释改成三种，指向 ADR-0176。

- [ ] **Step 3: `events.ts`**

`AssistantMessageEvent` 加：

```ts
  /** 这条回复走的哪条路（ADR-0176）：hosted = 官方 key + 订阅额度，direct = 用户自己的 key。
      UI 据此决定显示「X credit」还是「$X」（决定五）。缺省 = direct（旧日志 / 子会话），
      可选 = 旧日志照常重放 */
  route?: "hosted" | "direct";
```

`ModelChangedEvent` 后面加：

```ts
/** 额外 N：调用中途改道（issue #696）。托管额度用完、自动落到用户自己的 key 那一刻——
    钱从谁账上出变了，日志推不出来（assistant_message.route 只说结果，不说为什么），
    而 UI 要在那一刻提示一次「本次起用的是你自己的 key」。ignorable：模型不可见的注记 */
export interface RouteChangedEvent extends SessionEventBase {
  type: "route_changed";
  from: "hosted" | "direct";
  to: "hosted" | "direct";
  reason: "quota_exhausted";
  resetAt?: number;
  ignorable: true;
}
```

联合 `SessionEvent` 加 `| RouteChangedEvent`，`KNOWN_EVENT_TYPES_MAP` 加 `route_changed: true`。

- [ ] **Step 4: `engine.ts`**

`this.append({... type: "assistant_message" ...})` 里加一行：

```ts
        ...(reply.route ? { route: reply.route } : {}), // 钱从谁账上出（ADR-0176 决定五）
```

- [ ] **Step 5: `agent.ts`**

opts 加（放在 `attachments` 后面）：

```ts
  /** 托管额度（订阅制，ADR-0176）。index.ts 注入；子会话/测试不给 = 路由永远不出 hosted */
  hosted?: { quota: HostedQuota; edgeBaseUrl: () => string; accessToken: () => Promise<string | null> };
```

`resolveEndpoint` 改成：

```ts
  let lastRoute: "hosted" | "direct" = "direct";
  const resolveEndpoint = async (choice: ModelChoice): Promise<ResolvedEndpoint> => {
    const h = opts.hosted;
    const route = routeModel({
      choice,
      ownKey: process.env[choice.apiKeyEnv] ?? "",
      ownBaseUrl: process.env[choice.baseUrlEnv],
      lane,
      ...(h ? {
        hosted: h.quota.routeInput(choice.model),
        hostedBaseUrl: `${h.edgeBaseUrl()}/llm/v1`,
        ...(await h.accessToken().then((t) => (t ? { hostedToken: t } : {}))),
      } : {}),
    });
    if (route.kind === "blocked") throw new Error(route.reason);
    lastRoute = route.kind;
    return route.kind === "hosted"
      ? { baseUrl: route.baseUrl, apiKey: route.apiKey, route: "hosted" }
      : { baseUrl: route.baseUrl, apiKey: route.apiKey, route: "direct" };
  };
```

`makeAdapter` 的 `createOpenAICompatibleAdapter({...})` 加：

```ts
      onResponse: ({ route, headers }) => { if (route === "hosted") opts.hosted?.quota.noteHeaders(headers); },
      onReroute: (info) => {
        opts.hosted?.quota.noteExhausted(info);
        // 改道是钱的事实变化，落日志（ignorable）；UI 据它提示一次
        store.append({
          sessionId, ts: Date.now(), type: "route_changed", ignorable: true,
          from: lastRoute, to: process.env[choice.apiKeyEnv] ? "direct" : "hosted",
          reason: "quota_exhausted", ...(info.resetAt !== undefined ? { resetAt: info.resetAt } : {}),
        });
      },
```

（`sessionId` / `store` 在 `createAgent` 作用域里已有——对照 `agent.ts:373` 那几处 `store.append` 的写法拿同样的变量名。）

- [ ] **Step 6: `index.ts` 装配**

在 `pxCloud` 装配旁边（`index.ts:1444` 附近）加：

```ts
  const hostedQuota = createHostedQuota({
    baseUrl: () => edgeBaseUrl(),
    accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null),
    log: (m) => console.warn(`[billing] ${m}`),
  });
  const hostedDeps = { quota: hostedQuota, edgeBaseUrl: () => edgeBaseUrl(), accessToken: () => accountManager?.getAccessToken() ?? Promise.resolve(null) };
```

两处 `createAgent({...})`（`:1863` 的探针装配**不加**；`:2120` 的真装配加 `hosted: hostedDeps`）。登录恢复成功的回调里（`accountManager` 的 `onChange` 或 `restore()` 之后，找 `pxAuditSync` / `escrowSync` 在登录时被叫醒的那一处）加 `void hostedQuota.refresh()`；登出处 `hostedQuota` 不用清（`refresh` 时 token 为 null 会自己清）。

- [ ] **Step 7: 跑测试 + 类型**

Run: `npx vitest run tests/main/modelRoute.test.ts tests/main/agent.test.ts tests/session && npx tsc --noEmit`
Expected: PASS。`tests/main/agent.test.ts` 若有对 `resolveEndpoint` 返回形状的精确断言（`toEqual({baseUrl, apiKey})`），改成 `toMatchObject`——多出的 `route` 字段是这次的产品改动，不是测试松动。

- [ ] **Step 8: 提交**

```bash
git add src/main/modelRoute.ts src/session/events.ts src/loop/engine.ts src/main/agent.ts src/main/index.ts tests/main/modelRoute.test.ts tests/main/agent.test.ts
git commit -m "feat(main): routeModel 多一条 hosted 出路，托管优先于自带 key；改道落 route_changed（#696，ADR-0176）

付费订阅下绕过用户买的东西去烧他自己的 key 才是意外，所以顺序与 ADR-0020 相反。
blocked 措辞分三种：无订阅无 key / 耗尽无 key 带恢复时间 / 网关不供此型号——
「为什么用不了」得是一句能指着代码念的话。改道那一刻落 route_changed：
钱从谁账上出变了，日志推不出来。"
```

---

### Task 11: IPC 三件 + 订阅页 + 改道提示

**Files:**
- Modify: `src/shared/shellBridge.ts:843` 附近（接口）与 `:1388` 附近（`CHANNELS`）
- Modify: `src/preload/index.ts:137` 附近
- Modify: `src/main/index.ts:3042` 附近（handler）
- Modify: `src/renderer/src/store.ts`（`billing` 状态 + 三个 action）
- Create: `src/renderer/src/components/BillingSettings.tsx`
- Modify: `src/renderer/src/App.tsx`（设置页挂载；找 `ModelProviderSettings` 那一页的壳 `:1310` 附近，在它上方加一节）
- Modify: 时间线里渲染 `route_changed`（找现有 ignorable 系统事件的渲染点：`grep -rn '"session_shared"' src/renderer/src`，照它的写法加一条）
- Test: `tests/renderer/billingSettings.test.tsx`（若 `tests/renderer/` 已有 `.test.tsx` 先例就照它；否则放 `tests/renderer/BillingSettings.test.tsx`，用 `@testing-library/react`——先 `grep -rn "testing-library" package.json` 确认已装；没装就只测纯逻辑 `src/renderer/src/lib/billingView.ts`）
- Create: `src/renderer/src/lib/billingView.ts`（纯逻辑：进度条百分比、倒计时文案、档位卡片数据）+ `tests/renderer/lib/billingView.test.ts`

**Interfaces:**
```ts
// shellBridge.ts
export interface BillingSnapshotView { me: BillingMe | null; fetchedAt: number; exhausted: { window: "5h" | "week"; resetAt: number } | null }
// ShellBridge 增：
  billingSnapshot(refresh: boolean): Promise<BillingSnapshotView>;   // refresh=true 先打 /me
  billingCheckout(target: { planId: PlanId } | { addon: true; quantity: number }): Promise<void>;  // 拿 url + shell.openExternal
  billingPortal(): Promise<void>;
// CHANNELS 增：billingSnapshot / billingCheckout / billingPortal（"otter:billingSnapshot" …）
// billingView.ts
export const PLAN_CARDS: ReadonlyArray<{ id: PlanId; name: string; priceUsd: number; blurb: string }>
export function windowPercent(w: WindowState): number             // 0..100，已用占比
export function countdown(resetAt: number, now: number): string   // "3 小时 47 分后恢复" / "已恢复"
export function addonLine(addon: BillingMe["addon"], now: number): string | null  // null = 没加购不显示
```

- [ ] **Step 1: `billingView.ts` 的测试与实现**

```ts
// tests/renderer/lib/billingView.test.ts
import { describe, expect, it } from "vitest";
import { addonLine, countdown, PLAN_CARDS, windowPercent } from "../../../src/renderer/src/lib/billingView.js";

describe("billingView", () => {
  it("三档卡片，价格 19/59/89", () => {
    expect(PLAN_CARDS.map((c) => [c.id, c.priceUsd])).toEqual([["lite", 19], ["pro", 59], ["max", 89]]);
  });
  it("windowPercent 钳在 0..100，limit 为 0 时 0", () => {
    expect(windowPercent({ usedMicro: 50, limitMicro: 200, resetAt: 0 })).toBe(25);
    expect(windowPercent({ usedMicro: 500, limitMicro: 200, resetAt: 0 })).toBe(100);
    expect(windowPercent({ usedMicro: 1, limitMicro: 0, resetAt: 0 })).toBe(0);
  });
  it("countdown：小时+分钟；不足一分钟说「不到 1 分钟」；过点说「已恢复」", () => {
    const now = 0;
    expect(countdown(now + 3 * 3_600_000 + 47 * 60_000, now)).toBe("3 小时 47 分后恢复");
    expect(countdown(now + 30_000, now)).toBe("不到 1 分钟后恢复");
    expect(countdown(now - 1, now)).toBe("已恢复");
  });
  it("addonLine：没余额回 null；有余额带到期日", () => {
    expect(addonLine({ remainingMicro: 0, expiresAt: null }, 0)).toBeNull();
    expect(addonLine({ remainingMicro: 70_000_000, expiresAt: Date.UTC(2027, 8, 2) }, 0)).toMatch(/7000 credit.*2027/);
  });
});
```

```ts
// src/renderer/src/lib/billingView.ts
// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { fmtCredit, type BillingMe, type PlanId, type WindowState } from "../../../shared/billing.js";

export const PLAN_CARDS: ReadonlyArray<{ id: PlanId; name: string; priceUsd: number; blurb: string }> = [
  { id: "lite", name: "Lite", priceUsd: 19, blurb: "日常对话与轻量编码" },
  { id: "pro", name: "Pro", priceUsd: 59, blurb: "整天开着水獭干活" },
  { id: "max", name: "Max", priceUsd: 89, blurb: "多只水獭并行、长会话" },
];

export function windowPercent(w: WindowState): number {
  if (w.limitMicro <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((w.usedMicro / w.limitMicro) * 100)));
}

export function countdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "已恢复";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "不到 1 分钟后恢复";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h} 小时 ${m} 分后恢复` : `${m} 分钟后恢复`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}
```

- [ ] **Step 2: IPC 三件**

`shellBridge.ts`：在 `providerBalances()` 后加三个方法 + `BillingSnapshotView` 类型（import `BillingMe`、`PlanId` from `./billing.js`）；`CHANNELS` 加三个键。`preload/index.ts`：

```ts
  billingSnapshot: (refresh) => ipcRenderer.invoke(CHANNELS.billingSnapshot, refresh),
  billingCheckout: (target) => ipcRenderer.invoke(CHANNELS.billingCheckout, target),
  billingPortal: () => ipcRenderer.invoke(CHANNELS.billingPortal),
```

`index.ts` 在 `providerBalances` handler 旁：

```ts
  ipcMain.handle(CHANNELS.billingSnapshot, async (_e, refresh: boolean) => {
    if (refresh) await hostedQuota.refresh();
    return hostedQuota.snapshot();
  });
  // 拿 url 后在系统浏览器里开：Stripe Checkout 是它自己的页面，不进 Electron 窗口
  ipcMain.handle(CHANNELS.billingCheckout, async (_e, target) => { await shell.openExternal(await hostedQuota.checkout(target)); });
  ipcMain.handle(CHANNELS.billingPortal, async () => { await shell.openExternal(await hostedQuota.portal()); });
```

主进程订阅 `hostedQuota.onChange` → `send("billingChanged", snapshot)`（照 `accountChanged` 那条推送的写法；`CHANNELS` 加 `billingChanged`，preload 加 `onBillingChanged(cb)`，`ShellBridge` 接口同步加）。

- [ ] **Step 3: store**

`store.ts` 状态加 `billing: BillingSnapshotView | null`（初值 `null`），action：

```ts
  async loadBilling(refresh = false) {
    try { set({ billing: await window.otter.billingSnapshot(refresh) }); } catch { /* 保留旧值 */ }
  },
  async billingCheckout(target) { await window.otter.billingCheckout(target); },
  async billingPortal() { await window.otter.billingPortal(); },
```

`boot()` 里订阅 `window.otter.onBillingChanged((s) => set({ billing: s }))`，并在登录态变化那一处（`accountChanged` 的处理里）调一次 `loadBilling(true)`。

- [ ] **Step 4: `BillingSettings.tsx`**

Tailwind + shadcn（`@/components/ui/button`、`card`、`progress`——先 `ls src/renderer/src/components/ui` 确认有哪些；没有 `progress` 就用一个 `div` 画条）。结构：

```tsx
export function BillingSettings() {
  const billing = useChat((s) => s.billing);
  const loadBilling = useChat((s) => s.loadBilling);
  const checkout = useChat((s) => s.billingCheckout);
  const portal = useChat((s) => s.billingPortal);
  useEffect(() => { void loadBilling(true); }, [loadBilling]);
  const now = Date.now();
  const me = billing?.me ?? null;

  if (!me || me.status === "none" || me.plan === null) {
    // 无订阅：三档卡片 + 一句「自带 key 免费档能力全开」
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-medium">订阅</h2>
        <p className="text-xs text-muted-foreground">订阅后模型调用走 Mr Otto 的 key，不用自己配。自带 key 的免费档能力全开。</p>
        <div className="grid grid-cols-3 gap-2">
          {PLAN_CARDS.map((c) => (
            <Card key={c.id} className="p-3 space-y-2">
              <div className="font-medium">{c.name}</div>
              <div className="text-lg">${c.priceUsd}<span className="text-xs text-muted-foreground">/月</span></div>
              <div className="text-xs text-muted-foreground">{c.blurb}</div>
              <Button size="sm" onClick={() => void checkout({ planId: c.id })}>订阅</Button>
            </Card>
          ))}
        </div>
      </section>
    );
  }
  // 有订阅：档位 + 两条进度条 + 倒计时 + 加购 + 管理
  const w = me.windows;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">订阅 · {PLAN_CARDS.find((c) => c.id === me.plan)?.name ?? me.plan}{me.status === "past_due" ? "（扣款失败）" : ""}</h2>
        <Button size="sm" variant="ghost" onClick={() => void portal()}>管理</Button>
      </div>
      {w && (["h5", "week"] as const).map((k) => (
        <div key={k} className="space-y-1">
          <div className="flex justify-between text-xs"><span>{k === "h5" ? "5 小时窗" : "本周"}</span><span className="text-muted-foreground">{fmtCredit(w[k].usedMicro)} / {fmtCredit(w[k].limitMicro)} · {countdown(w[k].resetAt, now)}</span></div>
          <div className="h-1.5 rounded bg-muted"><div className="h-1.5 rounded bg-foreground" style={{ width: `${windowPercent(w[k])}%` }} /></div>
        </div>
      ))}
      {billing?.exhausted && <p className="text-xs text-amber-600">额度已用完，{countdown(billing.exhausted.resetAt, now)}；配了自己的 key 会自动切过去。</p>}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{addonLine(me.addon, now) ?? "没有加购余额"}</span>
        <Button size="sm" variant="outline" onClick={() => void checkout({ addon: true, quantity: 1 })}>加购 $10</Button>
      </div>
      {me.plan !== "max" && (
        <div className="flex gap-2">{PLAN_CARDS.filter((c) => c.priceUsd > (PLAN_CARDS.find((x) => x.id === me.plan)?.priceUsd ?? 0)).map((c) => (
          <Button key={c.id} size="sm" variant="outline" onClick={() => void checkout({ planId: c.id })}>升到 {c.name}（${c.priceUsd}）</Button>
        ))}</div>
      )}
    </section>
  );
}
```

挂到 `App.tsx` 里「模型配置」页壳（`:1310` 附近）的 `<ModelProviderSettings />` 上方。

- [ ] **Step 5: 时间线上的改道提示**

`grep -rn '"session_shared"' src/renderer/src` 找到 ignorable 系统事件的渲染点，同一个 switch/映射里加 `route_changed`：一行灰字「订阅额度已用完，本次起用的是你自己的 key」（`to === "direct"` 时）；`resetAt` 有则追加 `countdown(resetAt, Date.now())`。

- [ ] **Step 6: 跑测试 + 类型 + 手验**

Run: `npx vitest run tests/renderer && npm run typecheck`
手验：`npm run dev`，设置页看到三档卡片；主进程 console 无 `[billing]` 报错（没登录时应静默）。

- [ ] **Step 7: 提交**

```bash
git add src/shared/shellBridge.ts src/preload/index.ts src/main/index.ts src/renderer/src/store.ts src/renderer/src/components/BillingSettings.tsx src/renderer/src/lib/billingView.ts src/renderer/src/App.tsx tests/renderer/
git commit -m "feat(ui): 订阅页（三档 / 两窗进度 / 倒计时 / 加购 / 管理）+ 改道提示（#696）

数字全从 /me 与响应头来，客户端不存价表不算 credit（ADR-0175 第 5 节）。
Checkout 在系统浏览器开：Stripe 的页面不进 Electron 窗口。"
```

---

### Task 12: 花费面板——hosted 段显示 credit，direct 段显示 \$

**Files:**
- Modify: `src/session/deriveUsage.ts`（`ModelUsage` 加 `route: "hosted" | "direct"`；`usageByModel` 按 `(model, route)` 归并）
- Modify: `src/renderer/src/components/CostPanel.tsx`（`route === "hosted"` 的行不算 `$`，写「credit」占位——本片客户端没有 credit 数；写「托管」标签 + token 数）
- Test: `tests/session/deriveUsage.test.ts`（找现有文件加一条；没有就新建）

> 为什么客户端不显示每次的 credit 数：网关响应头给的是**剩余**不是**本次**。本次消耗要么网关再加一个头，要么客户端存价表——后者被 ADR-0175 否了。本片先把两种来源分开画（决定五的硬要求），本次 credit 数留给下一片（加一个 `x-otto-cost-micro` 头即可）。

- [ ] **Step 1: 测试**

```ts
it("usageByModel：同一款型号走过两条路 → 两行，route 分开", () => {
  const rows = usageByModel([
    { seq: 1, sessionId: "s", ts: 0, type: "assistant_message", content: "", model: "m", usage: { promptTokens: 1, completionTokens: 1 }, route: "hosted" },
    { seq: 2, sessionId: "s", ts: 0, type: "assistant_message", content: "", model: "m", usage: { promptTokens: 2, completionTokens: 2 } },
  ] as SessionEvent[]);
  expect(rows.map((r) => [r.model, r.route, r.promptTokens])).toEqual([["m", "direct", 2], ["m", "hosted", 1]]);
});
```

- [ ] **Step 2: 实现**

`deriveUsage.ts`：`billed(e)` 返回值加 `route: e.type === "assistant_message" ? (e.route ?? "direct") : "direct"`；`usageByModel` 的 Map 键改 `` `${b.model}|${b.route}` ``，`ModelUsage` 加 `route`。排序不变（总量降序，同量按 model 再按 route）。

`CostPanel.tsx` 的 `money(u)`：`u.route === "hosted"` 时回 `"托管"`（不是 `$`，不是破折号——破折号表示「查不到价」，这里是「不按 $ 计」）；行首型号名后加一个小标签 `hosted`。

- [ ] **Step 3: 跑 + 提交**

```bash
npx vitest run tests/session && npm run typecheck
git add src/session/deriveUsage.ts src/renderer/src/components/CostPanel.tsx tests/session/
git commit -m "feat(ui): 花费面板按路分行——托管段不写 \$（#696，ADR-0176 决定五）

同一个位置同时出现「$X」和 credit 会被读成双重扣费。本次 credit 数留给下一片
（要网关多一个 x-otto-cost-micro 头），先把两种来源分开画。"
```

---

### Task 13: runtime 代表发起人走网关

**Files:**
- Create: `services/runtime/src/hostedRoute.ts`（纯：决策 + 网关 `/me` 客户端）
- Modify: `services/runtime/src/daemon.ts:209-233`（`adapterFor` 三步）
- Test: `tests/runtime/hostedRoute.test.ts`

**Interfaces:**
- Consumes：`ON_BEHALF_HEADER`、`WORKSPACE_HEADER`、`SESSION_HEADER`、`parseBillingMe`（Task 1）；`ResolvedEndpoint`（Task 8）
- Produces：
  ```ts
  export interface HostedRouteDeps { edgeBase: string; runtimeSecret: string; fetchImpl?: typeof fetch; now?: () => number }
  export interface HostedProbe { me(uid: string): Promise<BillingMe | null> }        // 60s/uid 缓存；失败回 null
  export function createHostedProbe(deps: HostedRouteDeps): HostedProbe
  export type RuntimeRoute =
    | { kind: "hosted"; endpoint: ResolvedEndpoint; model: string }
    | { kind: "workspace"; baseUrl: string; apiKey: string; model: string }
    | { kind: "blocked"; reason: string }
  export function decideRuntimeRoute(o: {
    me: BillingMe | null; requestedModel: string | null;                 // 工作区配的 modelId（没配 = null）
    workspace: { baseUrl: string; apiKey: string; modelId: string } | null;
    initiatorUid: string; workspaceId: string; sessionId: string; edgeBase: string; runtimeSecret: string;
  }): RuntimeRoute
  ```
- 决策（spec 第 5 节）：
  1. `me.status==="active" && me.plan` 且 `me.models` 含目标型号 → hosted。目标型号 = 工作区配的 `modelId` 若网关供它，否则 `me.models[0]`（云会话没有型号选单，先用网关第一款；工作区配了网关供的型号就尊重它）。endpoint：`baseUrl=${edgeBase}/llm/v1`、`apiKey=""`（不用 Bearer）、`headers={ "x-runtime-secret", [ON_BEHALF_HEADER]: initiatorUid, [WORKSPACE_HEADER], [SESSION_HEADER] }`、`route:"hosted"`。
  2. 否则工作区自带 key → `workspace`。
  3. 都没 → `blocked`，措辞：发起人没订阅 + 工作区没配 key，两条出路都说。

> adapter 发 `authorization: Bearer ${apiKey}`——apiKey 为空串时会发 `Bearer `。edge 的 `pxIdentify` 先看 `x-runtime-secret`，比中就不看 Authorization，所以空 Bearer 无害。

- [ ] **Step 1: 测试**

```ts
// tests/runtime/hostedRoute.test.ts
import { describe, expect, it, vi } from "vitest";
import { createHostedProbe, decideRuntimeRoute } from "../../services/runtime/src/hostedRoute.js";
import { ON_BEHALF_HEADER, type BillingMe } from "../../src/shared/billing.js";

const me: BillingMe = { plan: "pro", status: "active", windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: ["deepseek-v4-flash", "glm-5.3"] };
const base = { initiatorUid: "u1", workspaceId: "w1", sessionId: "s1", edgeBase: "https://edge", runtimeSecret: "rs" };
const ws = { baseUrl: "https://own/v1", apiKey: "sk", modelId: "glm-5.3" };

describe("decideRuntimeRoute", () => {
  it("发起人有订阅 → hosted，带平台身份 + on-behalf-of + workspace/session 头；型号尊重工作区配的（网关供的话）", () => {
    const r = decideRuntimeRoute({ me, requestedModel: "glm-5.3", workspace: ws, ...base });
    expect(r.kind).toBe("hosted");
    if (r.kind !== "hosted") return;
    expect(r.model).toBe("glm-5.3");
    expect(r.endpoint.baseUrl).toBe("https://edge/llm/v1");
    expect(r.endpoint.headers).toMatchObject({ "x-runtime-secret": "rs", [ON_BEHALF_HEADER]: "u1", "x-otto-workspace": "w1", "x-otto-session": "s1" });
    expect(r.endpoint.route).toBe("hosted");
  });
  it("工作区配的型号网关不供 → 用网关第一款", () => {
    const r = decideRuntimeRoute({ me, requestedModel: "gpt-9", workspace: ws, ...base });
    expect(r.kind === "hosted" && r.model).toBe("deepseek-v4-flash");
  });
  it("没订阅 + 工作区有 key → workspace 原路（ADR-0202）", () => {
    expect(decideRuntimeRoute({ me: null, requestedModel: "glm-5.3", workspace: ws, ...base })).toEqual({ kind: "workspace", baseUrl: "https://own/v1", apiKey: "sk", model: "glm-5.3" });
    expect(decideRuntimeRoute({ me: { ...me, status: "past_due" }, requestedModel: null, workspace: ws, ...base }).kind).toBe("workspace");
  });
  it("都没 → blocked，两条出路都说", () => {
    const r = decideRuntimeRoute({ me: null, requestedModel: null, workspace: null, ...base });
    expect(r.kind === "blocked" && r.reason).toMatch(/订阅/);
    expect(r.kind === "blocked" && r.reason).toMatch(/key/);
  });
});

describe("createHostedProbe", () => {
  it("带平台身份打 /me，60s 内同 uid 不再打；失败回 null 不抛", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => Response.json(me)) as unknown as typeof fetch;
    const p = createHostedProbe({ edgeBase: "https://edge", runtimeSecret: "rs", fetchImpl, now: () => now });
    expect(await p.me("u1")).toEqual(me);
    expect(await p.me("u1")).toEqual(me);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "x-runtime-secret": "rs", [ON_BEHALF_HEADER]: "u1" });
    now = 61_000;
    (fetchImpl as unknown as { mockResolvedValueOnce: (v: Response) => void }).mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await p.me("u1")).toBeNull();
  });
});
```

- [ ] **Step 2: 实现**

```ts
// services/runtime/src/hostedRoute.ts
// 云会话的模型路由（spec 第 5 节）：发起人有订阅 → 平台 key（扣发起人）；否则工作区自带 key
// （ADR-0202）；都没 → 一句人能看懂的错。runtime 仍然一把模型 key 都不拿：托管那条路的
// 凭据是平台身份 + 「我代表谁」，key 在 edge 那边。
import type { ResolvedEndpoint } from "../../../src/model/openaiCompatible.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, parseBillingMe, type BillingMe } from "../../../src/shared/billing.js";

export interface HostedRouteDeps { edgeBase: string; runtimeSecret: string; fetchImpl?: typeof fetch; now?: () => number }
export interface HostedProbe { me(uid: string): Promise<BillingMe | null> }

export function createHostedProbe(deps: HostedRouteDeps): HostedProbe {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { v: BillingMe | null; exp: number }>();
  return {
    async me(uid) {
      const hit = cache.get(uid);
      if (hit && hit.exp > now()) return hit.v;
      let v: BillingMe | null = null;
      try {
        const res = await doFetch(`${deps.edgeBase}/billing/v1/me`, { headers: { "x-runtime-secret": deps.runtimeSecret, [ON_BEHALF_HEADER]: uid } });
        v = res.ok ? parseBillingMe(await res.json()) : null;
      } catch { v = null; }
      // 失败也缓存 60s：一个坏掉的 edge 不该被每个 turn 打一次
      cache.set(uid, { v, exp: now() + 60_000 });
      return v;
    },
  };
}

export type RuntimeRoute =
  | { kind: "hosted"; endpoint: ResolvedEndpoint; model: string }
  | { kind: "workspace"; baseUrl: string; apiKey: string; model: string }
  | { kind: "blocked"; reason: string };

export function decideRuntimeRoute(o: {
  me: BillingMe | null; requestedModel: string | null;
  workspace: { baseUrl: string; apiKey: string; modelId: string } | null;
  initiatorUid: string; workspaceId: string; sessionId: string; edgeBase: string; runtimeSecret: string;
}): RuntimeRoute {
  const me = o.me;
  if (me && me.status === "active" && me.plan && me.models.length > 0) {
    const model = o.requestedModel && me.models.includes(o.requestedModel) ? o.requestedModel : me.models[0]!;
    return {
      kind: "hosted", model,
      endpoint: {
        baseUrl: `${o.edgeBase}/llm/v1`, apiKey: "", route: "hosted",
        headers: { "x-runtime-secret": o.runtimeSecret, [ON_BEHALF_HEADER]: o.initiatorUid, [WORKSPACE_HEADER]: o.workspaceId, [SESSION_HEADER]: o.sessionId },
      },
    };
  }
  if (o.workspace) return { kind: "workspace", baseUrl: o.workspace.baseUrl, apiKey: o.workspace.apiKey, model: o.workspace.modelId };
  return {
    kind: "blocked",
    reason: "这个 turn 没有可用的模型：发起人没有活跃订阅，工作区也没配自己的 API key。" +
      "两条路：发起人订阅 Mr Otto（桌面端设置 → 订阅），或工作区所有者在「仓库/模型」里填一把 key。",
  };
}
```

`daemon.ts` 的 `adapterFor(workspaceId)` 改成（`session` 由调用处传进来——看 `:427` 那行 `withUsage(adapterFor(workspaceId), …)`，把签名改成 `adapterFor(workspaceId, sessionId, initiatorUid: () => string | null)`）：

```ts
  const hostedProbe = createHostedProbe({ edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret });
  function adapterFor(workspaceId: string, sessionId: string, initiatorUid: () => string | null): ModelAdapter {
    const cfg = () => workspaceConfigStore.load(workspaceId)?.model ?? null;
    let lastModel = "(未配置)";
    return {
      get model(): string { return lastModel; },
      async chat(messages, tools, onDelta, signal) {
        const uid = initiatorUid() ?? "";
        const ws = cfg();
        const route = decideRuntimeRoute({
          me: uid ? await hostedProbe.me(uid) : null, requestedModel: ws?.modelId ?? null,
          workspace: ws ? { baseUrl: ws.baseUrl, apiKey: ws.apiKey, modelId: ws.modelId } : null,
          initiatorUid: uid, workspaceId, sessionId, edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret,
        });
        if (route.kind === "blocked") throw new Error(route.reason);
        lastModel = route.model;
        const adapter = route.kind === "hosted"
          ? createOpenAICompatibleAdapter({ baseUrl: route.endpoint.baseUrl, apiKey: "", resolveEndpoint: async () => route.endpoint, model: route.model })
          : createOpenAICompatibleAdapter({ baseUrl: route.baseUrl, apiKey: route.apiKey, model: route.model });
        return adapter.chat(messages, tools, onDelta, signal);
      },
    };
  }
```

`:427` 改成 `withUsage(adapterFor(workspaceId, sessionId, () => session.initiatorUid()), …)`。

- [ ] **Step 3: 跑 + 提交**

```bash
npx vitest run tests/runtime && npm run typecheck
git add services/runtime/src/hostedRoute.ts services/runtime/src/daemon.ts tests/runtime/hostedRoute.test.ts
git commit -m "feat(runtime): 云会话先看发起人的订阅，再看工作区 key（#696，spec 第 5 节）

扣发起人不扣 owner：谁说话谁付，和桌面端同一本账；成员烧不光 owner 的额度。
runtime 仍然一把模型 key 都不拿——托管那条路的凭据是平台身份 + 「我代表谁」。
/me 失败也缓存 60s：一个坏掉的 edge 不该被每个 turn 打一次。"
```

---

### Task 14: ADR、索引、术语、手验清单、交接

**Files:**
- Create: `docs/adr/0203-订阅制落地-网关在edge与QuotaDO.md`（编号在合并前重查 `ls docs/adr | tail -1`，撞了顺延 + 别名行，ADR-0074）
- Modify: `AGENTS.md`「Where to find things」加一条（L2，索引）
- Modify: `CONTEXT.md` 产品/技术术语加：托管模式 / BYOK / 5h 窗 / 周窗 / credit / hold / Quota DO
- Modify: `services/edge/README.md`（Task 7 已写）复核；`supabase/README.md`（Task 2 已写）复核
- 无代码

- [ ] **Step 1: 写 ADR**

内容（不重复 0174–0176）：

1. **网关落 edge Worker 不落 VPS**：已有 JWT / DO / service key / 自有域名；VPS 版是单区域且要重抄鉴权限流；DO 单线程正是 hold/settle 要的无竞态。推翻前提：Workers 对上游的出网被墙或 SSE 透传出现不可接受的延迟。
2. **固定窗用累计数不用环形桶**：ADR-0174 第 7 条写「环形桶」，第 3 条又定固定窗；固定窗一个数就够。推翻前提：改成滑动窗。
3. **Stripe 裸 REST + 手写验签**：同 ADR-0019 决定四的理由；订阅投影只认 `customer.subscription.*`（有 period），`checkout.session.completed` 在订阅模式下不写库。
4. **runtime 以平台身份代表发起人**：`x-runtime-secret` + `x-otto-on-behalf-of`，扣发起人不扣 owner；runtime 仍不持有模型 key（ADR-0202 精神延续）。推翻前提：产品决定群聊由 owner 统一付费。
5. **旧钱包不认、新账本另起**：维护者拍板；#520 继续作废（表留着不动）。
6. **档位改三档**（Lite/Pro/Max \$19/\$59/\$89），取代 ADR-0174 写的四档；折算规则不变。
7. **spec 与实现的两处偏差**：平台身份用既有 `x-runtime-secret` 而非 Bearer；本次 credit 数客户端不显示（要加 `x-otto-cost-micro` 头，留下一片）。

「会被推翻的前提」段落照仓库惯例写。

- [ ] **Step 2: AGENTS.md 索引加一条**

```
- `services/edge/src/llmGateway.ts` / `quota.ts` / `billing.ts` / `billingQueries.ts` / `src/shared/billing.ts` / `src/main/hostedQuota.ts` / `services/runtime/src/hostedRoute.ts` — 订阅制计费（ADR-0174/0175/0176 定形，ADR-0203 落地，#696）：网关在 edge Worker，一户一个 `Quota` DO 做**双固定窗**（5h + 周，累计数不是环形桶，惰性清零）的 hold/settle；`usage_event` 是钱的唯一事实、DO 是投影，冷启动从事实重建。三端共用 `src/shared/billing.ts`（同 wire.ts 的纪律）。桌面 `routeModel` 三条出路：hosted（订阅优先于自带 key）→ direct → blocked（措辞分三种）；网关 429 `quota_exhausted` 是 adapter 里单列的 `reroute` 类——不退避、立刻重解析端点一次，改道落 `route_changed`。runtime 以 `x-runtime-secret` + `x-otto-on-behalf-of` 代表 turn **发起人**调网关，仍不持有任何模型 key。Stripe 裸 REST，订阅投影只认 `customer.subscription.*`。部署四步 + 手验六条在 `services/edge/README.md`
```

- [ ] **Step 3: CONTEXT.md 术语**

在产品/技术术语段加：托管模式（hosted）、BYOK、5h 窗 / 周窗、credit（1 credit = 1 美分 = 10_000 micro-USD）、hold（预扣）、Quota DO、on-behalf-of。每条一行，引 ADR 编号。

- [ ] **Step 4: 门禁 + 推送 + PR**

```bash
npm test
git push -u origin claude/subscription-billing-69ce03
gh pr create --title "feat: 订阅制计费第一片——edge 网关 + Quota DO + Stripe + 桌面/runtime 接线（#696）" --body "$(cat <<'EOF'
实现 #696（spec `docs/superpowers/specs/2026-09-02-subscription-billing-design.md`，计划 `docs/superpowers/plans/2026-09-02-subscription-billing.md`）。

Task issue：#696（合并时关闭）
ADR：0203

**部署是维护者手上的活，代码合了不等于上线**（`services/edge/README.md` 部署四步）：
1. Supabase 跑 `0017` + seed；填三档 + addon 的 `stripe_price_id`
2. `wrangler secret put` × 4（DEEPSEEK_API_KEY / ZHIPU_API_KEY / STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET）
3. Stripe 后台建 webhook 指 `/billing/v1/webhook`
4. `wrangler deploy` → runtime 发版 → 桌面发版

Closes #696

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012hQSQAoYeiBAMKL5Yki1rh
EOF
)"
```

- [ ] **Step 5: 交接**

合并后：`npm run lane:prune -- --apply`；开交接 issue（Task 型，五段 Memory）：下一步 = 部署四步 + 手验六条、`x-otto-cost-micro` 头 + 客户端本次 credit 显示、粘性/比价/failover（ADR-0175 第 3 节）、多模态门禁。

---

## Self-review（写完后对照 spec 跑一遍）

- **Spec 覆盖**：§1 数据模型 → T2；§2 网关 + DO → T3/T4/T6/T7；§3 Stripe → T5/T7；§4 桌面 → T8/T9/T10/T11/T12；§5 runtime → T13；§6 错误码 → T4/T6（表里七条：bad_token/no_subscription/quota_exhausted/unknown_model/upstream/too_many_inflight/bad_request 全有落点）；§7 测试 → 每个 Task 自带 + T7 的 `checks/llm.mjs`；§8 部署 → T7 README + T14 PR 正文；§9 ADR → T14。
- **偏差两处已写进 T14 的 ADR**：平台身份头名、本次 credit 数不显示。
- **类型一致性**：`HoldOutcome`（T4）与 `HoldResult`（T3）形状对齐（DO 在 T7 里把 `HoldResult` 的 `state` 剥掉再回）；`Caller` 在 T4/T6/T7 同名同形；`BillingMe` 在 T1/T7/T9/T13 同一份 import；`ResolvedEndpoint.route` 在 T8/T10/T13 一致；`RerouteInfo` 在 T8/T9/T10 一致。
