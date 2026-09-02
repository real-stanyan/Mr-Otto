# otto-edge

Mr Otto 的边缘服务。三件事，互不相干：**OAuth 落地页**、**远程中继**、
**托管模型网关 + 计费面**。

```
浏览器（OAuth 回调）──> /auth/landing ──页内 JS──> mrotto://auth-callback

桌面 ──┐                              ┌── 手机
       └──> /rl/v1/connect (WS) <────┘     （盲管道，密文互转）
                    │
              Durable Object：一户一个实例，闲时休眠

桌面/云 runtime ──> /llm/v1/chat/completions ──> Quota DO（预扣）──> 上游模型
                                                   │
                    /billing/v1/*  <── Stripe webhook ──> Supabase（usage_event = 钱的事实）
```

> **它曾经是 otto-gateway**（`services/gateway/`）——拿官方 DeepSeek key 代理模型调用、
> 按 token 桶扣额度（ADR-0019 / 0021）。ADR-0085 关掉了那条产品线，ADR-0129 删掉了它的
> 实现，连同数据库里的钱包表。删完之后这个服务不再 gate 任何东西，所以改名 edge。
> 历史细节看那三份 ADR，不在这里复述。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针，不要令牌 |
| GET | `/auth/landing` | OAuth 落地页。不要令牌，浏览器裸访问，回 HTML |
| GET | `/rl/v1/connect?role=desktop\|mobile` | 中继。WebSocket upgrade，上下行同一条。`101` 接上，`400` role 不合法，`401` 凭据问题，`404` 未开中继，`426` 不是 upgrade 请求 |
| POST | `/llm/v1/chat/completions` | 托管模型网关（OpenAI 兼容，流式/非流式都收）。`200` 正常（响应头带剩余额度），`400` `bad_request`/`unknown_model`，`401` 凭据问题，`402` `no_subscription`，`429` `quota_exhausted`（带 `window`/`resetAt`）或 `too_many_inflight`，`502` `upstream` |
| GET | `/billing/v1/me` | 这个人的档位 / 两个窗口 / 加购余额 / 网关此刻供的型号（`BillingMe`）。`200` |
| POST | `/billing/v1/checkout` | 开一张 Stripe Checkout：`{planId}` 订阅或 `{addon:true,quantity}` 加购。`200 {url}`，`400` 形状不对，`403` `forbidden`（平台身份不能买），`502` Stripe 那边出错 |
| POST | `/billing/v1/portal` | 开一张 Stripe Billing Portal（改卡/退订）。`200 {url}`，`502`（含"还没有订阅记录"） |
| POST | `/billing/v1/webhook` | Stripe → 我们。不验 JWT，验 `Stripe-Signature`。`200` 收下或显式忽略，`400` 签名/JSON 不对，`413` 正文过大，`500` 落库失败（让 Stripe 重投） |
| GET | `/billing/v1/done?ok=0\|1` | 付款完成/取消后浏览器落的那一页。不要令牌，回 HTML |

**凭据走子协议**：客户端发 `Sec-WebSocket-Protocol: mrotto.v1, <Supabase JWT>`，服务端只
echo 回 `mrotto.v1`。标准 `WebSocket` 构造函数带不了自定义头，而放 query 参数等于把
access token 写进各层访问日志和 Referer。落地页不要凭据。

验签在**门口**（`edge.ts`）做完，转给 DO 的请求里没有 token —— DO 只需要知道 role。

## 落地页为什么要存在

OAuth 的 `redirect_to` 直接填 `mrotto://` 深链时，浏览器把深链丢给系统后**标签页原地
不动**——用户盯着 Google 的账号选择页以为卡住了，其实 app 已经登录成功。落地页给浏览器
一个明确的终点：显示结果 + JS 转发 code。

`code` 只在 URL query 里过一手，页面不存不发；换 token 发生在 app 内（PKCE，code 单独
没有 verifier 换不出任何东西）。深链前缀与 `src/main/account.ts` 的 `parseAuthCallback`
必须一致。

## 中继的三条不变量

`/rl/v1/*` 是**盲管道**。负载是端到端加密的密文，它只按 `user_id` 把桌面那一端和手机
那一端的字节互转：

1. **不解析负载** —— 密文对它就该是不透明字节
2. **不落盘** —— 会话内容一个字节都不进库
3. **不打印负载** —— `tests/edge/relay.test.ts` 有一条测试专门钉这个，因为
   「调试时顺手 console.log 一下」是这类系统最常见的泄漏方式

一户一桌面一手机，同角色重连顶掉旧的。**信任多台、同时连一台**的取舍见 ADR-0128；
要真正同时在线见 issue #530。

控制信道（`:peer` 在场信号、`:ping`/`:pong` 心跳）靠 `:` 前缀与载荷分开：载荷是 base64url，
字母表 `A-Za-z0-9-_` 里没有冒号，所以一个字节的前缀就够，中继依旧不碰内容。约定在
`src/shared/remote/wire.ts`，**三方共用一份**。

