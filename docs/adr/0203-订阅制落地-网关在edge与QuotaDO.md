# ADR-0203：订阅制落地——网关在 edge Worker，`Quota` DO 做双固定窗 hold/settle

- 状态：已接受（stanyan 会话指示，issue #696）
- 日期：2026-09-02
- 相关：ADR-0174（订阅计量：credit / 双固定窗 / 不滚存）、ADR-0175（按模型比价）、
  ADR-0176（托管优先于 BYOK、key 不过桥）、ADR-0202（模型 key 跟着工作区走）、
  ADR-0019 决定四（裸 fetch 零 SDK 的既有风格）、ADR-0074（ADR 编号顺延规矩）；
  spec `docs/superpowers/specs/2026-09-02-subscription-billing-design.md`

本 ADR 记的是 0174–0176 定形之后、**落地这一片**（Tasks 1–13）遇到的实现级判断，
不重复三篇已写的内容。0174–0176 答的是"要不要做、按什么单位、谁优先"；这篇答的是
"扣在哪台机器上、数据结构长什么样、并发和乱序怎么防"。

## 背景

三篇设计 ADR 定了形：credit 是成本锚定的整数、额度是双固定窗不是余额、托管优先于
自带 key 且 key 不过桥。落地时要选：网关跑在哪（VPS 还是 edge）、窗口计数器用什么
数据结构、Stripe 走 SDK 还是裸 REST、runtime 怎么代表发起人调网关、旧的 token 钱包
认不认、档位改没改。

## 决定

### 1. 网关落 edge Worker，不落 VPS

`services/edge` 已经有 JWT 验签、Durable Object、service key、自有域名
（`edge.mrotto.agency`）；VPS 版是单区域，且要重抄一遍鉴权和限流。DO 单线程天然
无竞态，正是 hold/settle 要的东西——两个并发请求同时进一个用户的窗口，不需要额外
加锁。

**会被推翻的前提**：Workers 对上游一方站（DeepSeek/智谱等境内服务）的出网被墙，
或者 SSE 透传出现不可接受的延迟。

### 2. 固定窗用累计数，不用 ADR-0174 第 7 条写的环形桶

ADR-0174 第 3 条定的是固定窗语义（开窗、5h/周后整窗清零），第 7 条却写"用环形桶
实现"——环形桶是滑动窗口的数据结构，与固定窗语义对不上，落地时才发现这个矛盾。
固定窗只需要一个数（`usedMicro` + `openAt`），比一圈格子便宜得多，也不会在窗口
边界产生"半个桶"的模糊态。

**会被推翻的前提**：产品决定改成滑动窗（那时环形桶是正确的实现，这条决定作废）。

### 3. settle 先在 roll 之前查 hold，钱永远有地方落

`settle(state, requestId, costMicro, now, plan)` 自己做 roll，但**先**在当前窗口里
找这次请求的 hold、把它转成已结算的用量，**再**处理其余窗口过期该不该清零。反过来
（先 roll 再找 hold）会出现"hold 落在刚被清零的旧窗口里，settle 找不到它"的空洞——
钱凭空消失。TTL 只负责释放没人回来 settle 的并发坑（客户端断线、进程崩溃），不负责
正常路径的记账时序。

### 4. 加购余额按 `grants[]` 列表存，不是单标量

`credit_grant` 每笔各自 12 个月有效期（ADR-0174 决定五）。单个 `addonMicro` 标量
表示不了"这个月买的还剩多少、上个月买的还剩多少"——两笔到期时间不同，混成一个数
之后无法正确过期。改成 `grants: { micro: number; expiresAt: number }[]`，消耗按
**最早到期先扣**（先花快过期的），过期的整笔丢弃而不是整体清零。

### 5. rebuild 重放固定窗语义，不是简单求和

> 决定 19 收窄了这条：链回放只对 0018 之前没有锚的旧行还用；有锚的行按锚算。

