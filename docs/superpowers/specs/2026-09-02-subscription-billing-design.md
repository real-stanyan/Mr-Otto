# 订阅制计费落地设计（第一片）

- 日期：2026-09-02
- Task issue：#696（交接 #700 已读并关闭）
- 上游决定：ADR-0174（双固定窗 / credit = micro-USD）、ADR-0175（模型与路由两层）、
  ADR-0176（托管优先于自带 key，自带 key 不过网关）。本文不复述那三份的理由，只写落地形状。
- 维护者会话拍板（2026-09-02）：
  - 第一片包含 Stripe（订阅 + 加购），不拆。
  - 四档照 ADR-0174（Lite \$19 / Pro \$59 / Max5 \$149 / Max20 \$299）。
  - 云会话（VPS runtime）一起做；一个 turn 的额度**扣发起这个 turn 的人**。
  - 旧 `token_*` 三张表与 4 个用户的余额：**不动也不认**，新账本另起；#520 继续作废。
  - Stripe Product / Price 由维护者在后台建，代码只认 `price_id`。

## 0. 范围

**做**：edge Worker 上的 LLM 网关 + `Quota` DO 双窗计量 + Stripe 订阅/加购入账 +
桌面端 hosted 路由与订阅页 + runtime 代表调用。首批上游：DeepSeek、智谱 GLM。

**不做**（字段留位，实现不做）：粘性 / 比价 / failover 选路、多模态能力门禁、视频秒池、
单次预算闸、价表定时核对、六站余额告警。

## 1. 数据模型（`supabase/migrations/0017_subscriptions.sql`）

旧 `token_ledger` / `token_wallets` / `token_balances` 不动不认。新五张：

```
plan                 -- 档位字典，DB 行不是代码常量
  id text pk         -- 'lite' | 'pro' | 'max5' | 'max20'
  price_usd_cents int
  monthly_budget_micro bigint        -- 售价 × 70% 折成的月成本预算（micro-USD）
  week_limit_micro bigint            -- monthly_budget ÷ 4，算好落行
  window5h_limit_micro bigint        -- week_limit × 0.2，算好落行
  capabilities jsonb                 -- {"image":false,"video":false}，本片只留字段
  stripe_price_id text

subscription         -- 一人一行投影；Stripe webhook 是唯一写入者
  user_id uuid pk references auth.users
  plan_id text references plan
  status text  ('active'|'past_due'|'canceled')
  stripe_customer_id text, stripe_subscription_id text
  current_period_start timestamptz, current_period_end timestamptz   -- 周窗锚定日
  updated_at timestamptz

credit_grant         -- 加购，append-only
  id bigint identity pk, user_id uuid, micro_usd bigint
  expires_at timestamptz             -- 入账 + 12 个月
  stripe_payment_intent_id text unique   -- 幂等键
  created_at timestamptz
  -- 余额 = sum(micro_usd) - sum(usage_event.cost_micro where charged_to='addon')，只算未过期的 grant

usage_event          -- 唯一事实（ADR-0174 第 7 条）；网关 settle 后写、只增
  id bigint identity pk, user_id uuid
  request_id text unique             -- 幂等键，DO 重试 settle 不记两笔
  source text ('desktop'|'runtime')
  workspace_id text default '', session_id text default ''
  logical_model text, route_id text
  prompt_tokens int, cached_tokens int, completion_tokens int
  cost_micro bigint
  charged_to text ('window'|'addon')
  created_at timestamptz

model_route          -- ADR-0175 第 2 节；首批 seed DeepSeek + GLM
  id text pk, logical_model text, platform text ('deepseek'|'zhipu')
  base_url text, wire_model text
  price_in_micro_per_m bigint, price_cache_micro_per_m bigint, price_out_micro_per_m bigint  -- 已折 USD
  quantization text default 'none', priority int, enabled bool
  effective_from timestamptz, effective_to timestamptz null
```

约束：

- RLS：本人只读 `subscription` / `credit_grant` / `usage_event` 自己的行；`plan` / `model_route`
  全员可读；**全部无写策略**。写入只走 service key（Worker）。同 0002 的规矩。