心跳由 `setWebSocketAutoResponse` 在**边缘**直接应答，**不唤醒 DO** —— 既探得出半开连接
（iOS 切后台掐 socket 而 WebSocket 未必立刻 onclose），又不产生计费时长。

## 部署

```bash
npm --prefix services/edge run deploy       # wrangler deploy
npx wrangler secret put SUPABASE_JWT_SECRET # 只做一次，值不进 git
```

`wrangler.jsonc` 里 `compatibility_date` 定住运行时行为，**别顺手往上抬** —— 抬它等于换一批默认值。

`SUPABASE_JWT_SECRET` 是 Dashboard → Settings → API → JWT Settings 里的 legacy JWT secret
（`src/jwt.ts` 只认 HS256，所以项目的签名 key 必须停在 legacy HS256 那把）。

本地开发：`npm --prefix services/edge install` 一次（装 wrangler），然后
`npm --prefix services/edge run dev` 起 `wrangler dev`（真 workerd + 真 DO），
假 secret 放 `services/edge/.dev.vars`（已 gitignore）。

> **`@cloudflare/workers-types` 装在根**，不在这个目录：`npm test` 里那条
> `tsc -p services/edge` 属于门禁，而门禁必须是「clone 完 `npm ci` + `npm test`」
> 一条路走完。装在这里的话 CI 只在根 `npm ci` 就找不到它（实测 TS2688）。
> wrangler 留在这里是因为它只在部署和本地 dev 用，不进门禁。

### 运行时那一层怎么验

单测跑的是纯逻辑 + 一个照着 `worker.ts` 写的假 DO，**覆盖不到** `acceptWebSocket` 的休眠
语义、tag 存取、101 响应形状、子协议 echo。那几件事坏掉的样子是"连上了但什么都不发生"，
没有报错。所以：

```bash
# 打生产：要真 secret（脚本要现签一个 120 秒的 token）
SUPABASE_JWT_SECRET='...' npm --prefix services/edge run check:relay

# 打本地 wrangler dev：secret 自动从 .dev.vars 取（假值，两边一致就够）
npm --prefix services/edge run check:relay http://127.0.0.1:8799
```

生产地址是 `https://mrotto-edge.dryrun-agency.workers.dev`（脚本的默认值）。

拿 `.dev.vars` 里的假 secret 打生产会被脚本**直接拦掉**：那样跑，中继那些断言会
全部 401，看起来像"服务坏了"，实际是签的 token 对不上——这是这个脚本最容易
骗到人的一种失败。

17 条端到端断言（配对、互转、顶替、心跳、隔离、帧上限）。**不进门禁**（它要网络和 secret），
改中继的 PR 贴它的结果。

## 托管网关与计费

订阅制（ADR-0174 / 0175 / 0176，spec 2026-09-02）。用户买档位，网关拿**我们的** key
打上游，按 token 记账；BYOK 那条路一点没变，这是并行的第二条。

**身份有两种**，都在 `edge.ts` 的 `callerOf` 收口：

- 真人：`Authorization: Bearer <Supabase JWT>`，`uid` 就是 JWT 的 `sub`；带
  `x-otto-on-behalf-of` 一律 **400**（能代表别人的只有平台）
- 平台（VPS 上的云 runtime）：`x-runtime-secret: <RUNTIME_SECRET>` +
  **必须**带 `x-otto-on-behalf-of: <真用户 uid>`（它没有自己的 `sub`，替谁花钱要说清楚）

另两个可选头 `x-otto-workspace` / `x-otto-session` 只进 `usage_event` 的行，
在身份出口截到 128 字节。

**hold / settle**（为什么不是"用完再算"）：并发请求能在"算账"之前一起冲进窗口。
所以一次调用是「按请求体字节 + `max_tokens` **高估**一笔 → 预扣（hold）→ 转发 →
从响应/SSE 流里挑 `usage` → 按实际成本结算（settle），退掉估算与实际的差」。
流式响应的 settle 发生在**响应已经发出之后**，靠 `ctx.waitUntil` 活着；上游失败、
流中断、客户端断线三条路都走 `release`（不记账）。

**Quota DO 存的是投影，不是事实**：钱的唯一事实是 Supabase 的 `usage_event` 表
（append-only，见 `0017_subscriptions.sql`）。DO 冷启动没有 state 时**从事实重建**
——不重建的话，DO 睡一觉醒来额度就全满了。重建失败**不落盘**（落一份空的等于把
"这次查不到"冻成"这个人没花过钱"），下一次操作自己重试。

`usage_event` 落库失败**不回滚投影**：少扣对用户有利，回滚才会把"已经给出去的内容"
变成既没扣钱也没记录。

**加购 webhook 先查再插**：幂等键是 `stripe_payment_intent_id`（DB 里 unique）。
光靠 `ignore-duplicates` 分不出"新的一笔"和"重投"，而重投一次通知一次 DO = 多发一份额度。