DO 冷启动从 `usage_event` 重建时，必须按时间升序扫描，遇到 `e.at >= openAt + 5h`
就当场开一个新窗口（用量归零重新累加），扫到末尾再用 `now` 补一次"是否该关窗"的
判断。直接对全部历史事件求和会把好几个已经过期的窗口的用量错误地叠加在一起——
冷启动重建出来的账必须与从未睡过的热态给出同一个数字，这是 DO 作为"投影可从事实
重建"这条硬规则的直接体现。

### 6. addon 结算溢出记进窗口账，不 clamp 归零；hold/settle 入口做 sanitize

实际成本超过剩余 addon 余额时，先扣光 addon，**溢出部分记进窗口账**（若窗口当时
是关的就顺手开一个新窗口）——不能假装这笔钱没花。另外，hold/settle 的输入
（成本估算、`max_tokens`）一律在入口处把非有限数或负数清成 0，函数保持纯净，
不对上游传来的畸形值抛异常。

### 7. Stripe 裸 REST + 手写验签，不装 SDK

同 ADR-0019 决定四的理由：一个依赖换不来更少的代码，且与仓库既有风格一致
（模型 adapter 也是裸 fetch 零 SDK）。**订阅投影只认 `customer.subscription.*`
事件**（自带 `current_period_start/end`），`checkout.session.completed` 在订阅
模式下**不写库**——它只用来在手验时确认 Checkout 链路走通，真正的订阅状态由
Stripe 后续推来的 `subscription.*` 事件建立。

### 8. Stripe 事件乱序防护：`incomplete` 忽略 + `last_event_at` 比较

Stripe 不保证 webhook 到达顺序，且重投窗口长达 3 天。两手：
(a) 状态 `incomplete` 一律 ignore（还没真正付款，不写行——不存在的订阅行本来就
等价于"无订阅"）；`incomplete_expired` 仍按 canceled 处理。
(b) 每条订阅相关事件携带 `eventCreated`（来自 Stripe 的 `event.created`），
`subscription` 表新增 `last_event_at timestamptz`，写库前比较：`eventCreated`
早于已存的 `last_event_at` 就整条忽略。**加购单次上限 `MAX_GRANT_QUANTITY = 100`**，
防止一次异常调用把幂等环刷穿。

### 9. runtime 以平台身份代表发起人调网关

沿用既有的 `x-runtime-secret`（不是 Bearer，见"两处偏差"一节）+
**新增** `x-otto-on-behalf-of: <真用户 uid>` 表明"这次调用替谁花钱"。真人自己的
请求带 `x-otto-on-behalf-of` 一律 400（能代表别人的只有平台）。runtime 扣的是
**发起 turn 的那个人**，不是工作区 owner；runtime 自身仍不持有任何模型 key，
调用凭据只有 `RUNTIME_SECRET`——ADR-0202"runtime 不持有 key"的精神延续到订阅制。
`x-otto-workspace` / `x-otto-session` 两个可选头只进 `usage_event` 的行用于事后
对账，在身份出口截到 128 字节。

**会被推翻的前提**：产品决定群聊由 workspace owner 统一付费而不是各自的订阅
（那时 `on-behalf-of` 语义要从"谁发起"改成"owner 授权谁使用其额度"，是另一套
设计）。

### 10. 旧 token 钱包不认，新账本另起

`0002_token_wallets.sql` 那套旧账本留着不动（存量规模与"为什么不删"写在 ADR-0174，
数字不在这里抄第二遍——抄本会过期，指针不会），但订阅制的 `usage_event` /
`credit_grant` 是全新的表，不复用旧结构、不做迁移。维护者拍板：issue #520
（删 token 钱包三张表）继续作废。这里重申的只有一句："另起"不是"迁移"。

### 11. DO 重建失败一律 throw，不落空态；冷启动包进 `blockConcurrencyWhile`

`state()` 重建失败时**throw**，不回退成一份空投影——空投影落盘等价于"这个人从
没花过钱"，一次 Supabase 抖动就把窗口用量和加购余额一起归零，且从此不会再重建
（storage 里已经有一份"合法"的空 state 了）。DO 把这个异常译成 503
`quota_unavailable`；网关把 hold/routes 抛出的异常包成 503/502 的 upstream 信封。
冷启动重建整段包进 `ctx.blockConcurrencyWhile`——DO 单线程只保证一次 `fetch`
内没人插队，`await` 之间照样会切出去，两个并发的首请求各自重建会导致后写的
那份抹掉前一份的 hold。

