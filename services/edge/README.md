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
| POST | `/llm/v1/chat/completions` | 托管模型网关（OpenAI 兼容，流式/非流式都收）。`200` 正常（响应头带剩余额度），`400` `bad_request`/`unknown_model`，`401` 凭据问题，`402` `no_subscription`，`429` `quota_exhausted`（带 `window`/`resetAt`）或 `too_many_inflight`，`502` `upstream`（上游出错），`503` `upstream`（额度算不出来，稍后再试） |
| GET | `/billing/v1/me` | 这个人的档位 / 两个窗口 / 加购余额 / 网关此刻供的型号（`BillingMe`）。`200`，`502` `upstream`（Quota DO / Supabase 挂了） |
| POST | `/billing/v1/checkout` | 开一张 Stripe Checkout：`{planId}` 订阅或 `{addon:true,quantity}` 加购。`200 {url}`，`400` 形状不对，`403` `forbidden`（平台身份不能买），`409` `already_subscribed`（已有非 canceled 的订阅还想再订 —— 换档走 `/portal`），`502` Stripe 那边出错 |
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

生产地址是 `https://edge.mrotto.agency`（自有域名，客户端编译期常量就指它）；
同一个 worker 还有第二个门牌 `https://edge.mrotto.workers.dev`（存量旧客户端连的是它），
两个名字背后是**同一份部署**（wrangler.jsonc 的 routes + workers_dev），不是两套服务。

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
  **必须**带 `x-otto-on-behalf-of: <真用户 uid>`（它没有自己的 `sub`，替谁花钱要说清楚）。
  这个头的值不经过任何签名却直接变成被扣钱的 uid，所以形状自己把一次关：**必须是
  uuid**，不是就 400（否则一个笔误能凭空开出一个谁都不是的额度户头，而它在账上跟
  一个真人长得一模一样）

另两个可选头 `x-otto-workspace` / `x-otto-session` 只进 `usage_event` 的行，
在身份出口截到 128 字节。

**hold / settle**（为什么不是"用完再算"）：并发请求能在"算账"之前一起冲进窗口。
所以一次调用是「按请求体字节 + `max_tokens` **高估**一笔 → 预扣（hold）→ 转发 →
从响应/SSE 流里挑 `usage` → 按实际成本结算（settle），退掉估算与实际的差」。
流式响应的 settle 发生在**响应已经发出之后**，靠 `ctx.waitUntil` 活着。

**中断 ≠ 没花钱**：流中途出错 / 客户端断线，只要**已经有字节转发出去**，就按预扣的
估算 settle，不 release —— 内容已经送出去、上游已经收了我们的钱，release 等于把这笔
成本送掉，而「收到内容之后断线」是客户端随时能做的事。`release`（不记账）只剩三条
真的没花钱的路：上游非 2xx / 连不上、一个字节都没转发就断、hold 之后花钱之前自己炸了。
非流式 200 但正文里挑不出 usage 也按预扣结算（#855）——200 就是收了钱，规则与流式同一条。

**Quota DO 存的是投影，不是事实**：钱的唯一事实是 Supabase 的 `usage_event` 表
（append-only，见 `0017_subscriptions.sql`）。DO 冷启动没有 state 时**从事实重建**
——不重建的话，DO 睡一觉醒来额度就全满了。重建包在 `blockConcurrencyWhile` 里：
DO 单线程只保证"一次 fetch 内没人插队"，`await` 之间照样会切出去，两个并发的首请求
会各自重建、后写的那份抹掉前一个的 hold。

重建的三段（grant / window 事件 / addon 事件）都**分页翻到底**（#858），翻到上限抛错而不是
静默截断；5h 窗按 `usage_event.window_open_at` 那个锚算、不按事件链猜，加购按 grant 逐笔重放、
过期的那几笔吸收自己的历史消费（#863，ADR-0203 决定 19）。

**重建失败既不落盘也不当成零**：这一刻回 `503`（网关译成 `503 upstream`
「额度服务暂时不可用」）。返回一份空投影再落盘的话，一次 Supabase 抖动就等于
"这个人没花过钱"——窗口用量归零、买过的加购余额消失，而且从此不会再重建
（storage 里已经有 state 了）。"少扣对用户有利"只适用于一笔账没落，不适用于整份余额归零。

`usage_event` 落库失败**不回滚投影**：少扣对用户有利，回滚才会把"已经给出去的内容"
变成既没扣钱也没记录。