- 窗口计数器**不落 DB**：活在 `Quota` DO storage 的环形桶里，冷启动或对不上从 `usage_event`
  重建（一次范围查询，不是每请求扫表）。加购余额同样在 DO 里做投影，webhook 入账时 RPC 通知 DO。
- CNY 计价的上游在 seed 时折成 micro-USD 落行；折算汇率写在 seed 文件头注，抄表日期比价格重要。

## 2. 网关请求流 + `Quota` DO

端点（挂在现有 edge Worker；`edge.ts` 纯路由、`worker.ts` 装配）：

```
POST /llm/v1/chat/completions   -- OpenAI 方言，客户端 adapter 一字不改
GET  /billing/v1/me              -- 档位 + 两窗 used/limit/resetAt + 加购余额/到期
POST /billing/v1/checkout        -- {planId} 或 {addon:true, quantity} → Stripe Checkout url
POST /billing/v1/portal          -- Stripe 客户门户 url
POST /billing/v1/webhook         -- Stripe → 我们
```

鉴权两种身份，同一段代码：

- 桌面：`Authorization: Bearer <Supabase JWT>` → `verifyJwt` 取 `sub`。
- runtime：`Bearer <RUNTIME_SECRET>` + `x-otto-on-behalf-of: <uid>`。平台身份可代表任意 uid；
  **只有它能带这个头**，桌面 JWT 带了直接 400。

一次 chat 的顺序（`services/edge/src/llmGateway.ts`，纯函数，注入 fetch / quota / routes / clock）：

1. 解析 body：`model`（逻辑 id）、`stream`、`max_tokens`。不认识的逻辑 id → 400 `unknown_model`。
2. 选路：`model_route` 里 `enabled` 且 `quantization='none'` 的按 `priority` 取第一条。
   粘性 / 比价 / failover 留函数签名，实现留 TODO 注释指向 ADR-0175 第 3 节。
3. **hold**：估算 = `prompt_est × price_in + max_tokens × price_out`；`prompt_est` = body 字节数 ÷ 3
   （宁高勿低，结算退差）。`max_tokens` 缺省时按 route 的默认上限估。调 `Quota.hold(requestId, estimate)`。
4. 转发上游：`model` 换 `wire_model`，加该平台 key 的 `Authorization`，强制
   `stream_options.include_usage = true`。**SSE 原样透传**给客户端；旁路一个 `TransformStream`
   只挑末尾 `usage` 块（含 `prompt_cache_hit_tokens` 一类的 cache 字段，按平台解析）。
5. **settle**：流结束或非流响应回来 → `cost = in×pi + cached×pc + out×po`（cached 从 in 里扣）
   → `Quota.settle(requestId, cost)` → 写 `usage_event`。上游 4xx/5xx、客户端中断、流未见 usage
   → `Quota.release(requestId)`，不记账。
6. 响应头：`x-otto-window-5h-remaining` / `x-otto-window-week-remaining` / `x-otto-addon-remaining`
   （micro-USD）+ `x-otto-plan`。客户端不用再问一次就能刷 UI。

`Quota` DO（`getByName(uid)`，storage 里五样东西）：

```
buckets5h[60]   -- 5 分钟一格，环形；open5hAt = 本窗第一次 hold 的时刻
bucketsWk[168]  -- 1 小时一格；锚定 subscription.current_period_start，按 7 天切段
holds           -- Map<requestId, {micro, at, chargedTo}>；10 分钟没 settle 自动 release
addonMicro      -- 加购余额投影
plan            -- {planId, limits, periodStart, status}，TTL 60s，过期回 DB 读一次
```

准入判定，顺序固定：

```
无 plan 快照 / status != 'active'                         → 402 no_subscription
sum5h + holds5h + est > limit5h  或  sumWk + holdsWk + est > limitWk
  → addonMicro - holdsAddon >= est  → hold 记到 addon（charged_to='addon'，不进窗）
  → 否则                             → 429 quota_exhausted { window:'5h'|'week', resetAt }
否则                                                        → hold 记到 window
inflight holds 数 > 4                                       → 429 too_many_inflight（在最前面判）
```

固定窗：5h 窗 `open5hAt + 5h` 到点整窗清零；周窗 `periodStart + 7d × n` 切段。**全部惰性判定**，
不用 alarm，DO 睡着不花钱。