### 12. 幂等三处：usage_event / credit_grant / addonGranted

`usage_event` 插入按 `request_id` 做 `on_conflict`；`credit_grant` 按
`stripe_payment_intent_id` 做 `on_conflict`（PostgREST 默认只认主键，两处都要
显式指到唯一列，不然重投的第二次 INSERT 会报唯一键冲突而不是安静地被忽略）。
`addonGranted` 在 DO 里另按 `paymentIntentId` 做一层幂等（200 条环形去重），
但**即使 DB 那行已存在也照样通知 DO**——"行插进去了、通知那步炸了"这个半截
状态只有靠 Stripe 的自然重投才能治好，提前在 DB 层返回会让它永远治不好。
Supabase 项目未开聚合函数（`sum()` 这类），所以重建一律"拉行 + 客户端重放"
（分页见决定 19）。

### 13. 网关流式 tap 用单发 finalizer + UTF-8 字节估算

拦截转发流的三个出口（正常 flush / 客户端取消 / `req.signal` abort）共用同一个
只会真正执行一次的 finalizer，中断路径**不落 TTL 等它自然过期**——中断的 hold
不该占坑到超时。

**中断该结算还是该释放，见下面的决定 17**：这条最初写的是"中断统一走 `release`"
（照 spec 第 2 节第 5 步），终审时被推翻。预估成本按 `TextEncoder` 的 UTF-8 字节数算，不按
JS 字符串的 UTF-16 code unit——中文流量下两者能差 3 倍，直接影响 hold 预扣得
准不准。`max_tokens` 只认有限正数并 floor，上限钳到 128_000，不合法就退回路由
默认值。hold 成功之后任何异常（读 `remaining` 失败、非流响应的 `res.text()`
失败）一律先 `release` 再回 502，不让一次预扣悬在那里没人收尾。`waitUntil`
是流式 settle（发生在响应已经吐给客户端之后）活下去的缝。

### 14. adapter 的 `reroute` 是单独一类，不退避、只重试一次

网关返回 `429 quota_exhausted` 时，桌面 adapter 把它识别为一类专门的
`reroute`——不同于普通的限流退避，而是"立刻重新走一次端点解析（`routeModel`）"，
因为这次失败的根因是路由选错了（该走 direct 却选了 hosted，或反之），重试同一
端点没有意义。改道之后落一条 `route_changed` 事件，既 append 进日志也
`push.event` 给渲染层——这条改道本身要在会话里看得见。

### 15. 档位改三档

Lite \$19 / Pro \$59 / Max \$89，取代 ADR-0174 写的四档
（Lite \$19 / Pro \$59 / Max5 \$149 / Max20 \$299）。折算规则（毛利率、
周额度 = 月预算 ÷ 4、5h = 20% 周额度）不变，变的是**顶档的价格**：维护者
砍掉了 Max20（\$299），并把 Max5 从 \$149 **降到 \$89** 改称 Max。
这不是一次改名——顶档便宜了 \$60，对应的月预算/周额度按同一套折算规则
重算过（见 `supabase/seed/0017_plans_routes.sql` 的 max 那一行）。

### 16. 客户端那一侧的三条裁定（Task 9 / Task 11）

- **快照刷新按序号丢弃过期响应**：主进程的额度快照 `refresh` 给每次请求编号，
  回来时号不是最新的就整份丢掉。并发的两次刷新完成顺序不保证，先发后到的那份
  会把新数据盖回旧的——而这个错误是静默的（界面上就是"额度数字偶尔跳回去"）。
  监听器也各自隔离，一个订阅方抛异常不该把其余的推送一起掐掉。
- **IPC `checkout` 自己校验参数形状**（`parseCheckoutTarget`）：渲染层传过来的
  东西不算可信输入，形状不对就地拒绝，不让它走到 edge 再被 400 —— 那一趟往返
  里已经开过一次 Stripe session 的风险不该由错误的形状承担。