**加购的幂等在两层**：DB 那层键是 `stripe_payment_intent_id`（unique；`ignore-duplicates`
要显式带 `on_conflict=` 指到这一列——PostgREST 默认只认主键，而主键是 identity）；
DO 那层按同一个 `paymentIntentId` 记一个 200 条的环。所以 webhook 撞见重复行**照样通知
DO**：这样"行插进去了、通知那步炸了"才有救——Stripe 的重投会把它治好。反过来（撞重复
就提前返回）那个半截状态永远治不好。

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

五步，顺序不能换（表要先在，DO 才有东西可读；secret 要先在，webhook 才验得动）：

```bash
# ① DB：在 Supabase SQL editor 依次跑（两个都重复执行安全，顺序不能换）
#    ①a  supabase/migrations/0017_subscriptions.sql   建表
#    ①b  supabase/seed/0017_plans_routes.sql          灌档位 + 首批模型路由
#    ①c  在 plan 表手填 stripe_price_id —— 四行都要填：lite / pro / max / addon
#        （seed 故意不刷这一列，重跑 seed 不会把你填的 price 清回空串）
#    ①d  supabase/migrations/0018_usage_event_window_anchor.sql   usage_event 加 window_open_at
#        （#863；不跑的症状：settle 落库 400「column window_open_at does not exist」，
#        投影已扣、事实没落——冷启动重建会少算这些笔）
#    验：supabase/checks/0017_*.check.sql 与 0018_*.check.sql 每行 PASS
#
#    没跑 ①b 的症状：每次 chat 400 unknown_model，/billing/v1/me 的 models 为空，
#    webhook 全部回 ignore（price 对不上任何档位）。三样都不报错，只是什么都不工作。
#    没填 ①c 的症状：checkout 回「<档位> 这个档位还没配 Stripe price」。

# ② secret：上面那四个 + 已有的两个，一个都不写进 wrangler.jsonc
npx wrangler secret put STRIPE_SECRET_KEY   # …等四条

# ③ 部署（migration v3 会新建 Quota 这个 DO class）
npm --prefix services/edge run deploy

# ④ Stripe Dashboard → Developers → Webhooks 加一个端点：
#    https://edge.mrotto.agency/billing/v1/webhook
#    事件选：customer.subscription.created / .updated / .deleted /
#            invoice.payment_failed / checkout.session.completed
#
# ⑤ Stripe Dashboard → Settings → Billing → Customer portal：
#    打开 subscription update（允许在 lite / pro / max 三档之间切换），
#    并把这三个 Price 加进可切换列表。
#    换档只走 Portal —— `/billing/v1/checkout` 对已有订阅的人回 409
#    `already_subscribed`（再开一张 Checkout 会长出第二条订阅、两笔一起扣款）。
#    这一步不做的话，升档按钮打开的 Portal 里没有「换套餐」，用户只能退订再订。
```

**手验九条**（前两条不花钱，第三条起会真扣额度）：

1. **没订阅的人**：`npm --prefix services/edge run check:llm`（默认签一个随机 uuid）。
   `/billing/v1/me` 应回 `status: "none"` 且 `models` 非空（`models` 空 = `model_route`
   没 seed 过），一次 chat 应得 **402 `no_subscription`** 且带剩余额度头。
2. **手工造一行订阅**：在 `subscription` 表插一行（`user_id` 用你的测试账号、
   `plan_id='lite'`、`status='active'`、`current_period_start/end` 覆盖此刻），
   再打 `/billing/v1/me` —— `windows` 应该从 `null` 变成两个窗口，`periodEnd` 有值。
   **档位快照在 DO 里有 60 秒内存缓存**：刚在 DB 里改完立刻打，看到的可能还是上一份。
   等一分钟再打一次，或者换一个没被叫醒过的 uid（缓存是每实例的，DO 睡醒即失）。
3. **真扣一笔**：`OTTO_CHECK_UID=<那个 uid> SUPABASE_JWT_SECRET='…' npm --prefix services/edge run check:llm`。
   脚本自己会等一拍再打一次 `/me` 断言 `windows.h5.usedMicro > 0`；同时去
   `usage_event` 表看应该多一行（`request_id` 唯一），响应头里的剩余额度比第 2 步小。