上游 key：`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` 两个 wrangler secret，`model_route.platform` 决定用哪个。
key 永远只在 Worker env。

## 3. Stripe

不装 SDK：裸 fetch Stripe REST（form-encoded）+ 手写 webhook 验签（HMAC-SHA256，
`Stripe-Signature` 的 `t=` / `v1=`，5 分钟容差，定长比较前先比长度）。理由同 ADR-0019 决定四。

secret：`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`。四个订阅 `price_id` + 加购 `price_id`
落 `plan` 表（加购那条用 id `'addon'` 的行，`week_limit_micro` 等为 0）。

订阅购买：

```
桌面 → POST /billing/v1/checkout {planId}
  → Worker 建 Checkout Session（mode=subscription，client_reference_id=uid，
    customer 复用 subscription.stripe_customer_id 若有，success/cancel 回落地页）
  → 回 url → 桌面 shell.openExternal
```

加购：同端点 `{addon:true, quantity}`，`mode=payment`，metadata 带 uid。

webhook 只认五个事件，其余 200 忽略：

| 事件 | 动作 |
|---|---|
| `checkout.session.completed`（subscription） | upsert `subscription`（uid 从 `client_reference_id`），status=active |
| `checkout.session.completed`（payment） | insert `credit_grant`（`payment_intent` 唯一键 → 幂等），RPC `Quota.addonGranted` |
| `customer.subscription.updated` | 改 plan / period / status（升降档、续期） |
| `customer.subscription.deleted` | status=canceled |
| `invoice.payment_failed` | status=past_due → 网关 402 |

`subscription` 一人一行 upsert，每次 webhook 都把 Stripe 那份当真（Stripe 是订阅状态的事实来源，
我们的表是投影）。处理完 RPC `Quota.planChanged(uid)` 让 DO 立刻丢掉 60s 缓存。

退订走 Stripe 客户门户；`cancel_at_period_end`，期末才失效。
周窗锚定 `current_period_start`；升档时 Stripe 开新 period → 周窗跟着重开。

## 4. 桌面端

路由（`src/main/modelRoute.ts` 仍是唯一判断处，ADR-0176 决定二顺序）：

```ts
type ModelRoute =
  | { kind: "hosted"; baseUrl: string; apiKey: string }   // baseUrl = edge + "/llm/v1"，apiKey = JWT
  | { kind: "direct"; baseUrl: string; apiKey: string }
  | { kind: "blocked"; reason: string };

RouteInput += { hosted?: { subscribed: boolean; exhausted: boolean; supportsModel: boolean; resetAt?: number } }

subscribed && !exhausted && supportsModel → hosted
ownKey / keyless                        → direct
否则                                     → blocked（三种措辞：无订阅无 key / 耗尽无 key + 倒计时 / 网关不供此型号）
```

`hosted` 输入来自主进程新增 `src/main/hostedQuota.ts`：内存快照 `{plan, windows, addon, fetchedAt}`，
三个更新源——启动与设置页打开时 `GET /billing/v1/me`、每次网关响应头、429 body。
JWT 从 `account.getSession()` 现取（`resolveEndpoint` 每请求跑一次，ADR-0020 决定二原样保留）。

耗尽时的改道：网关 429 `quota_exhausted` 在 `src/model/errorClass.ts` 单列一类 `reroute`
（不进 #283 的退避重试）。adapter 收到 → 快照 `exhausted=true` → 立刻重跑一次 `resolveEndpoint`：
有自己 key 变 direct，日志追一条 `route_changed { from:'hosted', to:'direct', reason:'quota_exhausted' }`
（ignorable）；没 key 抛错带倒计时。首 token 后的 429 不会发生（hold 在前）。

`assistant_message` 事件新增可选字段 `route?: 'hosted' | 'direct'`（旧日志缺省 = direct，向后兼容）。

UI 三处：

1. 设置 → 订阅页（新）：档位、两条进度条 + 「N 小时后恢复」、加购余额与到期、按钮：订阅/升档、加购、管理。
   无订阅 = 四档卡片。