- **按钮在飞行中禁用，倒计时走 `useNow`**：双击/手滑两下会开出两个 Stripe
  Checkout session（真实的双重扣款入口）；倒计时用裸 `Date.now()` 只在挂载
  那一刻取一次，数字会钉死不动，与 Timeline 共用同一颗表才会真的走。

### 17. 中断的流按预扣结算，不 release（推翻 spec 第 2 节第 5 步）

终审推翻了决定 13 最初那条"中断统一 release"。判据是**有没有字节转发出去**：
只要有一个字节到过客户端，上游就已经在收我们的钱了——内容送出去了，成本已经
发生。`release` 等于把这笔成本送掉，而"收到内容之后断线"是客户端随时能做的
动作，那就是一个可以无限重复的白嫖洞。所以中断（上游中途出错 / 下游 cancel /
`req.signal` abort）一律按**预扣的估算**结算，这是一个保守的上限（估算按
body 字节 ÷ 3 + `max_tokens` 顶格算，通常高于真实用量）；同一条规则也管
"正常结束但流里没有 usage 帧"。`release` 只剩真的没花钱那几条：上游非 2xx /
连不上、**一个字节都没转发就断**、hold 之后花钱之前自己炸了。

机制上这条要求 `tapSseUsage` 的 finalizer 报**事实**而不是结论：`onDone(u, { bytes })`
——"没有 usage"这一个信号分不出"中断了但内容已经出门"和"一个字节都没出门"，
而这两件事该做的动作相反。结算用的那份假 usage 与 hold 的估算**同源**
（`estimateUsage`），所以结的正好是预扣的那一笔，窗口账上不多不少。

**会被推翻的前提**：真实用量数据显示按估算结算系统性地高于真实成本太多
（比如客户端普遍在开头几个 token 就断），那时该改成"按已转发字节反推一个
更紧的上限"，而不是退回 release。

### 18. 换档只走 Customer Portal；Stripe 两代事件形状都收

- **`/billing/v1/checkout` 对已有订阅的人回 409 `already_subscribed`**，升档按钮
  改调 `/portal`。Stripe 的 Checkout 在 subscription 模式下**新建一条订阅**——
  对着已有订阅的人再开一张，结果是两条订阅同时扣款。换档的正路是 Customer
  Portal（同一条订阅上换 price，按比例结算）。`canceled` 放行（退订过又想回来
  本来就该重开），加购不受管（一次性购买，跟订阅条数无关）。
  为什么是 409 不是 502：502 会被客户端当成"上游抖了，稍后再试"然后重试，
  而重试正好把第二笔开出来。部署侧因此多一步——Portal 里要开启 subscription
  update 并把三个 price 加进可切换列表（见 `services/edge/README.md` 第 ⑤ 步）。
- **Stripe API ≥ 2025-04-30 的字段搬家两处都兼容**：订阅的 `current_period_*`
  搬到了订阅**条目**上，invoice 的 `subscription` 搬进了
  `parent.subscription_details.subscription`。webhook 的 API 版本跟着 Stripe
  账号走、不跟着这份代码走，所以只认一种形状的后果是升级那天所有订阅事件
  一起 `ignore` —— 静默失效，账面上看起来像"所有人的订阅同时消失"。
- **`x-otto-on-behalf-of` 必须是 uuid**：它不经过任何签名却直接变成被扣钱的
  `uid`（Quota DO 按 uid 分实例）。不校验形状的话，一个笔误就凭空开出一个
  谁都不是的额度户头，而它在账上跟一个真人长得一模一样。校验放在身份验完
  **之后**：烂 secret 仍然先 401，不因为头形状不对而漏出"这里有个平台通道"。

### 19. 冷启动重建：5h 窗按锚、加购逐笔重放、三段分页、live grant 并进 grantSeen（#863 / #858 / #862）

终审留下的三条重建偏差一起修，因为它们共用同一段代码，而且互相牵着：