4. **webhook 通路**（分两半，别把第一半的结果当失败）：

   ```bash
   npm --prefix services/edge run dev   # 一个终端
   stripe listen --forward-to http://127.0.0.1:8799/billing/v1/webhook   # 另一个
   #   ↑ 它会打印一个临时的 whsec_…，放进 .dev.vars 的 STRIPE_WEBHOOK_SECRET
   stripe trigger customer.subscription.created
   ```

   - **第一半（验签 + 事件解析）**：`stripe trigger` 用的是官方 fixture，那份订阅
     **没有 `metadata.uid`**——我们无从知道这是谁的订阅，所以 `actionFromEvent` 回
     `ignore`，响应是 `200 {"ok":true,"kind":"ignore"}`。**这就是这一步的预期结果**：
     它证明了签名验过了、JSON 解析了、路由通了。看到 `kind:"ignore"` 不要当成坏了。
   - **第二半（写库）**：要走到写库那条路，fixture 里得有 `metadata.uid`。
     `stripe trigger --help` 里有 `--add`（往 fixture 加参数）和 `--override`（改已有的），
     `metadata.uid` 是新加的，所以用 `--add`，形如
     `stripe trigger customer.subscription.created --add subscription:metadata.uid=<你的 uid>`。
     **fixture 里那个实体叫什么名字没有在本机验证过**（要跑它就得对着真 Stripe 建对象），
     `stripe trigger customer.subscription.created --edit` 能把 fixture 打开来确认。
     嫌麻烦就**在 test mode 下真跑一次 Checkout**（走 `/billing/v1/checkout` 拿到 url、
     用 Stripe 的测试卡付掉）——那条路的 `metadata.uid` 是我们自己在 `checkoutParams`
     里塞的，一定在。
   - 无论走哪条，写库成功的判据是：`subscription` 表多/改了一行，且 `last_event_at`
     等于那条事件的 `created`（不是 `now()`）——那一列就是乱序防护比的东西。
   - **新旧两种 Stripe 形状都收**（C3）：`current_period_start/end` 在订阅对象顶层
     （旧）或订阅**条目**上（API ≥ 2025-04-30）都认；`invoice.payment_failed` 的
     订阅 id 在 `subscription`（旧）或 `parent.subscription_details.subscription`
     （新）都认。webhook 的 API 版本跟着 Stripe 账号走、不跟着这份代码走，所以
     这里看到的是哪一种取决于你的账号——两种都该写进库，写不进就是这条坏了。
5. **额度用尽**：把 `plan.window5h_limit_micro` 临时改成 `1`，等 60 秒（DO 的档位缓存
   TTL）再打一次 chat —— 应得 **429 `quota_exhausted`**，body 里带 `window` 与 `resetAt`。
   验完记得改回去。
6. **冷启动重建**：`wrangler` 没有"删掉某个 DO 的 storage"这条命令，所以换一个新 uid
   重来一遍：给新 uid 插订阅行 + 手工往 `usage_event` 插几行（`charged_to='window'`、
   `created_at` 落在本周段内），第一次打 `/billing/v1/me` 时 `windows.h5.usedMicro`
   应该等于那几行的和 —— 那就是重建生效了（从零开始的话它会是 0）。

7. **中断的流照样记账**（C1，也是 `transformer.cancel` 在 workerd 上真会触发的唯一
   证据）：起一次流式 `check:llm`，在它还在吐字的时候 Ctrl-C（或用一个 `AbortController`
   在收到第一个 chunk 之后 abort）。等一拍再打 `/billing/v1/me` —— `windows.h5.usedMicro`
   应该**变大**（按预扣估算结算了），不是回到中断前的数（那是 release，就是被修掉的洞）。
   `usage_event` 表里应该多一行，`cost_micro` 等于那次 hold 的估算值。
8. **webhook 重投只加一笔额度**：拿一条真实的 `checkout.session.completed`（payment
   模式，加购那条）跑 `stripe events resend <evt_id>` 重发一次。判据两个：
   `credit_grant` 表里那个 `stripe_payment_intent_id` **只有一行**，且第二次响应
   不是 500（那证明 PostgREST 的 `on_conflict` 真的指到了那个非主键的唯一列——
   不指的话第二次 INSERT 会撞唯一键报错，Stripe 会一直重投）。
   DO 那层的去重看 `/me` 的 `addon.remainingMicro` 没有翻倍。
9. **两个并发首请求各拿到一份 hold**（`blockConcurrencyWhile` 的证据）：换一个全新的
   uid（插好订阅行），**同时**打两次 `check:llm`（两个终端一起回车，或 `&` 后台起两条）。
   判据：两条都得到 200（不是一条 200 一条 402/429），`usage_event` 里两条各一行、
   `request_id` 不同，且 `/me` 的 `usedMicro` 等于两笔之和。冷启动重建若没被
   `blockConcurrencyWhile` 串起来，后写的那份会抹掉前一个的 hold —— 症状是这个和
   只有一笔。

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