**四个 secret**（另外两个是中继那边的 `SUPABASE_JWT_SECRET` / `RUNTIME_SECRET`）：

```bash
npx wrangler secret put DEEPSEEK_API_KEY      # 上游模型 key
npx wrangler secret put ZHIPU_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY     # sk_live_… / sk_test_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET # whsec_…
```

没配某个平台的 key，那条路由回 `502 upstream`「服务端没配 … 的 key」——不是静默降级。
没配 Stripe，`checkout` / `portal` 回「服务端没配 Stripe」，`/me` 照常。

## 部署与手验（订阅制）

四步，顺序不能换（表要先在，DO 才有东西可读；secret 要先在，webhook 才验得动）：

```bash
# ① DB：在 Supabase SQL editor 跑一次（重复执行安全）
#    supabase/migrations/0017_subscriptions.sql
#    然后在 plan 表手填 stripe_price_id（seed 故意不覆盖这一列）

# ② secret：上面那四个 + 已有的两个，一个都不写进 wrangler.jsonc
npx wrangler secret put STRIPE_SECRET_KEY   # …等四条

# ③ 部署（migration v3 会新建 Quota 这个 DO class）
npm --prefix services/edge run deploy

# ④ Stripe Dashboard → Developers → Webhooks 加一个端点：
#    https://edge.mrotto.agency/billing/v1/webhook
#    事件选：customer.subscription.created / .updated / .deleted /
#            invoice.payment_failed / checkout.session.completed
```

**手验六条**（前两条不花钱，第三条起会真扣额度）：

1. **没订阅的人**：`npm --prefix services/edge run check:llm`（默认签一个随机 uuid）。
   `/billing/v1/me` 应回 `status: "none"` 且 `models` 非空（`models` 空 = `model_route`
   没 seed 过），一次 chat 应得 **402 `no_subscription`** 且带剩余额度头。
2. **手工造一行订阅**：在 `subscription` 表插一行（`user_id` 用你的测试账号、
   `plan_id='lite'`、`status='active'`、`current_period_start/end` 覆盖此刻），
   再打 `/billing/v1/me` —— `windows` 应该从 `null` 变成两个窗口，`periodEnd` 有值。
3. **真扣一笔**：`OTTO_CHECK_UID=<那个 uid> SUPABASE_JWT_SECRET='…' npm --prefix services/edge run check:llm`。
   脚本自己会等一拍再打一次 `/me` 断言 `windows.h5.usedMicro > 0`；同时去
   `usage_event` 表看应该多一行（`request_id` 唯一），响应头里的剩余额度比第 2 步小。
4. **webhook 通路**：`stripe listen --forward-to http://127.0.0.1:8799/billing/v1/webhook`
   配 `npm --prefix services/edge run dev`，然后 `stripe trigger customer.subscription.created`
   ——`subscription` 表应该多/改一行，且 `last_event_at` 跟着事件的 `created` 走。
   （`stripe listen` 会打印一个临时的 `whsec_…`，本地放进 `.dev.vars`。）
5. **额度用尽**：把 `plan.window5h_limit_micro` 临时改成 `1`，等 60 秒（DO 的档位缓存
   TTL）再打一次 chat —— 应得 **429 `quota_exhausted`**，body 里带 `window` 与 `resetAt`。
   验完记得改回去。
6. **冷启动重建**：`wrangler` 没有"删掉某个 DO 的 storage"这条命令，所以换一个新 uid
   重来一遍：给新 uid 插订阅行 + 手工往 `usage_event` 插几行（`charged_to='window'`、
   `created_at` 落在本周段内），第一次打 `/billing/v1/me` 时 `windows.h5.usedMicro`
   应该等于那几行的和 —— 那就是重建生效了（从零开始的话它会是 0）。

**这个脚本会真花钱**（第 3 步走真上游）。它不写任何配置、不留后门；随机 uid 那条路
一分钱不花，但已经验完「身份 → 选路 → hold」整条链。

## 已知取舍

- **`edge.ts` 与 `relay.ts` 不碰任何运行时**，纯 `Request` → `Response` / 纯函数。所以它们
  跟着根门禁跑，安全不变量的测试不需要起 workerd —— 那种测试必须便宜到每次提交都跑。
  运行时那一层只剩 `worker.ts`，薄到几乎没有分支。
- **`jwt.ts` 用 WebCrypto 而不是 `node:crypto`**：Worker 里要有 `node:crypto` 得开
  `nodejs_compat`，为一次 HMAC 拉进整个 Node 兼容层不划算。代价是验签变成异步的。
- **中继一个 storage API 都不调**。「不落盘」因此是字面意义的，不是靠纪律；顺带也没有
  SQLite 存储计费。
- **Quota DO 反过来**：它必须落盘（窗口用量要跨请求活着），但落的是**投影**——
  丢了能从 `usage_event` 重建，重建不出来的部分（未结算的 hold）本来就该过期释放。
  两个 DO 的取舍相反，是因为一个转的是密文、一个记的是钱。