**5h 窗按 `usage_event.window_open_at` 那个锚算，不按事件链猜**（0018 加的列，#863）。
决定 5 那套"从周段起点按事件链回放固定窗"只在链头恰好是一扇新窗时才对——5h 窗是
跨周连续的（`roll` 只清周用量、不关 5h 窗），链在周段边界、在任何一次拉取起点都
可能被截成半扇，重建出来的窗比线上那扇晚开、少算。不去追"往前找到一个 ≥5h 的空
档"（那是无界回溯），而是 settle 那一刻把 DO 里的 `open5hAt` 当成事实的一部分写进
`usage_event`：window 事件总带，addon 事件只在溢出到窗口时带（`settle` 新回
`windowMicro`，DO 据此决定带不带）。重建取最后一条带锚事件的锚：`now < 锚 + 5h`
就把同锚的成本相加，否则窗已关。旧行（锚为 null）退回链回放。拉取起点也跟着改：
window 事件从 `min(周段起点, now − 5h)` 起（`rebuildWindowSince`），跨周边界那扇窗
的事件才拉得到。这不违反"usage_event 是唯一事实、DO 是投影"：锚记的是"这笔钱落进了
哪扇窗"，是 settle 那一刻发生过的事实，不是投影。

**加购逐笔重放，不再拿全时段总消耗扣活着的 grant**（#863）。以前 `addonConsumed` 是
所有 addon 事件之和，从此刻未过期的 grant 里扣——一笔 grant 过期之后，它生前的消费
会被算到还活着的那笔头上。现在拉这个人**全部** grant（含过期）、按时间把 addon 事件
从"那一刻已进账且未过期"的 grant 里先到期先扣（与 `settle` 的 `deductAddon` 同一
规则），过期的那几笔吸收自己那份历史消费；扣不完的差额是当时溢出到窗口的那份
（决定 6），有锚按锚进 5h 窗、周段内进周用量。addon 事件只从最早那笔**活着**的
grant 的进账时刻起拉（`addonSinceOf`）：更早的消费只可能扣在此刻已过期的 grant 上，
消费从不预支到还没买的额度。没有活着的 grant 就一行都不拉——多数用户走这条。

**三段查询分页翻到底，翻到上限抛错**（#858）。以前三条各钉一个 limit，PostgREST
截断和"本来就这么多"长得一模一样，后果是重建出来的账少扣或多算余额，没有报错。
`pageAll` 按 `limit/offset` 翻（`order=created_at.asc,id.asc` 给分页一个稳定全序，
同一毫秒两行光靠 created_at 会在页边界上重复或漏掉），不足一页即最后一页；超过
100 页 × 1000 行**抛**——那一刻算不出额度就 503（决定 11），不报一个错的数。真到
那个量级该换物化余额列，不是把上限再调大。

**重建把此刻活着的 grant 的 `stripe_payment_intent_id` 并进 DO 的 `grantSeen`**（#862）。
竞态是"webhook 插行 → 冷 DO 重建把这行算进来 → webhook 通知 `addonGranted`"：通知
到达时 storage 已有 state，不并进来就会 append 第二份。`blockConcurrencyWhile`
保证通知要么排在重建前（冷：只留记号，重建从表里算进来，记号保留）、要么排在重建
后（记号已在 → dup），没有第三种交错。只并活着的：过期 grant 的重投 append 一笔
过期额度，下一次 roll 就丢，无害。

## 与 spec 的偏差（明确记录，不是遗漏）

- **平台身份头**：spec 写的是"平台用 Bearer 携带一个服务 token"，实现沿用了
  仓库里 cs 协议已有的 `x-runtime-secret` 机制（同一把密钥、同一套校验代码），
  没有另开一条 Bearer 路径——两者安全强度等价，复用减少一套鉴权实现。
- **档位价格在客户端另有一份**：`PLAN_CARDS`（渲染层）写死了三档的价格与文案，
  而**DB 的 `plan.price_usd_cents` 才是事实**。本片故意如此：`/billing/v1/me`
  没有下发价格，而三张价目卡要在拿到 `/me` 之前就画出来。风险有限——真正收钱的
  是 Stripe Checkout，它显示的是 price 对象上的真实价格，所以客户端那份写错只会
  让卡片上的数字和结账页对不上，不会收错钱。修法是 `/me` 把价格带下来，卡片改成
  渲染服务端给的数。