2. 浮层花费面板 + 页脚（ADR-0176 决定五）：hosted 段显示「消耗 X credit」，direct 段显示「\$X」，并列不混。
3. 运行指示条：耗尽落 direct 那一刻 toast 一次。

`ShellBridge` 加 `billing.snapshot()` / `billing.checkout(target)` / `billing.portal()`；渲染进程不碰网络。
客户端不存价表、不算 credit——数字全从响应头 / `/me` 来。

## 5. runtime

`services/runtime/src/daemon.ts` 的 `adapterFor`，每次 `chat()`：

1. `initiator = session.initiatorUid()`；问网关 `GET /billing/v1/me`（RUNTIME_SECRET + on-behalf-of，
   缓存 60s/uid）→ subscribed 且未耗尽 → hosted：`baseUrl = edge + /llm/v1`，`apiKey = RUNTIME_SECRET`，
   `headers` 带 `x-otto-on-behalf-of` / `x-otto-workspace` / `x-otto-session`（进 `usage_event.source='runtime'`）。
2. 否则工作区自带 key → 直连（ADR-0202 原路）。
3. 都没 → throw 人能看懂的错（现有「还没配模型」那条路径）。

`createOpenAICompatibleAdapter` 已有 `headers` 口子，adapter 不改。现有 `model_usage` 事件 +
`usage_ledger` 镜像写照旧：那是会话日志的事实，`usage_event` 是钱的事实。hosted 途中 429 不改道，
turn 失败落日志，文案带倒计时。

## 6. 错误码

| 情形 | 码 | 客户端动作 |
|---|---|---|
| JWT 无效/过期 | 401 `bad_token` | 刷 session 重试一次 |
| 无订阅 / past_due | 402 `no_subscription` | blocked，带 checkout 入口 |
| 窗口耗尽且无加购 | 429 `quota_exhausted` + `resetAt` | 改道或倒计时 |
| 不认识的逻辑 id | 400 `unknown_model` | blocked |
| 上游 5xx/超时 | 502 `upstream` | release hold；#283 退避 |
| 单 uid 并发 > 4 | 429 `too_many_inflight` | 退避重试 |
| on-behalf-of 非平台身份 | 400 `bad_request` | — |

## 7. 测试（根门禁，镜像 `tests/edge/`）

- `quota.test.ts`：环形桶推进 / 固定窗到点清零 / 周窗锚定 / hold-settle-release / hold 超时自动 release /
  加购垫底且不进窗 / 从 `usage_event` 重建。纯逻辑，DO 只是壳。
- `llmGateway.test.ts`：注入 fetch 打 `Request`：两种身份 / on-behalf-of 越权 / SSE 透传且 usage 被挑出 /
  上游失败 release / 流没 usage 也 release / 响应头。
- `billing.test.ts`：验签三个坑（时间戳过期、v1 不匹配、长度不同）+ 五事件解析 + 无关事件忽略。
- `tests/main/modelRoute.test.ts` 扩：新顺序 + 三种 blocked 措辞。
- `services/edge/checks/llm.mjs`：真 workerd 打一次（假上游），同 `relay.mjs`。

## 8. 部署顺序（写进 `services/edge/README.md`，全是维护者手上的活）

1. Supabase 跑 `0017`（Management API，同 0012）+ seed `plan` / `model_route`（seed 文件 `supabase/seed/0017_plans_routes.sql`）。
2. `wrangler secret put` × 4：`DEEPSEEK_API_KEY` `ZHIPU_API_KEY` `STRIPE_SECRET_KEY` `STRIPE_WEBHOOK_SECRET`；
   `wrangler.jsonc` 加 `QUOTA` binding + migration `v3`。
3. Stripe 后台建 webhook 指 `https://edge.mrotto.agency/billing/v1/webhook`，选第 3 节那五个事件。
4. `wrangler deploy` → runtime 发版 → 桌面发版。顺序不能反：老桌面打新网关只是 404 一条没人调的路由。

## 9. ADR

新 ADR 记本次五条非默认选择：网关落 edge Worker 而非 VPS；Stripe 裸 REST 不装 SDK；
runtime 以平台身份代表 uid 调网关（仍不持模型 key）；云会话扣发起人；旧钱包不认、新账本另起。
不重复 0174–0176 已写的。