- **spec 第 4.3 节的"toast"落成了时间线标记**：改道提示没有做成一闪而过的 toast，
  而是时间线上的一条 `route_changed` 事件 + 那一行的标记。理由是改道是**会话里
  发生过的一件事**（钱从谁账上出变了），toast 关掉就没了，重放时也回不来；
  硬规则要求投影可从日志推导，事件才满足这一条。
- **本次花费不回显**：spec 设想响应带一个头告诉客户端"这次调用花了多少 credit"，
  实现里这个头（`x-otto-cost-micro`）还没加，桌面端目前看不到单次调用的即时花费，
  只能看累计的窗口用量。留到下一片。

## 后果

- 网关是无状态的（每个请求独立进 Worker），状态全在 `Quota` DO 与 Supabase 里，
  边缘可以随意扩缩容不需要考虑亲和性。
- `usage_event` 是唯一事实源，`Quota` DO 是投影：这与本仓库"append-only 日志是
  唯一事实来源"的硬规则同构，只是这次的日志落在 Supabase 而不是本地 SQLite。
- 引入了第三条"key 的持有者是谁"的路径（自带 key / 过渡期维护者 key / 现在的
  订阅+官方 key），三者在 `routeModel` 里线性判断，代价是这个函数的分支数又多了
  一层，`modelRoute.ts` 的头注已经把"历史三条路"写清楚。

## 已知未做（下一片）

- `x-otto-cost-micro` 头未加，客户端本次调用的即时花费不显示（见"两处偏差"）。
- rebuild 的重放**不含未结算的 hold**（storage 丢了 hold 就丢了，它们本来就会过期
  释放）；决定 19 修掉的是三条已知偏差（过期 grant 二次计入 / 5h 窗跨周截断 /
  分页截断），修法与代价写在那一节。
- webhook 正文的 1 MB 上限**应用层是声明了的**：`edge.ts` 在读 body 之前先看
  `content-length`，超了直接 413（这条路没有 JWT 挡在前面，正文大小是唯一的门槛，
  所以不能先把整份未鉴权的 body 吃进内存）。未做的是**省略 `content-length` 头
  就绕过**那一条——那时只剩平台（Cloudflare）自身的请求体上限兜底。要堵得读着
  流数一遍字节，本片没做。
- `timingSafeEqual` 在 `edge.ts` 与 `billing.ts` 里各实现了一份，未抽公共函数。
- `services/edge/src` 目前没有"这个目录不许 import `node:*`"的机械断言
  （对照 `services/edge/README.md` 已知取舍一节里"纯函数、不碰运行时"这条，
  目前只靠代码审查维持，没有测试守着）。
- `services/edge/README.md` 里存量的三个生产地址写法不一致（历史遗留，不在
  本片范围内统一）。
- 粘性/比价/failover（ADR-0175 第 3 节所写的完整路由策略）、多模态门禁：均未
  在本片实现，`modelRoute.ts` 目前只做"能不能调"的二元判断。

## 会被推翻的前提

- 决定 1（edge Worker）：见上，Workers 出网受限或 SSE 延迟不可接受。
- 决定 2（累计数不用环形桶）：产品改滑动窗。
- 决定 9（runtime 代表发起人）：产品改成 workspace owner 统一付费。
- 决定 17（中断按估算结算）：见上，真实用量显示这个上限系统性地高得离谱。
- 决定 19（重建分页上限 10 万行抛错）：出现单用户一周 window 事件或一年 addon
  事件真超过 10 万行的用量形态——那时该上物化余额列，不是调上限。
- 决定 15（三档）：维护者重新拍板档位数量或价格——ADR-0174 自己也写了
  "「一个 turn ≈ 30K token」是拍的，档位数字应在跑一次真实用量聚合之后重定"，
  这条前提对三档同样成立，不因为改了档数而失效。
